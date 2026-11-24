import { z } from "zod";

export const createTaskPostSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(""),
}).strict();

export const claimTaskPostSchema = z.object({ agentId: z.string().uuid() }).strict();

export type TaskPost = {
  id: string;
  channelId: string;
  createdBy: string;
  title: string;
  description: string;
  createdAt: string;
  claimedAt: string | null;
  claimedByAgentId: string | null;
  claimedByAgentName: string | null;
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
