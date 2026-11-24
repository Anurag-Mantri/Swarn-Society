import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

const githubApi = "https://api.github.com";
const apiVersion = "2026-03-10";

const numericId = z.number().int().positive().safe();
export const githubId = z.union([
  numericId,
  z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(numericId),
]);
export const installationTarget = z.object({
  appId: githubId,
  installationId: githubId,
  repositoryId: githubId,
}).strict();
export type InstallationTarget = z.infer<typeof installationTarget>;

const repositorySchema = z.object({
  id: githubId,
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
});

const tokenSchema = z.object({
  token: z.string().min(1).max(8192),
  expires_at: z.string().datetime({ offset: true }),
  permissions: z.object({
    contents: z.literal("read"),
    metadata: z.literal("read").optional(),
  }).strict(),
  repositories: z.array(z.object({ id: githubId })).length(1),
});

export function parseGitHubAppKey(pem: string) {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("Unsupported key type");
    }
    return key;
  } catch {
    throw new Error("Provide a valid RSA private key for the GitHub App.");
  }
}

function appJwt(appId: number, pem: string, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: String(appId), iat: seconds - 60, exp: seconds + 540 }))
    .toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), parseGitHubAppKey(pem)).toString("base64url");
  return `${input}.${signature}`;
}

async function githubRequest(path: string, credential: string, request: typeof fetch, body?: object) {
  try {
    const response = await request(`${githubApi}${path}`, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": apiVersion,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, value: undefined };
    }
    return { status: response.status, value: await response.json() as unknown };
  } catch {
    throw new Error("Could not reach GitHub. Check the host connection and try again.");
  }
}

export async function inspectGitHubInstallation(
  target: InstallationTarget,
  pem: string,
  request: typeof fetch = globalThis.fetch,
  now = new Date(),
): Promise<{ id: number; fullName: string; defaultBranch: string }> {
  const { appId, installationId, repositoryId } = installationTarget.parse(target);
  const installation = await githubRequest(
    `/app/installations/${installationId}/access_tokens`,
    appJwt(appId, pem, now),
    request,
    { repository_ids: [repositoryId], permissions: { contents: "read" } },
  );
  if (installation.status !== 201) {
    throw new Error(`GitHub refused the installation token (HTTP ${installation.status}). Check the app and installation IDs.`);
  }
  const scoped = tokenSchema.safeParse(installation.value);
  if (!scoped.success || scoped.data.repositories[0]?.id !== repositoryId ||
      new Date(scoped.data.expires_at) <= now) {
    throw new Error("GitHub did not grant the requested repository scope.");
  }

  const result = await githubRequest(`/repositories/${repositoryId}`, scoped.data.token, request);
  const repository = repositorySchema.safeParse(result.value);
  if (!repository.success || repository.data.id !== repositoryId) {
    throw new Error(`Could not verify the installed repository (HTTP ${result.status}).`);
  }
  const { id, full_name: fullName, default_branch: defaultBranch } = repository.data;
  return { id, fullName, defaultBranch };
}
