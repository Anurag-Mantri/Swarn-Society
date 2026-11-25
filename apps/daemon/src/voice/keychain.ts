import { liveKitCredentialsSchema } from "./issuer.js";

export async function createVoiceKeychain(serverHost: string) {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry("Swarmroom voice signing", serverHost, { linux: { store: "secret-service" } });
  return {
    load() {
      try {
        const value = entry.getPassword();
        return value ? liveKitCredentialsSchema.parse(JSON.parse(value)) : null;
      } catch {
        throw new Error("Could not read a valid LiveKit credential from the host OS keychain.");
      }
    },
    store(value: unknown) {
      entry.setPassword(JSON.stringify(liveKitCredentialsSchema.parse(value)));
    },
    delete() { entry.deletePassword(); },
  };
}
