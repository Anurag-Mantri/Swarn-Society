import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { workspaceSnapshotBranch } from "@swarmroom/protocol";
import { z } from "zod";
import { openGitHubInstallation, type InstallationTarget } from "./app.js";

const run = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const branchInfo = z.object({ name: z.string(), commit: z.object({ sha }) });

function matchesRepository(remote: string, fullName: string): boolean {
  const canonical = remote
    .match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/i)?.[1]
    ?.replace(/\.git$/i, "");
  return canonical?.toLowerCase() === fullName.toLowerCase();
}

async function git(directory: string, args: string[], optional = false): Promise<string | null> {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  try {
    const result = await run("git", ["-C", directory, ...args], { env, timeout: 5000, maxBuffer: 16384 });
    return result.stdout.trim();
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (optional && (code === 1 || code === 128)) return null;
    throw new Error("Could not read the local Git checkout. Check the path and Git installation.");
  }
}

export type SyncState = "unpublished" | "fetch-needed" | "local-branch-missing" |
  "up-to-date" | "pull-needed" | "local-ahead" | "diverged";

export type WorkspaceSyncStatus = {
  repository: string;
  branch: string;
  localHead: string | null;
  remoteHead: string | null;
  ahead: number | null;
  behind: number | null;
  state: SyncState;
};

export async function getWorkspaceSyncStatus(
  target: InstallationTarget,
  pem: string,
  workspaceId: string,
  checkout: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<WorkspaceSyncStatus> {
  const branch = workspaceSnapshotBranch(workspaceId);
  const directory = await realpath(checkout).catch(() => {
    throw new Error("Choose an existing local Git checkout.");
  });
  const origin = await git(directory, ["remote", "get-url", "origin"]);
  const { repository, request } = await openGitHubInstallation(target, pem, "read", fetcher);
  if (!origin || !matchesRepository(origin, repository.fullName)) {
    throw new Error("The local checkout's origin does not match the approved GitHub repository.");
  }

  const local = await git(directory, ["show-ref", "--hash", "--verify", `refs/heads/${branch}`], true);
  const localHead = local === null ? null : sha.parse(local);
  const base = { repository: repository.fullName, branch, localHead, ahead: null, behind: null };
  const response = await request(`/branches/${encodeURIComponent(branch)}`);
  if (response.status === 404) return { ...base, remoteHead: null, state: "unpublished" };
  const remote = branchInfo.safeParse(response.value);
  if (response.status !== 200 || !remote.success || remote.data.name !== branch) {
    throw new Error(`Could not read the GitHub snapshot branch (HTTP ${response.status}).`);
  }
  const remoteHead = remote.data.commit.sha;
  const compared = { ...base, remoteHead };
  if (localHead === remoteHead) return { ...compared, ahead: 0, behind: 0, state: "up-to-date" };
  if (await git(directory, ["cat-file", "-e", `${remoteHead}^{commit}`], true) === null) {
    return { ...compared, state: "fetch-needed" };
  }
  if (!localHead) return { ...compared, state: "local-branch-missing" };
  if (await git(directory, ["rev-parse", "--is-shallow-repository"]) === "true") {
    return { ...compared, state: "fetch-needed" };
  }

  const counts = await git(directory, ["rev-list", "--left-right", "--count", `${localHead}...${remoteHead}`]);
  const parsed = counts?.match(/^(\d+)\s+(\d+)$/);
  if (!parsed) throw new Error("Git did not return valid ahead and behind counts.");
  const ahead = Number(parsed[1]);
  const behind = Number(parsed[2]);
  const state = ahead && behind ? "diverged" : ahead ? "local-ahead" : "pull-needed";
  return { ...compared, ahead, behind, state };
}
