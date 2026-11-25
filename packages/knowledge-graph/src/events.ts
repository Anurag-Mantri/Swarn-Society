import { z } from "zod";

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const ids = (limit: number) => z.array(uuid).max(limit).default([])
  .transform((values) => [...new Set(values)].sort());
const actor = z.object({ kind: z.enum(["person", "agent"]), id: uuid }).strict();
const common = {
  sourceId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  serverId: uuid,
  occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
};
const channel = { ...common, channelId: uuid };

export const knowledgeEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...channel,
    type: z.literal("message.posted"),
    messageId: uuid,
    author: actor.optional(),
    mentionedAgentIds: ids(100),
  }).strict(),
  z.object({
    ...channel,
    type: z.literal("task.posted"),
    taskId: uuid,
    authorId: uuid,
  }).strict(),
  z.object({
    ...channel,
    type: z.literal("task.assigned"),
    taskId: uuid,
    agentId: uuid,
    assignedBy: uuid,
  }).strict(),
  z.object({
    ...channel,
    type: z.literal("task.completed"),
    taskId: uuid,
    agentId: uuid,
    resolvedBy: uuid,
  }).strict(),
  z.object({
    ...channel,
    type: z.literal("decision.recorded"),
    decisionId: uuid,
    messageId: uuid,
  }).strict(),
  z.object({
    ...common,
    type: z.literal("file.changed"),
    fileId: uuid,
    actor,
  }).strict(),
  z.object({
    ...common,
    type: z.literal("commit.recorded"),
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$/),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()),
    actor,
    fileIds: ids(200),
  }).strict(),
  z.object({
    ...common,
    type: z.literal("commit.receipt.imported"),
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$/),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()),
    reportedBy: uuid,
  }).strict(),
  z.object({
    ...channel,
    type: z.literal("task.reference.proposed"),
    messageId: uuid,
    taskId: uuid,
    proposedBy: uuid,
    confidence: z.number().int().min(0).max(100),
  }).strict(),
  z.object({
    ...common,
    type: z.literal("agent.hosted"),
    agentId: uuid,
    hostId: uuid,
  }).strict(),
]);

export type KnowledgeEvent = z.infer<typeof knowledgeEventSchema>;
