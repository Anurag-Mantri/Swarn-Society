import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const threadId = z.string().uuid().optional();
export const threadedHostProtocolVersion = 2;

export const channelKindSchema = z.enum(["text", "voice", "task"]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const createChannelSchema = z.object({
  name: z.string().trim().min(1),
  kind: channelKindSchema.default("text"),
}).strict();

export const helloSchema = z.object({
  t: z.literal("hello"),
  session: text(512).optional(),
  version: z.number().int().positive().optional(),
}).strict();

export const hostSchema = z.object({
  t: z.literal("host"),
  token: text(512),
  machine: text(100),
  agents: z.array(text(100)).min(1).max(100),
  version: z.number().int().positive().optional(),
}).strict();

export const hostHeartbeatSchema = z.object({
  t: z.literal("host.heartbeat"),
  at: z.string().datetime().optional(),
}).strict();

export const messageSchema = z.object({
  t: z.literal("msg"),
  channelId: text(100),
  text: text(4000),
  threadId,
}).strict();

export const replySchema = z.object({
  t: z.literal("reply"),
  channelId: text(100),
  agent: text(100),
  text: text(8000),
  threadId,
}).strict();

export const agentUsageSchema = z.object({
  t: z.literal("agent.usage"),
  channelId: text(100),
  agent: text(100),
  requesterId: z.string().uuid(),
  tokensIn: z.number().int().nonnegative().max(10_000_000),
  tokensOut: z.number().int().nonnegative().max(10_000_000),
}).strict();

export const taskSchema = z.object({
  t: z.literal("task"),
  channelId: text(100),
  from: text(100),
  agent: text(100),
  text: text(4000),
  threadId,
}).strict();

export const initSchema = z.object({
  t: z.literal("init"),
  channels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: channelKindSchema.default("text"),
    serverId: z.string().uuid().optional(),
  })),
  agents: z.array(z.object({
    name: z.string(),
    hostId: z.string(),
    online: z.boolean(),
  })),
}).strict();

export const hostRegisteredSchema = z.object({
  t: z.literal("host.registered"),
  hostId: text(100),
}).strict();

export const errorSchema = z.object({
  t: z.literal("error"),
  code: text(100),
  message: text(1000),
}).strict();

export const hostClientFrameSchema = z.discriminatedUnion("t", [
  hostSchema,
  hostHeartbeatSchema,
  agentUsageSchema,
  replySchema,
]);

export const hostServerFrameSchema = z.discriminatedUnion("t", [
  taskSchema,
  hostRegisteredSchema,
  errorSchema,
]);

export const inboundFrameSchema = z.discriminatedUnion("t", [
  helloSchema,
  hostSchema,
  hostHeartbeatSchema,
  agentUsageSchema,
  messageSchema,
  replySchema,
]);

export type Hello = z.infer<typeof helloSchema>;
export type Host = z.infer<typeof hostSchema>;
export type HostHeartbeat = z.infer<typeof hostHeartbeatSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Reply = z.infer<typeof replySchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Init = z.infer<typeof initSchema>;
export type HostRegistered = z.infer<typeof hostRegisteredSchema>;
export type ErrorFrame = z.infer<typeof errorSchema>;
export type HostClientFrame = z.infer<typeof hostClientFrameSchema>;
export type HostServerFrame = z.infer<typeof hostServerFrameSchema>;

export { createWorkspaceFileSchema, workspacePathSchema } from "./workspace-path.js";
export { maximumSnapshotBytes, maximumSnapshotFiles, workspaceSnapshotBranch, workspaceSnapshotSchema } from "./workspace-snapshot.js";
export type { WorkspaceSnapshot } from "./workspace-snapshot.js";
export { claimTaskPostSchema, createTaskPostSchema } from "./task-posts.js";
export type { TaskClaimant, TaskPost } from "./task-posts.js";
export { createTaskBidSchema } from "./task-posts.js";
export type { TaskBid, TaskBidInput } from "./task-posts.js";
