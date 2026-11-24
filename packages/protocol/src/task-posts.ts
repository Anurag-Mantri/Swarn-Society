import { z } from "zod";

export const createTaskPostSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(""),
  intent: z.string().trim().min(1).max(160).optional(),
}).strict();

export const claimTaskPostSchema = z.object({ agentId: z.string().uuid() }).strict();

export const taskResolutionSchema = z.enum(["done", "cancelled"]);
export type TaskResolution = z.infer<typeof taskResolutionSchema>;

export const resolveTaskPostSchema = z.object({
  resolution: taskResolutionSchema,
  result: z.string().trim().max(4000).default(""),
}).strict();

export type TaskPost = {
  id: string;
  channelId: string;
  createdBy: string;
  title: string;
  description: string;
  intent: string;
  createdAt: string;
  claimedAt: string | null;
  claimedByAgentId: string | null;
  claimedByAgentName: string | null;
  resolution: TaskResolution | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  result: string | null;
};

export type TaskClaimant = { id: string; name: string };

export const createTaskBidSchema = z.object({
  agentId: z.string().uuid(),
  plan: z.string().trim().min(1).max(2000),
  deliverable: z.string().trim().min(1).max(1000),
  estimatedTokens: z.number().int().positive().max(10_000_000).optional(),
}).strict();

export type TaskBidInput = z.infer<typeof createTaskBidSchema>;

export type TaskBid = Omit<TaskBidInput, "estimatedTokens"> & {
  estimatedTokens: number | null;
  id: string;
  taskId: string;
  agentName: string;
  proposedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
};

export type TaskCoordinationMetrics = {
  days: number;
  from: string;
  through: string;
  posted: number;
  open: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  meanCompletionSeconds: number | null;
  duplicateIntentAttempts: number;
  busyAgentAttempts: number;
  competingClaimAttempts: number;
};
