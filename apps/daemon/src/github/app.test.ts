import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectGitHubInstallation } from "./app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = new Date("2026-11-24T12:00:00Z");
const target = { appId: 15, installationId: 21, repositoryId: 33 };
const scopedResponse = {
  token: "test-installation-token",
  expires_at: "2026-11-24T12:55:00Z",
  permissions: { contents: "read", metadata: "read" },
  repositories: [{ id: 33 }],
};

describe("GitHub App installation", () => {
  it("signs an app JWT and requests a read token for exactly one repository", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(scopedResponse, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ id: 33, full_name: "owner/repository", default_branch: "main" }));

    await expect(inspectGitHubInstallation(target, pem, request, now)).resolves.toEqual({
      id: 33, fullName: "owner/repository", defaultBranch: "main",
    });

    const [tokenUrl, tokenRequest] = request.mock.calls[0]!;
    expect(tokenUrl).toBe("https://api.github.com/app/installations/21/access_tokens");
    expect(tokenRequest).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(tokenRequest?.body))).toEqual({
      repository_ids: [33], permissions: { contents: "read" },
    });
    const [header, payload, signature] = new Headers(tokenRequest?.headers).get("Authorization")!
      .slice("Bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iss: "15", iat: now.getTime() / 1000 - 60, exp: now.getTime() / 1000 + 540,
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")))
      .toBe(true);

    const [repositoryUrl, repositoryRequest] = request.mock.calls[1]!;
    expect(repositoryUrl).toBe("https://api.github.com/repositories/33");
    expect(new Headers(repositoryRequest?.headers).get("Authorization")).toBe("Bearer test-installation-token");
  });

  it.each([
    { repositories: [{ id: 44 }] },
    { repositories: [{ id: 33 }, { id: 44 }] },
    { permissions: { contents: "write" } },
    { expires_at: "2026-11-24T11:59:00Z" },
  ])("rejects an unrequested scope or expired token", async (override) => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...scopedResponse, ...override }, { status: 201 }));
    await expect(inspectGitHubInstallation(target, pem, request, now)).rejects.toThrow("requested repository scope");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider response errors or follow redirects", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive transport details"));
    await expect(inspectGitHubInstallation(target, pem, request, now))
      .rejects.toThrow(/^Could not reach GitHub/);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
