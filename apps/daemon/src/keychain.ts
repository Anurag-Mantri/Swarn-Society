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

export class AgentSecretKeychain {
  constructor(
    private readonly serverHost: string,
    private readonly entryForAccount: (account: string) => PasswordEntry,
  ) {}

  store(agent: string, name: string, value: string): void {
    if (!value.trim()) throw new Error("Agent secret cannot be empty.");
    this.entry(agent, name).setPassword(value);
  }

  load(agent: string, name: string): string | null {
    return this.entry(agent, name).getPassword();
  }

  delete(agent: string, name: string): void {
    this.entry(agent, name).deletePassword();
  }

  private entry(agent: string, name: string): PasswordEntry {
    if (!agent.trim() || agent.length > 100 || !/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) {
      throw new Error("Agent secret identity is invalid.");
    }
    const account = Buffer.from(JSON.stringify([this.serverHost, agent, name])).toString("base64url");
    return this.entryForAccount(account);
  }
}

export async function createSystemHostTokenKeychain(account: string): Promise<HostTokenKeychain> {
  const { Entry } = await import("@napi-rs/keyring");
  // Require Secret Service on Linux; do not silently fall back to temporary kernel storage.
  const entry = new Entry("Swarmroom host token", account, { linux: { store: "secret-service" } });
  return new HostTokenKeychain(entry);
}

export async function createSystemAgentSecretKeychain(serverHost: string): Promise<AgentSecretKeychain> {
  const { Entry } = await import("@napi-rs/keyring");
  const entryForAccount = (account: string): PasswordEntry =>
    new Entry("Swarmroom agent secret", account, { linux: { store: "secret-service" } });
  return new AgentSecretKeychain(serverHost, entryForAccount);
}
