import { generateKeyPairSync } from "node:crypto";
import { workspaceSnapshotBranch } from "@swarmroom/protocol";
import { describe, expect, it, vi } from "vitest";
import { publishWorkspaceSnapshot } from "./snapshot.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const target = { appId: 1, installationId: 2, repositoryId: 3 };
const snapshot = {
  serverId: "00000000-0000-4000-8000-000000000001",
  files: [{ path: "notes.txt", content: "snapshot note" }],
};
const branch = workspaceSnapshotBranch(snapshot.serverId);
const parent = "a".repeat(40);
const oldTree = "b".repeat(40);
const tree = "c".repeat(40);
const next = "d".repeat(40);

function mockInstallation(defaultBranch = "main") {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      token: "fake-scoped-token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      permissions: { contents: "write", metadata: "read" },
      repositories: [{ id: 3 }],
    }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ id: 3, full_name: "owner/repo", default_branch: defaultBranch }));
}

function branchResponse(name = branch, isProtected = false, head = parent) {
  return Response.json({ name, protected: isProtected, commit: { sha: head } });
}

describe("workspace snapshot publishing", () => {
  it("creates the dedicated snapshot ref with the default branch as parent", async () => {
    const fetcher = mockInstallation()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(branchResponse("main", true))
      .mockResolvedValueOnce(Response.json({ tree: { sha: oldTree } }))
      .mockResolvedValueOnce(Response.json({ sha: tree }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ sha: next }, { status: 201 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({}, { status: 201 }));

    await expect(publishWorkspaceSnapshot(target, pem, snapshot, fetcher)).resolves.toEqual({
      repository: "owner/repo", branch, commit: next, changed: true,
    });
    expect(fetcher.mock.calls[5]?.[0]).toBe(`https://api.github.com/repos/owner/repo/git/commits/${parent}`);
    expect(fetcher.mock.calls[9]?.[0]).toBe("https://api.github.com/repos/owner/repo/git/refs");
    expect(JSON.parse(String(fetcher.mock.calls[9]?.[1]?.body))).toEqual({
      ref: `refs/heads/${branch}`, sha: next,
    });
  });

  it("updates the snapshot branch without force and with a fresh protection check", async () => {
    const fetcher = mockInstallation()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(branchResponse())
      .mockResolvedValueOnce(Response.json({ tree: { sha: oldTree } }))
      .mockResolvedValueOnce(Response.json({ sha: tree }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ sha: next }, { status: 201 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(branchResponse())
      .mockResolvedValueOnce(Response.json({}));

    await expect(publishWorkspaceSnapshot(target, pem, snapshot, fetcher)).resolves.toMatchObject({ commit: next });
    expect(fetcher.mock.calls[9]?.[0]).toBe(`https://api.github.com/repos/owner/repo/git/refs/heads/${branch}`);
    expect(fetcher.mock.calls[9]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ sha: next, force: false }) });
  });

  it("blocks the default branch and protected refs before writing Git objects", async () => {
    const defaultBranch = mockInstallation(branch);
    await expect(publishWorkspaceSnapshot(target, pem, snapshot, defaultBranch)).rejects.toThrow("repository default");
    expect(defaultBranch).toHaveBeenCalledTimes(2);

    const rules = mockInstallation().mockResolvedValueOnce(Response.json([{ type: "creation" }]));
    await expect(publishWorkspaceSnapshot(target, pem, snapshot, rules)).rejects.toThrow("active GitHub rules");
    expect(rules).toHaveBeenCalledTimes(3);

    const protectedBranch = mockInstallation()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(branchResponse(branch, true));
    await expect(publishWorkspaceSnapshot(target, pem, snapshot, protectedBranch)).rejects.toThrow("protected");
    expect(protectedBranch).toHaveBeenCalledTimes(4);
  });

  it("rejects blocked files before contacting GitHub", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const input = { ...snapshot, files: [{ path: ".env.local", content: "blocked" }] };
    await expect(publishWorkspaceSnapshot(target, pem, input, fetcher)).rejects.toThrow("blocked");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
