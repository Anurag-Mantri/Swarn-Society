import { z } from "zod";

export type KnowledgeOverview = {
  sources: KnowledgeSource[];
  nodes: Array<{ id: string; kind: string; key: string; confidence: number; sourceIds: string[] }>;
  edges: Array<{ id: string; fromId: string; toId: string; relation: string; confidence: number; sourceIds: string[] }>;
};

export type KnowledgeSource = {
  id: string;
  channelId: string | null;
  type: string;
  sourceId: string;
  method: string;
  occurredAt: string;
};

export const knowledgeReviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(2000).default(""),
}).strict();

export type KnowledgeReview = z.input<typeof knowledgeReviewSchema>;
export type KnowledgeReviewCandidate = {
  id: string;
  from: { kind: string; key: string };
  to: { kind: string; key: string };
  relation: string;
  confidence: number;
  method: "deterministic" | "inferred";
  hasConflict: boolean;
  sources: KnowledgeSource[];
};
