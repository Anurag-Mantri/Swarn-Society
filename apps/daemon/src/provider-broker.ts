import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Task } from "@swarmroom/protocol";
import { BudgetExceededError, LocalBudgetLedger, type ProviderBudgetSession } from "./budget-ledger.js";
import { HostTokenCaps, type HostTokenReservation } from "./budgets/host-token-caps.js";
import { isCappedProviderInput } from "./budgets/capped-provider-input.js";
import type { AgentSecretKeychain } from "./keychain.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS_PER_TASK = 20;
const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_OUTPUT_TOKENS = 2_048;
const PROVIDER_FRAMING_RESERVE_TOKENS = 256;
const REQUEST_TIMEOUT_MS = 45_000;

const brokerRequestSchema = z.object({
  body: z.record(z.string(), z.unknown()),
}).strict();

interface ProviderRoute {
  credentialName: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
  endpoint: URL;
  authHeader: "authorization" | "x-api-key";
  authPrefix: string;
  fixedHeaders: Record<string, string>;
  tokenField: "max_output_tokens" | "max_completion_tokens" | "max_tokens";
}

const providerRoutes: Record<string, ProviderRoute> = {
  "/openai/responses": {
    credentialName: "OPENAI_API_KEY",
    endpoint: new URL("https://api.openai.com/v1/responses"),
    authHeader: "authorization",
    authPrefix: "Bearer ",
    fixedHeaders: {},
    tokenField: "max_output_tokens",
  },
  "/openai/chat/completions": {
    credentialName: "OPENAI_API_KEY",
    endpoint: new URL("https://api.openai.com/v1/chat/completions"),
    authHeader: "authorization",
    authPrefix: "Bearer ",
    fixedHeaders: {},
    tokenField: "max_completion_tokens",
  },
  "/anthropic/messages": {
    credentialName: "ANTHROPIC_API_KEY",
    endpoint: new URL("https://api.anthropic.com/v1/messages"),
    authHeader: "x-api-key",
    authPrefix: "",
    fixedHeaders: { "anthropic-version": "2023-06-01" },
    tokenField: "max_tokens",
  },
};

export interface ProviderBrokerLease {
  socketPath: string;
  budgetExceeded(): boolean;
  usage(): ProviderTokenUsage;
  close(): Promise<void>;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderEgressBroker {
  openForTask(task: Task): Promise<ProviderBrokerLease>;
}

type FetchFunction = typeof globalThis.fetch;

class BrokerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      request.resume();
      throw new BrokerError(413, "Request body exceeds the provider broker limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const bytes = Buffer.from(result.value);
      size += bytes.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BrokerError(502, "Provider response exceeds the broker limit.");
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function prepareProviderBody(route: ProviderRoute, value: Record<string, unknown>): string {
  if (value.stream === true) throw new BrokerError(400, "Streaming provider requests are not supported by this broker.");
  const body: Record<string, unknown> = { ...value, stream: false };
  const requestedTokens = body[route.tokenField];
  if (requestedTokens !== undefined &&
      (typeof requestedTokens !== "number" || !Number.isInteger(requestedTokens) || requestedTokens < 1)) {
    throw new BrokerError(400, "Provider output token limit must be a positive integer.");
  }
  body[route.tokenField] = Math.min(
    typeof requestedTokens === "number" ? requestedTokens : DEFAULT_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
  );
  return JSON.stringify(body);
}

function providerUsage(route: string, body: Buffer): ProviderTokenUsage | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof decoded !== "object" || decoded === null || !("usage" in decoded) ||
      typeof decoded.usage !== "object" || decoded.usage === null) return undefined;
  const usage = decoded.usage as Record<string, unknown>;
  const inputField = route === "/openai/chat/completions" ? "prompt_tokens" : "input_tokens";
  const outputField = route === "/openai/chat/completions" ? "completion_tokens" : "output_tokens";
  if (!(inputField in usage) || !(outputField in usage)) return undefined;
  const input = usage[inputField];
  const output = usage[outputField];
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 ||
      typeof output !== "number" || !Number.isSafeInteger(output) || output < 0) return undefined;
  if (!Number.isSafeInteger(input + output)) return undefined;
  return { inputTokens: input, outputTokens: output };
}

export class LocalProviderEgressBroker implements ProviderEgressBroker {
  constructor(
    private readonly secrets: AgentSecretKeychain,
    private readonly fetcher: FetchFunction = globalThis.fetch,
    private readonly budgets = new LocalBudgetLedger(new Map()),
    private readonly hostCaps = new HostTokenCaps(new Map()),
  ) {}

