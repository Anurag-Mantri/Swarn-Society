import { z } from "zod";

const targetId = z.string().uuid();
const scope = {
  scope: z.enum(["workspace", "channel", "agent"]),
  targetId: targetId.optional(),
};
const scopeMatchesTarget = (value: { scope: string; targetId?: string }) =>
  (value.scope === "workspace") === (value.targetId === undefined);
const scopeError = { path: ["targetId"], message: "Channel and agent memory require a target ID." };

export const memorySearchSchema = z.object({
  ...scope, q: z.string().trim().max(200).default(""),
}).strict().refine(scopeMatchesTarget, scopeError);

export const memoryWriteSchema = z.object({
  ...scope, body: z.string().trim().min(1).max(4000),
}).strict().refine(scopeMatchesTarget, scopeError);

export type MemoryScope = "workspace" | "channel" | "agent";
export type MemoryNote = {
  id: string;
  scope: MemoryScope;
  channelId: string | null;
  agentId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
};
