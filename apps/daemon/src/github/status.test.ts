import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSnapshotBranch } from "@swarmroom/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceSyncStatus } from "./status.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const target = { appId: 1, installationId: 2, repositoryId: 3 };
const workspaceId = "00000000-0000-4000-8000-000000000001";
const branch = workspaceSnapshotBranch(workspaceId);
const directories: string[] = [];

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", [
    "-C", directory, "-c", "user.name=Swarmroom test", "-c", "user.email=test@example.invalid", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function setupRepository() {
  const directory = await mkdtemp(join(tmpdir(), "swarmroom-sync-status-"));
  directories.push(directory);
  git(directory, "init", "--initial-branch=main");
  git(directory, "remote", "add", "origin", "git@github.com:owner/repo.git");
  git(directory, "commit", "--allow-empty", "-m", "initial");
  const initial = git(directory, "rev-parse", "HEAD");
  git(directory, "switch", "-c", branch);
  git(directory, "commit", "--allow-empty", "-m", "local snapshot");
  const local = git(directory, "rev-parse", "HEAD");
  return { directory, initial, local };
}

function mockGitHub(head: string | null) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      token: "fake-scoped-token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: 3 }],
    }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: 3, full_name: "owner/repo", default_branch: "main" }))
    .mockResolvedValueOnce(head
      ? Response.json({ name: branch, commit: { sha: head } })
      : Response.json({}, { status: 404 }));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace sync status", () => {
  it("reports matching heads, missing remote commits, and an unpublished branch", async () => {
    const { directory, local } = await setupRepository();
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, mockGitHub(local)))
      .resolves.toMatchObject({ localHead: local, remoteHead: local, state: "up-to-date", ahead: 0, behind: 0, checkoutHead: local, checkoutIncluded: true });
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, mockGitHub("f".repeat(40))))
      .resolves.toMatchObject({ state: "fetch-needed", ahead: null, behind: null });
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, mockGitHub(null)))
      .resolves.toMatchObject({ state: "unpublished", remoteHead: null });
  });

  it("compares the graph without modifying either checkout or remote", async () => {
    const { directory, initial, local } = await setupRepository();
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, mockGitHub(initial)))
      .resolves.toMatchObject({ state: "local-ahead", ahead: 1, behind: 0, checkoutHead: local, checkoutIncluded: false });

    git(directory, "switch", "-c", "peer", local);
    git(directory, "commit", "--allow-empty", "-m", "other snapshot");
    const advanced = git(directory, "rev-parse", "HEAD");
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, mockGitHub(advanced)))
      .resolves.toMatchObject({ state: "pull-needed", ahead: 0, behind: 1, checkoutHead: advanced, checkoutIncluded: true });

    git(directory, "switch", "main");
    git(directory, "commit", "--allow-empty", "-m", "divergent change");
    const divergent = git(directory, "rev-parse", "HEAD");
    const fetcher = mockGitHub(divergent);
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, fetcher))
      .resolves.toMatchObject({ state: "diverged", ahead: 1, behind: 1 });
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET", "GET"]);
    expect(git(directory, "rev-parse", branch)).toBe(local);
  });

  it("rejects a checkout whose origin points to a different repository", async () => {
    const { directory, local } = await setupRepository();
    git(directory, "remote", "set-url", "origin", "https://github.com/other/repo.git");
    const fetcher = mockGitHub(local);
    await expect(getWorkspaceSyncStatus(target, pem, workspaceId, directory, fetcher))
      .rejects.toThrow("origin does not match");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
