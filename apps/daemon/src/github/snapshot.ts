import { workspaceSnapshotBranch, workspaceSnapshotSchema, type WorkspaceSnapshot } from "@swarmroom/protocol";
import { z } from "zod";
import { openGitHubInstallation, type InstallationTarget } from "./app.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const branchSchema = z.object({
  name: z.string(),
  protected: z.boolean(),
  commit: z.object({ sha }),
});
const treeSchema = z.object({ sha });
const commitSchema = z.object({ tree: treeSchema });
type GitHubResponse = { status: number; value: unknown };

function expectStatus(response: GitHubResponse, expected: number, operation: string): unknown {
  if (response.status !== expected) throw new Error(`${operation} failed on GitHub (HTTP ${response.status}).`);
  return response.value;
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`GitHub returned an invalid ${operation} response.`);
  return parsed.data;
}

export async function publishWorkspaceSnapshot(
  target: InstallationTarget,
  pem: string,
  input: WorkspaceSnapshot,
  fetcher: typeof fetch = globalThis.fetch,
) {
  const snapshot = workspaceSnapshotSchema.safeParse(input);
  if (!snapshot.success) throw new Error("The workspace snapshot has invalid, blocked, or oversized files.");
  const branch = workspaceSnapshotBranch(snapshot.data.serverId);
  const { repository, request } = await openGitHubInstallation(target, pem, "write", fetcher);
  if (branch === repository.defaultBranch) throw new Error("The snapshot branch cannot be the repository default.");

  const encodedBranch = encodeURIComponent(branch);
  const branchPath = `/branches/${encodedBranch}`;
  const ensureNoRules = async () => {
    const rules = parseResponse(z.array(z.unknown()), expectStatus(
      await request(`/rules/branches/${encodedBranch}`), 200, "Read snapshot branch rules",
    ), "branch rules");
    if (rules.length) throw new Error("The snapshot branch has active GitHub rules. The snapshot was not published.");
  };
  await ensureNoRules();
  const targetBranch = await request(branchPath);
  const existing = targetBranch.status !== 404;
  const baseBranch = existing
    ? parseResponse(branchSchema, expectStatus(targetBranch, 200, "Read snapshot branch"), "branch")
    : parseResponse(branchSchema, expectStatus(
      await request(`/branches/${encodeURIComponent(repository.defaultBranch)}`), 200, "Read default branch",
    ), "branch");

  if ((existing && (baseBranch.protected || baseBranch.name !== branch)) ||
      (!existing && baseBranch.name !== repository.defaultBranch)) {
    throw new Error("GitHub returned a protected or unexpected branch. The snapshot was not published.");
  }

  const parentSha = baseBranch.commit.sha;
  const parent = parseResponse(commitSchema, expectStatus(
    await request(`/git/commits/${parentSha}`), 200, "Read snapshot parent",
  ), "commit");

  const nextTree = parseResponse(treeSchema, expectStatus(await request("/git/trees", {
    base_tree: parent.tree.sha,
    tree: snapshot.data.files.map(({ path, content }) => ({ path, mode: "100644", type: "blob", content })),
  }), 201, "Create snapshot tree"), "tree");

  if (nextTree.sha === parent.tree.sha && existing) {
    return { repository: repository.fullName, branch, commit: parentSha, changed: false };
  }

  const nextSha = nextTree.sha === parent.tree.sha ? parentSha : parseResponse(treeSchema, expectStatus(
    await request("/git/commits", {
      message: "Swarmroom workspace snapshot",
      tree: nextTree.sha,
      parents: [parentSha],
    }), 201, "Create snapshot commit",
  ), "commit").sha;

  await ensureNoRules();
  if (existing) {
    const latest = parseResponse(branchSchema, expectStatus(await request(branchPath), 200, "Recheck snapshot branch"), "branch");
    if (latest.name !== branch || latest.protected || latest.commit.sha !== parentSha) {
      throw new Error("The snapshot branch changed. Download a fresh snapshot and try again.");
    }
    const refPath = branch.split("/").map(encodeURIComponent).join("/");
    expectStatus(await request(`/git/refs/heads/${refPath}`, { sha: nextSha, force: false }, "PATCH"), 200, "Update snapshot branch");
  } else {
    expectStatus(await request("/git/refs", { ref: `refs/heads/${branch}`, sha: nextSha }), 201, "Create snapshot branch");
  }
  return { repository: repository.fullName, branch, commit: nextSha, changed: true };
}
