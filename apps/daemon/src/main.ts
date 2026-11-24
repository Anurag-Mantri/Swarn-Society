import { createSystemHostTokenKeychain } from "./keychain.js";
import { loadDaemonConfig } from "./config.js";
import { HostClient } from "./host-client.js";
import { SandboxRunner } from "./sandbox/runner.js";

async function main(): Promise<void> {
  const config = loadDaemonConfig(process.env);
  const keychain = await createSystemHostTokenKeychain(config.controlPlaneUrl.host);
  const token = keychain.load();
  if (!token) throw new Error("No host token is stored in the OS keychain for this server.");

  const client = new HostClient(config, token, new SandboxRunner());
  const stop = () => client.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await client.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  process.stderr.write(`Swarmroom daemon stopped: ${message}\n`);
  process.exitCode = 1;
});
