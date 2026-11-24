import { describe, expect, it } from "vitest";
import { HostTokenKeychain, type PasswordEntry } from "./keychain.js";

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
