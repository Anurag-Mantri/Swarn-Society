import { HostTokenCaps } from "../budgets/host-token-caps.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeExtractionInputSchema } from "@swarmroom/protocol";
import { LocalBudgetLedger } from "../budget-ledger.js";
import { loadAgentBudgetPolicies, loadDaemonConfig, loadHostTokenPolicies, loadSandboxConfig } from "../config.js";
import { createSystemAgentSecretKeychain } from "../keychain.js";
import { LocalProviderEgressBroker } from "../provider-broker.js";
import { createPodmanSandboxBackend } from "../sandbox/podman.js";
import { SandboxRunner } from "../sandbox/runner.js";
import { proposeTaskReferences } from "./propose.js";

let scratch: string | undefined;
try {
  const [path, agent, ...extra] = process.argv.slice(2);
  const file = path && await stat(path);
  if (!file || !file.isFile() || file.size > 32_768 || !agent || extra.length) throw new Error("Invalid arguments");
  const input = knowledgeExtractionInputSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const config = loadDaemonConfig(process.env);
  const sandbox = loadSandboxConfig(process.env, config.agents);
  if (!sandbox || !config.agents.includes(agent)) throw new Error("Agent sandbox unavailable");
  const secrets = await createSystemAgentSecretKeychain(config.controlPlaneUrl.host);
  const budgets = new LocalBudgetLedger(loadAgentBudgetPolicies(process.env, config.agents));
  const hostCaps = new HostTokenCaps(loadHostTokenPolicies(process.env, config.agents));
  const broker = new LocalProviderEgressBroker(secrets, globalThis.fetch, budgets, hostCaps);
  scratch = await mkdtemp(join(tmpdir(), "swarmroom-knowledge-"));
  const backend = await createPodmanSandboxBackend({ image: sandbox.image, workspaces: new Map([[agent, scratch]]) }, broker);
  const result = await proposeTaskReferences(input, agent, new SandboxRunner(backend), AbortSignal.timeout(60_000));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write("Could not generate task references. Check the extraction input, configured agent, and rootless sandbox.\n");
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => { process.exitCode = 1; });
}
