import { request as httpRequest } from "node:http";

export type ProviderBrokerRoute =
  | "/openai/responses"
  | "/openai/chat/completions"
  | "/anthropic/messages";

const ALLOWED_ROUTES = new Set<ProviderBrokerRoute>([
  "/openai/responses",
  "/openai/chat/completions",
  "/anthropic/messages",
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CLIENT_TIMEOUT_MS = 50_000;

export async function requestProvider<T = unknown>(
  route: ProviderBrokerRoute,
  body: Record<string, unknown>,
  socketPath = process.env.SWARMROOM_PROVIDER_SOCKET,
): Promise<T> {
  if (!ALLOWED_ROUTES.has(route)) throw new Error("Provider route is not allowed.");
  if (!socketPath || !socketPath.startsWith("/")) {
    throw new Error("SWARMROOM_PROVIDER_SOCKET must be an absolute Unix socket path.");
  }

  const requestBody = JSON.stringify({ body });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timeout = setTimeout(() => request.destroy(new Error("Provider broker request timed out.")), CLIENT_TIMEOUT_MS);
    const request = httpRequest({
      socketPath,
      path: route,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(new Error("Provider broker response exceeds the client limit."));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", () => finish(new Error("Provider broker response failed.")));
      response.once("end", () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          finish(new Error(`Provider broker returned HTTP ${response.statusCode ?? 500}.`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(undefined, parsed as T);
        } catch {
          finish(new Error("Provider broker returned invalid JSON."));
        }
      });
    });
    request.once("error", () => finish(new Error("Provider broker request failed.")));
    request.end(requestBody);
  });
}
