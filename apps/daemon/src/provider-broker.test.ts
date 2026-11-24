import { request as httpRequest } from "node:http";
import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AgentSecretKeychain, type PasswordEntry } from "./keychain.js";
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
  if (value) store.store("scout", "OPENAI_API_KEY", value);
  return store;
}

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
  it("routes only the fixed OpenAI endpoint and injects the key on the host", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: input as URL, init: init ?? {} });
      return new Response(JSON.stringify({ id: "response-1" }), { status: 200 });
    });
    const lease = await new LocalProviderEgressBroker(secretStore("host-only-api-key"), fetcher)
      .openForAgent("scout");
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
      .openForAgent("scout");
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
      .openForAgent("scout");
    try {
      const result = await requestBroker(lease, "/openai/responses", { body: { model: "test", input: "prompt" } });
      expect(result).toMatchObject({ status: 502, body: JSON.stringify({ error: "Provider request failed." }) });
      expect(result.body).not.toContain("host-only-api-key");
    } finally {
      await lease.close();
    }

    const missingKey = await new LocalProviderEgressBroker(secretStore(null), vi.fn())
      .openForAgent("scout");
    try {
      await expect(requestBroker(missingKey, "/openai/responses", { body: { model: "test", input: "prompt" } }))
        .resolves.toMatchObject({ status: 503 });
    } finally {
      await missingKey.close();
    }
  });
});
