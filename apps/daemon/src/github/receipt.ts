import { githubCommitReceiptSchema, workspaceSnapshotBranch } from "@swarmroom/protocol";
import { z } from "zod";
import { openGitHubInstallation, type InstallationTarget } from "./app.js";

const branchHead = z.object({
  name: z.string(),
  commit: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/i),
    commit: z.object({ committer: z.object({ date: z.string().datetime({ offset: true }) }) }),
  }),
});

export async function readWorkspaceCommitReceipt(
  target: InstallationTarget,
  pem: string,
  serverId: string,
  fetcher: typeof fetch = globalThis.fetch,
) {
  const id = z.string().uuid().safeParse(serverId);
  if (!id.success) throw new Error("Provide a valid Swarmroom workspace ID.");
  const branch = workspaceSnapshotBranch(id.data);
  const { repository, request } = await openGitHubInstallation(target, pem, "read", fetcher);
  if (repository.defaultBranch === branch) throw new Error("Use a workspace snapshot branch separate from the default branch.");
  const response = await request(`/branches/${encodeURIComponent(branch)}`);
  if (response.status === 404) throw new Error("Publish a workspace snapshot to the repository before requesting a receipt.");
  if (response.status !== 200) throw new Error(`Could not read the snapshot branch from GitHub (HTTP ${response.status}).`);
  const head = branchHead.safeParse(response.value);
  if (!head.success || head.data.name !== branch) throw new Error("GitHub returned an unexpected snapshot branch.");
  return githubCommitReceiptSchema.parse({
    serverId,
    branch,
    repositoryId: String(repository.id),
    commitSha: head.data.commit.sha,
    committedAt: head.data.commit.commit.committer.date,
  });
}
