import { z } from "zod";
import { isAbsolute } from "node:path";
import type { AgentBudgetPolicy } from "./budget-ledger.js";

const environmentSchema = z.object({
  SWARMROOM_CONTROL_PLANE_URL: z.string().url(),
  SWARMROOM_MACHINE: z.string().trim().min(1).max(100),
  SWARMROOM_AGENTS: z.string().trim().min(1),
});

export interface DaemonConfig {
  controlPlaneUrl: URL;
  machine: string;
  agents: string[];
}

export interface SandboxConfig {
  image: string;
  workspaces: Map<string, string>;
}

const budgetPolicySchema = z.object({
  ownerId: z.string().trim().min(1).max(100),
  taskTokens: z.number().int().positive().max(10_000_000),
  hourTokens: z.number().int().positive().max(10_000_000),
  dayTokens: z.number().int().positive().max(10_000_000),
}).strict().refine((policy) => policy.taskTokens <= policy.hourTokens && policy.hourTokens <= policy.dayTokens);

export function loadAgentBudgetPolicies(env: NodeJS.ProcessEnv, agents: string[]): Map<string, AgentBudgetPolicy> {
  const value = env.SWARMROOM_AGENT_BUDGETS?.trim();
  if (!value) return new Map();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("SWARMROOM_AGENT_BUDGETS must be a JSON object mapping agents to owner IDs and token limits.");
  }
  const parsed = z.record(z.string(), budgetPolicySchema).safeParse(decoded);
  if (!parsed.success || Object.keys(parsed.data).length !== agents.length ||
      Object.keys(parsed.data).some((agent) => !agents.includes(agent)) ||
      agents.some((agent) => !Object.hasOwn(parsed.data, agent))) {
    throw new Error("SWARMROOM_AGENT_BUDGETS contains invalid policies or agents not configured on this host.");
  }
  return new Map(Object.entries(parsed.data));
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  const parsed = environmentSchema.safeParse({
    SWARMROOM_CONTROL_PLANE_URL: env.SWARMROOM_CONTROL_PLANE_URL,
    SWARMROOM_MACHINE: env.SWARMROOM_MACHINE,
    SWARMROOM_AGENTS: env.SWARMROOM_AGENTS,
  });
  if (!parsed.success) {
    throw new Error("Daemon configuration is invalid. Set the control plane URL, machine name, and agent list.");
  }

  const controlPlaneUrl = new URL(parsed.data.SWARMROOM_CONTROL_PLANE_URL);
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(controlPlaneUrl.hostname);
  if (controlPlaneUrl.pathname !== "/ws" || controlPlaneUrl.username || controlPlaneUrl.password ||
      controlPlaneUrl.search || controlPlaneUrl.hash ||
      (controlPlaneUrl.protocol !== "wss:" && !(controlPlaneUrl.protocol === "ws:" && localHost))) {
    throw new Error("SWARMROOM_CONTROL_PLANE_URL must use wss:// and end in /ws without credentials or query parameters (ws:// is allowed for localhost).");
  }

  const agents = [...new Set(parsed.data.SWARMROOM_AGENTS.split(",").map((agent) => agent.trim()).filter(Boolean))];
  if (agents.length === 0 || agents.length > 100 || agents.some((agent) => agent.length > 100)) {
    throw new Error("SWARMROOM_AGENTS must contain between 1 and 100 agent names, each at most 100 characters.");
  }

  return { controlPlaneUrl, machine: parsed.data.SWARMROOM_MACHINE, agents };
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv, agents: string[]): SandboxConfig | undefined {
  const image = env.SWARMROOM_SANDBOX_IMAGE?.trim();
  const workspacesText = env.SWARMROOM_AGENT_WORKSPACES?.trim();
  if (!image && !workspacesText) return undefined;
  if (!image || !workspacesText || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("Sandbox configuration requires an image pinned by SHA-256 digest and agent workspace paths.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(workspacesText) as unknown;
  } catch {
    throw new Error("SWARMROOM_AGENT_WORKSPACES must be a JSON object mapping agent names to absolute paths.");
  }
  const workspaces = z.record(z.string(), z.string().trim().min(1)).safeParse(decoded);
  if (!workspaces.success || Object.keys(workspaces.data).length !== agents.length ||
      agents.some((agent) => !Object.prototype.hasOwnProperty.call(workspaces.data, agent) ||
        !isAbsolute(workspaces.data[agent] ?? "")) ||
      Object.keys(workspaces.data).some((agent) => !agents.includes(agent))) {
    throw new Error("SWARMROOM_AGENT_WORKSPACES must map every configured agent exactly once to an absolute path.");
  }
  if (Object.values(workspaces.data).some((workspace) => /[,\r\n]/.test(workspace))) {
    throw new Error("Sandbox workspace paths cannot contain commas or line breaks.");
  }
  return { image, workspaces: new Map(Object.entries(workspaces.data)) };
}
