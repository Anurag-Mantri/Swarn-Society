export interface PasswordEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export class HostTokenKeychain {
  constructor(private readonly entry: PasswordEntry) {}

  load(): string | null {
    return this.entry.getPassword();
  }

  store(token: string): void {
    if (!token.trim()) throw new Error("Host token cannot be empty.");
    this.entry.setPassword(token);
  }

  delete(): void {
    this.entry.deletePassword();
  }
}

export async function createSystemHostTokenKeychain(account: string): Promise<HostTokenKeychain> {
  const { Entry } = await import("@napi-rs/keyring");
  // Require Secret Service on Linux; do not silently fall back to temporary kernel storage.
  const entry = new Entry("Swarmroom host token", account, { linux: { store: "secret-service" } });
  return new HostTokenKeychain(entry);
}
