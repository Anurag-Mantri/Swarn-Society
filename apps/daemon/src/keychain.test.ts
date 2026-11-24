import { describe, expect, it } from "vitest";
import { AgentSecretKeychain, HostTokenKeychain, type PasswordEntry } from "./keychain.js";

class MemoryEntry implements PasswordEntry {
  value: string | null = null;
  getPassword(): string | null { return this.value; }
  setPassword(password: string): void { this.value = password; }
  deletePassword(): boolean { this.value = null; return true; }
}

describe("host token keychain", () => {
  it("stores and deletes tokens through the OS entry abstraction", () => {
    const entry = new MemoryEntry();
    const keychain = new HostTokenKeychain(entry);
    keychain.store("opaque-token");
    expect(keychain.load()).toBe("opaque-token");
    keychain.delete();
    expect(keychain.load()).toBeNull();
  });

  it("rejects empty tokens", () => {
    expect(() => new HostTokenKeychain(new MemoryEntry()).store("  ")).toThrow();
  });
});

describe("agent secret keychain", () => {
  it("scopes provider secrets to the server, agent and secret name", () => {
    const entries = new Map<string, MemoryEntry>();
    const keychain = new AgentSecretKeychain("control.example", (account) => {
      const entry = entries.get(account) ?? new MemoryEntry();
      entries.set(account, entry);
      return entry;
    });
    keychain.store("scout", "OPENAI_API_KEY", "provider-secret");
    expect(keychain.load("scout", "OPENAI_API_KEY")).toBe("provider-secret");
    expect(keychain.load("reviewer", "OPENAI_API_KEY")).toBeNull();
    expect(keychain.load("scout", "ANTHROPIC_API_KEY")).toBeNull();
    keychain.delete("scout", "OPENAI_API_KEY");
    expect(keychain.load("scout", "OPENAI_API_KEY")).toBeNull();
  });

  it("rejects invalid secret names and empty values", () => {
    const keychain = new AgentSecretKeychain("control.example", () => new MemoryEntry());
    expect(() => keychain.store("scout", "bad-name", "secret")).toThrow();
    expect(() => keychain.store("scout", "OPENAI_API_KEY", " ")).toThrow();
  });
});
