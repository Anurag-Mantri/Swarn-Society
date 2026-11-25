import { generateKeyPairSync } from "node:crypto";
import { workspaceSnapshotBranch } from "@swarmroom/protocol";
import { describe, expect, it, vi } from "vitest";
import { readWorkspaceCommitReceipt } from "./receipt.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const target = { appId: 1, installationId: 2, repositoryId: 3 };
const serverId = "a0000000-0000-4000-8000-000000000001";
const branch = workspaceSnapshotBranch(serverId);
const commitSha = "a".repeat(40);

function mockInstallation(defaultBranch = "main") {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      token: "fake-read-token", expires_at: new Date(Date.now() + 60_000).toISOString(),
      permissions: { contents: "read" }, repositories: [{ id: 3 }],
    }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: 3, full_name: "owner/repo", default_branch: defaultBranch }));
}

describe("workspace snapshot receipts", () => {
  it("requests read access to one repository and returns only commit metadata", async () => {
    const fetcher = mockInstallation().mockResolvedValueOnce(Response.json({
      name: branch, commit: {
        sha: commitSha.toUpperCase(), commit: {
          message: "Private message", committer: { date: "2026-11-25T07:00:00-02:00", email: "private@example.com" },
        },
      },
    }));
    await expect(readWorkspaceCommitReceipt(target, pem, serverId.toUpperCase(), fetcher)).resolves.toEqual({
      serverId, repositoryId: "3", branch, commitSha, committedAt: "2026-11-25T09:00:00.000Z",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      repository_ids: [3], permissions: { contents: "read" },
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe(`https://api.github.com/repos/owner/repo/branches/${encodeURIComponent(branch)}`);
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe("GET");
  });

  it("rejects a missing or unexpected branch and a snapshot branch that was made default", async () => {
    const missing = mockInstallation().mockResolvedValueOnce(Response.json({}, { status: 404 }));
    await expect(readWorkspaceCommitReceipt(target, pem, serverId, missing)).rejects.toThrow("Publish a workspace snapshot");
    const unexpected = mockInstallation().mockResolvedValueOnce(Response.json({
      name: "main", commit: { sha: commitSha, commit: { committer: { date: "2026-11-25T09:00:00Z" } } },
    }));
    await expect(readWorkspaceCommitReceipt(target, pem, serverId, unexpected)).rejects.toThrow("unexpected");
    const same = mockInstallation(branch);
    await expect(readWorkspaceCommitReceipt(target, pem, serverId, same)).rejects.toThrow("default");
    expect(same).toHaveBeenCalledTimes(2);
  });
});
