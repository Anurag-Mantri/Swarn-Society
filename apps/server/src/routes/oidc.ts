import { workspaceSsoIdSchema } from "@swarmroom/protocol";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  authorizationCodeGrant, buildAuthorizationUrl, calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState,
  type Configuration,
} from "openid-client";
import { z } from "zod";
import { openOidcProvider } from "../auth/oidc-client.js";
import { ensureOidcMembership } from "../auth/oidc-identity.js";
import type { OidcProvider } from "../auth/oidc-settings.js";
import { setSessionCookie } from "../auth/session-cookie.js";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";

const attemptLifetime = 600;
const sessionLifetime = 8 * 60 * 60;
const cookieName = "sso_pending";
const loginPath = "/auth/sso";
const noStore = "no-store";
const urlParams = z.object({ serverId: workspaceSsoIdSchema });
const randomValue = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const loginAttempt = z.object({
  serverId: workspaceSsoIdSchema,
  state: randomValue,
  nonce: randomValue,
  verifier: randomValue,
  expiresAt: z.number().int(),
}).strict();
const callbackQuery = z.object({ state: randomValue, code: z.string().min(1).max(4096) });
const identityClaims = z.object({
  iss: z.string().min(1).max(500),
  sub: z.string().regex(/^[\x21-\x7e]{1,255}$/),
  name: z.string().trim().min(1).max(100).optional().catch(undefined),
  groups: z.array(z.string().max(250)).max(500).optional().catch(undefined),
});

type Options = {
  providers: ReadonlyMap<string, OidcProvider>;
  publicOrigin: URL;
  openProvider?: (provider: OidcProvider) => Promise<Configuration>;
};

function readAttempt(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = loginAttempt.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export const workspaceOidcRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const { providers, publicOrigin, openProvider = openOidcProvider } = options;
  const callbackFor = (serverId: string) => new URL(`${loginPath}/${serverId}/callback`, publicOrigin);
  const discovered = new Map<string, { until: number; configuration: Promise<Configuration> }>();
  function providerFor(serverId: string, provider: OidcProvider) {
    const previous = discovered.get(serverId);
    if (previous && previous.until > Date.now()) return previous.configuration;
    const configuration = openProvider(provider).catch((problem: unknown) => {
      if (discovered.get(serverId)?.configuration === configuration) discovered.delete(serverId);
      throw problem;
    });
    discovered.set(serverId, { until: Date.now() + 10 * 60 * 1000, configuration });
    return configuration;
  }

  app.get(`${loginPath}/:serverId`, async (request, reply) => {
    reply.header("Cache-Control", noStore);
    const params = urlParams.safeParse(request.params);
    const serverId = params.data?.serverId;
    const provider = serverId && providers.get(serverId);
    if (!serverId || !provider) return reply.code(404).send({ error: "Workspace SSO is unavailable." });
    const [workspace] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!workspace) return reply.code(404).send({ error: "Workspace SSO is unavailable." });

    try {
      const callback = callbackFor(serverId);
      const client = await providerFor(serverId, provider);
      const state = randomState();
      const nonce = randomNonce();
      const verifier = randomPKCECodeVerifier();
      const challenge = await calculatePKCECodeChallenge(verifier);
      const url = buildAuthorizationUrl(client, {
        redirect_uri: callback.href, scope: "openid profile", state, nonce,
        code_challenge: challenge, code_challenge_method: "S256",
      });
      const value = Buffer.from(JSON.stringify({
        serverId, state, nonce, verifier, expiresAt: Date.now() + attemptLifetime * 1000,
      })).toString("base64url");
      return reply.setCookie(cookieName, value, {
        signed: true, httpOnly: true, secure: callback.protocol === "https:",
        sameSite: "lax", path: `${loginPath}/${serverId}`, maxAge: attemptLifetime,
      }).redirect(url.href);
    } catch {
      return reply.code(502).send({ error: "Could not connect to the workspace identity provider." });
    }
  });

  app.get(`${loginPath}/:serverId/callback`, async (request, reply) => {
    reply.header("Cache-Control", noStore);
    const params = urlParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    const callback = callbackFor(params.data.serverId);
    reply.clearCookie(cookieName, {
      path: `${loginPath}/${params.data.serverId}`, secure: callback.protocol === "https:", httpOnly: true, sameSite: "lax",
    });
    const signed = request.unsignCookie(request.cookies[cookieName] ?? "");
    const attempt = signed.valid ? readAttempt(signed.value ?? undefined) : null;
    const query = callbackQuery.safeParse(request.query);
    if (!attempt || attempt.serverId !== params.data.serverId) return reply.code(400).send({ error: "Start a new workspace SSO sign-in." });
    const { serverId, state, verifier, nonce } = attempt;
    const provider = providers.get(serverId);
    const failed = `/?sso=${serverId}&ssoError=1`;
    if (!provider || !query.success || state !== query.data.state) return reply.redirect(failed);

    try {
      const client = await providerFor(serverId, provider);
      const current = new URL(callback);
      current.search = new URL(request.url, callback).search;
      const tokens = await authorizationCodeGrant(client, current, {
        pkceCodeVerifier: verifier, expectedNonce: nonce, expectedState: state, idTokenExpected: true,
      });
      const claims = identityClaims.parse(tokens.claims());
      if (provider.requiredGroup && !claims.groups?.includes(provider.requiredGroup)) return reply.redirect(failed);
      const userId = await ensureOidcMembership(serverId, {
        issuer: claims.iss, subject: claims.sub, displayName: claims.name ?? "Workspace member",
      });
      await setSessionCookie(reply, userId, sessionLifetime);
      return reply.redirect(`/?workspace=${serverId}`);
    } catch {
      return reply.redirect(failed);
    }
  });
};
