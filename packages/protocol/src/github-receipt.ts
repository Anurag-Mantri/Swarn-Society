import { z } from "zod";
import { workspaceSnapshotBranch } from "./workspace-snapshot.js";

export const githubCommitReceiptSchema = z.object({
  serverId: z.string().uuid().transform((id) => id.toLowerCase()),
  repositoryId: z.string().regex(/^[1-9]\d{0,19}$/),
  branch: z.string().max(128),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i).transform((sha) => sha.toLowerCase()),
  committedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
}).strict().superRefine(({ serverId, branch }, context) => {
  if (!z.string().uuid().safeParse(serverId).success || branch !== workspaceSnapshotBranch(serverId)) {
    context.addIssue({ code: "custom", path: ["branch"], message: "Use the dedicated workspace snapshot branch." });
  }
});

export type GitHubCommitReceipt = z.infer<typeof githubCommitReceiptSchema>;
