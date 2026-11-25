import { z } from "zod";

const mergedPullRequest = z.string().trim().max(320)
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}\/?$/)
  .transform((url) => url.toLowerCase().replace(/\/$/, ""));

export const taskReputationInputSchema = z.object({
  feedback: z.enum(["helpful", "needs_work"]).optional(),
  tests: z.enum(["passed", "failed"]).optional(),
  mergedPullRequest: mergedPullRequest.optional(),
}).strict().refine(({ feedback, tests, mergedPullRequest }) => !!(feedback || tests || mergedPullRequest), {
  message: "Provide feedback, a test outcome, or a merged pull request.",
});

export type TaskReputationInput = z.input<typeof taskReputationInputSchema>;
export type TaskReputationReview = {
  taskId: string;
  reviewerId: string;
  feedback: "helpful" | "needs_work" | null;
  tests: "passed" | "failed" | null;
  mergedPullRequest: string | null;
  reviewedAt: string;
};

export type AgentReputation = {
  agentId: string;
  name: string;
  reviewedTasks: number;
  helpful: number;
  needsWork: number;
  testsPassed: number;
  testsFailed: number;
  mergedPullRequests: number;
};
