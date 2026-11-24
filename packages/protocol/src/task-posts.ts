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
