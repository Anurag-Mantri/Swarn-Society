import { z } from "zod";
import { taskBidDraftSchema } from "./task-posts.js";

const id = z.string().uuid();

export const taskBidRequestSchema = z.object({
  t: z.literal("task.bid.request"),
  requestId: id,
  channelId: id,
  requesterId: id,
  agent: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(1600),
}).strict();

export const taskBidResponseSchema = z.object({
  t: z.literal("task.bid.response"),
  requestId: id,
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("proposed"), draft: taskBidDraftSchema }).strict(),
    z.object({ status: z.literal("declined") }).strict(),
    z.object({ status: z.literal("unavailable") }).strict(),
  ]),
}).strict();

export type TaskBidRequest = z.infer<typeof taskBidRequestSchema>;
export type TaskBidResponse = z.infer<typeof taskBidResponseSchema>;
export type TaskBidCandidate = { id: string; name: string; role: string };