  async openForTask(task: Task): Promise<ProviderBrokerLease> {
    const budget = this.budgets.forTask(task);
    const reserveHostTokens = this.hostCaps.forTask(task.agent);
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-egress-"));
    const socketPath = join(directory, "provider.sock");
    let requestCount = 0;
    let busy = false;
    let budgetExceeded = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const server = createServer((request, response) => {
      void this.handleRequest(task.agent, budget, reserveHostTokens, request, response, () => { budgetExceeded = true; }, (usage) => {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      }, () => {
        requestCount += 1;
        return requestCount;
      }, () => {
        if (busy) return false;
        busy = true;
        return true;
      }, () => { busy = false; });
    });
    server.maxHeadersCount = 32;
    server.maxRequestsPerSocket = MAX_REQUESTS_PER_TASK;
    server.on("error", () => undefined);

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      await chmod(socketPath, 0o600);
    } catch {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
      throw new Error("Could not create the local provider broker socket.");
    }

    return {
      socketPath,
      budgetExceeded: () => budgetExceeded,
      usage: () => ({ inputTokens, outputTokens }),
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }).finally(async () => {
          await unlink(socketPath).catch(() => undefined);
          await rmdir(directory).catch(() => undefined);
        });
      },
    };
  }

  private async handleRequest(
    agent: string,
    budget: ProviderBudgetSession,
    reserveHostTokens: HostTokenReservation | undefined,
    request: IncomingMessage,
    response: ServerResponse,
    markBudgetExceeded: () => void,
    recordUsage: (usage: ProviderTokenUsage) => void,
    countRequest: () => number,
    beginRequest: () => boolean,
    endRequest: () => void,
  ): Promise<void> {
    if (request.method !== "POST" || !request.url || !Object.hasOwn(providerRoutes, request.url)) {
      sendJson(response, 404, { error: "Provider route is not allowed." });
      return;
    }
    if (countRequest() > MAX_REQUESTS_PER_TASK) {
      sendJson(response, 429, { error: "Provider request limit reached for this task." });
      return;
    }
    if (!beginRequest()) {
      sendJson(response, 429, { error: "A provider request is already in progress for this task." });
      return;
    }

    try {
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        throw new BrokerError(415, "Provider requests must use application/json.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse((await readRequestBody(request)).toString("utf8")) as unknown;
      } catch (error) {
        if (error instanceof BrokerError) throw error;
        throw new BrokerError(400, "Provider request body must be valid JSON.");
      }
      const parsed = brokerRequestSchema.safeParse(decoded);
      if (!parsed.success) throw new BrokerError(400, "Provider request body is invalid.");
      const route = providerRoutes[request.url];
      if (!route) throw new BrokerError(404, "Provider route is not allowed.");
      const key = this.secrets.load(agent, route.credentialName);
      if (!key) throw new BrokerError(503, "No provider credential is stored for this agent.");
      const body = prepareProviderBody(route, parsed.data.body);
      const prepared = JSON.parse(body) as Record<string, unknown>;
      if (reserveHostTokens && !isCappedProviderInput(request.url, prepared)) {
        throw new BrokerError(400, "Use a text-only request with no additional provider features when host caps are configured.");
      }
      const outputCap = prepared[route.tokenField];
      if (typeof outputCap !== "number") throw new BrokerError(400, "Provider output token limit is invalid.");
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json",
        ...route.fixedHeaders,
        [route.authHeader]: `${route.authPrefix}${key}`,
      });
      const reservation = Buffer.byteLength(body) + outputCap + PROVIDER_FRAMING_RESERVE_TOKENS;
      const result = await budget.runRequest(reservation, async () => {
        await reserveHostTokens?.(reservation);
        const upstream = await this.fetcher(route.endpoint, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw new BrokerError(502, "Provider request failed.");
        }
        const output = await readResponseBody(upstream);
        const usage = providerUsage(request.url ?? "", output);
        if (usage) recordUsage(usage);
        return {
          value: { status: upstream.status, output },
          actualTokens: usage ? usage.inputTokens + usage.outputTokens : undefined,
        };
      });
      response.writeHead(result.status, { "content-type": "application/json", connection: "close" });
      response.end(result.output);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        markBudgetExceeded();
        sendJson(response, 429, { error: error.message });
      } else if (error instanceof BrokerError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        sendJson(response, 502, { error: "Provider request failed." });
      }
    } finally {
      endRequest();
    }
  }
}
