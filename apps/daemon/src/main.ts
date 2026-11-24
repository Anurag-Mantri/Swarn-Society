import { createSystemHostTokenKeychain } from "./keychain.js";
import { loadDaemonConfig, loadSandboxConfig } from "./config.js";
import { HostClient } from "./host-client.js";
import { SandboxRunner } from "./sandbox/runner.js";
import { createPodmanSandboxBackend } from "./sandbox/podman.js";
import { LocalAuditLog } from "./audit-log.js";
import { createSystemAgentSecretKeychain } from "./keychain.js";
import { LocalProviderEgressBroker } from "./provider-broker.js";

async function main(): Promise<void> {
  const config = loadDaemonConfig(process.env);
  const keychain = await createSystemHostTokenKeychain(config.controlPlaneUrl.host);
  const token = keychain.load();
  if (!token) throw new Error("No host token is stored in the OS keychain for this server.");

  const sandboxConfig = loadSandboxConfig(process.env, config.agents);
  const secrets = sandboxConfig
    ? await createSystemAgentSecretKeychain(config.controlPlaneUrl.host)
    : undefined;
  const broker = secrets ? new LocalProviderEgressBroker(secrets) : undefined;
  const sandbox = sandboxConfig && broker
    ? await createPodmanSandboxBackend(sandboxConfig, broker)
    : undefined;
  const client = new HostClient(config, token, new SandboxRunner(sandbox), new LocalAuditLog());
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
