import { z } from "zod";

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
  if (controlPlaneUrl.pathname !== "/ws" ||
      (controlPlaneUrl.protocol !== "wss:" && !(controlPlaneUrl.protocol === "ws:" && localHost))) {
    throw new Error("SWARMROOM_CONTROL_PLANE_URL must use wss:// and end in /ws (ws:// is allowed for localhost).");
  }

  const agents = [...new Set(parsed.data.SWARMROOM_AGENTS.split(",").map((agent) => agent.trim()).filter(Boolean))];
  if (agents.length === 0 || agents.length > 100 || agents.some((agent) => agent.length > 100)) {
    throw new Error("SWARMROOM_AGENTS must contain between 1 and 100 agent names, each at most 100 characters.");
  }

  return { controlPlaneUrl, machine: parsed.data.SWARMROOM_MACHINE, agents };
}
