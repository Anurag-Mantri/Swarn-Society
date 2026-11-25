import { z } from "zod";
import { containsKnownSecret } from "./secret-patterns.js";

const id = z.string().uuid().transform((value) => value.toLowerCase());
const scope = { serverId: id, channelId: id, messageId: id };
export const knowledgeExtractionInputSchema = z.object({
  ...scope,
  excerpt: z.string().max(1800),
  tasks: z.array(z.object({ id, title: z.string().max(120) }).strict()).min(1).max(8),
}).strict().refine(({ excerpt, tasks }) => !containsKnownSecret(excerpt) && tasks.every(({ title }) => !containsKnownSecret(title)), {
  message: "Extraction input contains a known credential pattern.",
});

export const taskReferenceHypothesesSchema = z.array(z.object({
  taskId: id,
  confidence: z.number().int().min(0).max(100),
}).strict()).max(8).refine((items) => new Set(items.map(({ taskId }) => taskId)).size === items.length, {
  message: "Provide at most one proposal per task.",
});

export const knowledgeProposalFileSchema = z.object({
  ...scope,
  references: taskReferenceHypothesesSchema,
}).strict();

export type KnowledgeExtractionInput = z.infer<typeof knowledgeExtractionInputSchema>;
export type KnowledgeProposalFile = z.infer<typeof knowledgeProposalFileSchema>;
