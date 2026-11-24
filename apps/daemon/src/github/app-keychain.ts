import type { PasswordEntry } from "../keychain.js";
import { githubId } from "./app.js";

export async function createGitHubAppKeychain(appId: number): Promise<PasswordEntry> {
  const account = String(githubId.parse(appId));
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry("Swarmroom GitHub App key", account, { linux: { store: "secret-service" } });
}
