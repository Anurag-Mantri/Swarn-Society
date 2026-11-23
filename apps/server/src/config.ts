import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  databaseUrl: z.string().min(1).default("postgresql://swarmroom:swarmroom@localhost:5432/swarmroom"),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  githubCallbackUrl: z.string().url().default("http://localhost:3000/auth/github/callback"),
  sessionSecret: z.string().min(32).default("local-development-secret-change-me-32"),
  hostHeartbeatTimeoutMs: z.coerce.number().int().min(1000).default(90_000),
  hostHeartbeatSweepMs: z.coerce.number().int().min(1000).default(30_000),
});

export const config = configSchema.parse({
  port: process.env.PORT,
  databaseUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
  githubClientId: process.env.GITHUB_CLIENT_ID ?? (process.env.NODE_ENV === "test" ? "swarmroom-test-client" : undefined),
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? (process.env.NODE_ENV === "test" ? "swarmroom-test-secret" : undefined),
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL,
  sessionSecret: process.env.SESSION_SECRET,
  hostHeartbeatTimeoutMs: process.env.HOST_HEARTBEAT_TIMEOUT_MS,
  hostHeartbeatSweepMs: process.env.HOST_HEARTBEAT_SWEEP_MS,
});
