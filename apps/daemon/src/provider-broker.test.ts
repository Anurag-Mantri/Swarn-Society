import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AgentSecretKeychain, type PasswordEntry } from "./keychain.js";
import { LocalBudgetLedger } from "./budget-ledger.js";
import type { Task } from "@swarmroom/protocol";
import { requestProvider } from "./provider-broker-client.js";
import { LocalProviderEgressBroker, type ProviderBrokerLease } from "./provider-broker.js";

class MemoryEntry implements PasswordEntry {
  constructor(private value: string | null = null) {}
  getPassword(): string | null { return this.value; }
  setPassword(password: string): void { this.value = password; }
  deletePassword(): boolean { this.value = null; return true; }
}

function secretStore(value: string | null): AgentSecretKeychain {
  const entries = new Map<string, MemoryEntry>();
  const store = new AgentSecretKeychain("control.example", (account) => {
    const entry = entries.get(account) ?? new MemoryEntry(value);
    entries.set(account, entry);
    return entry;
  });
  if (value) {
    store.store("scout", "OPENAI_API_KEY", value);
    store.store("scout", "ANTHROPIC_API_KEY", value);
  }
  return store;
}

const testTask: Task = { t: "task", channelId: "general", from: "user-1", agent: "scout", text: "hello" };

function requestBroker(
  lease: ProviderBrokerLease,
  path: string,
  body: unknown,
  method = "POST",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: lease.socketPath,
      path,
      method,
      headers: { "content-type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

describe("local provider egress broker", () => {
  it("supports the constrained Node client used by agent images", async () => {
    const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ id: "chat-1" }), { status: 200 }));
    const lease = await new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher)
      .openForTask(testTask);
    try {
      const result = await requestProvider<{ id: string }>(
        "/openai/chat/completions",
        { model: "test-model", messages: [{ role: "user", content: "hello" }] },
        lease.socketPath,
      );
      expect(result).toEqual({ id: "chat-1" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await lease.close();
    }
  });

  it("routes only the fixed OpenAI endpoint and injects the key on the host", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: input as URL, init: init ?? {} });
      return new Response(JSON.stringify({ id: "response-1" }), { status: 200 });
    });
    const lease = await new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher)
      .openForTask(testTask);
    try {
      if (process.platform !== "win32") expect((await stat(lease.socketPath)).mode & 0o777).toBe(0o600);
      const result = await requestBroker(lease, "/openai/responses", {
        body: { model: "test-model", input: "private prompt", max_output_tokens: 99_999 },
      });
      expect(result).toMatchObject({ status: 200, body: JSON.stringify({ id: "response-1" }) });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url.toString()).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer host-only-api-key");
      expect(calls[0]?.init.redirect).toBe("error");
      expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
        model: "test-model", max_output_tokens: 4_096, stream: false,
      });
      expect(calls[0]?.url.toString()).not.toContain("evil");
      expect(result.body).not.toContain("host-only-api-key");
    } finally {
      await lease.close();
    }
  });

  it("rejects arbitrary paths and streaming requests without contacting the provider", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const lease = await new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher)
      .openForTask(testTask);
    try {
      await expect(requestBroker(lease, "/http://attacker.example/steal", { body: {} }))
        .resolves.toMatchObject({ status: 404 });
      await expect(requestBroker(lease, "/openai/responses", { body: { stream: true } }))
        .resolves.toMatchObject({ status: 400 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await lease.close();
    }
  });

  it("does not return provider error bodies or operate without a stored key", async () => {
    const fetcher: typeof fetch = vi.fn(async () => new Response("host-only-api-key leaked", { status: 401 }));
    const lease = await new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher)
      .openForTask(testTask);
    try {
      const result = await requestBroker(lease, "/openai/responses", { body: { model: "test", input: "prompt" } });
      expect(result).toMatchObject({ status: 502, body: JSON.stringify({ error: "Provider request failed." }) });
      expect(result.body).not.toContain("host-only-api-key");
    } finally {
      await lease.close();
    }

    const missingKey = await new LocalProviderEgressBroker(secretStore(null), vi.fn())
      .openForTask(testTask);
    try {
      await expect(requestBroker(missingKey, "/openai/responses", { body: { model: "test", input: "prompt" } }))
        .resolves.toMatchObject({ status: 503 });
    } finally {
      await missingKey.close();
    }
  });

  it("enforces persisted requester budgets before calling the model provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-provider-budget-test-"));
    try {
      const ledger = new LocalBudgetLedger(new Map([[
        "scout", { ownerId: "owner", taskTokens: 390, hourTokens: 390, dayTokens: 390 },
      ]]), join(directory, "usage.jsonl"));
      const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({
        id: "response-1",
        output: [{ content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 }));
      const broker = new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher, ledger);
      const first = await broker.openForTask(testTask);
      try {
        await expect(requestBroker(first, "/openai/responses", {
          body: { model: "test", input: "prompt", max_output_tokens: 50 },
        })).resolves.toMatchObject({ status: 200 });
      } finally {
        await first.close();
      }
      const second = await broker.openForTask(testTask);
      try {
        await expect(requestBroker(second, "/openai/responses", {
          body: { model: "test", input: "prompt", max_output_tokens: 50 },
        })).resolves.toMatchObject({ status: 429 });
        expect(second.budgetExceeded()).toBe(true);
      } finally {
        await second.close();
      }
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles usage from each supported provider response format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-provider-usage-test-"));
    try {
      const usagePath = join(directory, "usage.jsonl");
      const ledger = new LocalBudgetLedger(new Map([[
        "scout", { ownerId: "owner", taskTokens: 5_000, hourTokens: 5_000, dayTokens: 5_000 },
      ]]), usagePath);
      const fetcher: typeof fetch = vi.fn(async (input) => {
        const url = String(input);
        const usage = url.endsWith("/chat/completions")
          ? { prompt_tokens: 11, completion_tokens: 6 }
          : url.endsWith("/messages")
            ? { input_tokens: 12, output_tokens: 7 }
            : { input_tokens: 10, output_tokens: 5 };
        const value = url.endsWith("/chat/completions")
          ? { choices: [{ message: { content: "ok" } }], usage }
          : url.endsWith("/messages")
            ? { content: [{ type: "text", text: "ok" }], usage }
            : { output: [{ content: [{ type: "output_text", text: "ok" }] }], usage };
        return new Response(JSON.stringify(value), { status: 200 });
      });
      const broker = new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher, ledger);
      for (const path of ["/openai/responses", "/openai/chat/completions", "/anthropic/messages"]) {
        const lease = await broker.openForTask(testTask);
        try {
          await expect(requestBroker(lease, path, {
            body: { model: "test", input: "prompt", messages: [], max_output_tokens: 32, max_completion_tokens: 32, max_tokens: 32 },
          })).resolves.toMatchObject({ status: 200 });
        } finally {
          await lease.close();
        }
      }
      const events = (await readFile(usagePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tokens: number });
      expect(events.reduce((sum, event) => sum + event.tokens, 0)).toBe(51);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
