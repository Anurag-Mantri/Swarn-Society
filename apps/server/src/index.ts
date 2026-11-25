import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { createChannelSchema, inboundFrameSchema, threadedHostProtocolVersion } from "@swarmroom/protocol";
import { eq, and, lt, ne } from "drizzle-orm";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import { loadOidcWorkspaces } from "./auth/oidc-settings.js";
import { setSessionCookie } from "./auth/session-cookie.js";
import { workspaceOidcRoutes } from "./routes/oidc.js";
import { requireUser, getUserBySessionSecret } from "./auth.js";
import { config } from "./config.js";
import { db, pool } from "./db/index.js";
import {
  agents,
  agentUsage,
  agentHosts,
  channels,
  hosts,
  memberRoles,
  members,
  roles,
  sessions,
  users,
  servers,
} from "./db/schema.js";
import { allPermissions, defaultMemberPermissions, permissions } from "./permissions.js";
import { hasChannelPermission, hasServerPermission } from "./channel-access.js";
import { storeMessage } from "./messages/storage.js";
import { threadRootExists } from "./message-threads.js";
import { creditRoutes } from "./routes/credits.js";
import { memoryRoutes } from "./routes/memory.js";
import { auditExportRoutes } from "./routes/audit-export.js";
import { extensionManifestRoutes } from "./routes/extension-manifests.js";
import { knowledgeCommitRoutes } from "./routes/knowledge-commits.js";
import { knowledgeProposalRoutes } from "./routes/knowledge-proposals.js";
import { knowledgeReviewRoutes } from "./routes/knowledge-review.js";
import { knowledgeOverviewRoutes } from "./routes/knowledge-overview.js";
import { messageHistoryRoutes } from "./routes/message-history.js";
import { channelRestrictionRoutes } from "./routes/channel-restrictions.js";
import { workspaceCollaborationRoutes } from "./routes/workspace-collaboration.js";
import { taskMetricsRoutes } from "./routes/task-metrics.js";
import { taskResolutionRoutes } from "./routes/task-resolution.js";
import { taskBidRoutes } from "./routes/task-bids.js";
import { taskReputationRoutes } from "./routes/task-reputation.js";
import { taskPostRoutes } from "./routes/task-posts.js";
import { workspaceFileRoutes } from "./routes/workspace-files.js";
import { workspaceDirectoryRoutes } from "./routes/workspace-directory.js";
import { closeAdapterSessions, handleAdapterFrame, type AdapterConnection } from "./extensions/adapter-session.js";
import { voiceRoutes } from "./routes/voice.js";
import { VoiceJoinBroker } from "./voice/join-broker.js";
import { createSecret, hashSecret } from "./security.js";

export const app = Fastify({
  logger: {
    serializers: {
      req: (request) => ({ method: request.method, url: request.url?.split("?")[0] }),
    },
  },
  bodyLimit: 64 * 1024,
});

await app.register(cookie, { secret: config.sessionSecret });
const ssoProviders = loadOidcWorkspaces(process.env);
const publicOrigin = new URL(config.githubCallbackUrl);
if (ssoProviders.size && process.env.NODE_ENV === "production" &&
    (!process.env.SESSION_SECRET || publicOrigin.protocol !== "https:")) {
  throw new Error("Workspace SSO in production requires SESSION_SECRET and an HTTPS callback origin.");
}
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});
await app.register(websocket, {
  options: { maxPayload: 256 * 1024 },
});
await app.register(workspaceOidcRoutes, { providers: ssoProviders, publicOrigin });
await app.register(channelRestrictionRoutes);
await app.register(messageHistoryRoutes);
await app.register(knowledgeOverviewRoutes);
await app.register(knowledgeReviewRoutes);
await app.register(knowledgeProposalRoutes);
await app.register(knowledgeCommitRoutes);
await app.register(extensionManifestRoutes);
await app.register(creditRoutes);
await app.register(auditExportRoutes);
await app.register(memoryRoutes);
await app.register(workspaceDirectoryRoutes);
await app.register(workspaceFileRoutes);
await app.register(taskPostRoutes);
await app.register(taskReputationRoutes);
await app.register(taskBidRoutes);
await app.register(taskResolutionRoutes);
await app.register(taskMetricsRoutes);
await app.register(workspaceCollaborationRoutes);

type HostConnection = AdapterConnection & {
  socket: WebSocket;
  supportsThreads: boolean;
  supportsVoice: boolean;
};

type UserConnection = {
  socket: WebSocket;
  userId: string;
  echoMessages: boolean;
};

const hostConnections = new Set<HostConnection>();
const userConnections = new Set<UserConnection>();
const voiceBroker = new VoiceJoinBroker();
await app.register(voiceRoutes, {
  broker: voiceBroker,
  findConnection: (hostId, tokenHash) => {
    const host = [...hostConnections].find((candidate) => candidate.hostId === hostId &&
      candidate.tokenHash === tokenHash && candidate.supportsVoice && candidate.socket.readyState === 1);
    return host && {
      connectionId: host.connectionId,
      send: (frame) => host.socket.send(JSON.stringify(frame)),
    };
  },
});

const pendingHostStatusUpdates = new Set<Promise<unknown>>();
const usageRequesterMembers = alias(members, "usage_requester_members");
const usageHostMembers = alias(members, "usage_host_members");

export async function flushHostStatusUpdates(): Promise<void> {
  await Promise.all(pendingHostStatusUpdates);
}

const roleInputSchema = z.object({
  name: z.string().trim().min(1).max(100).refine((name) => !["member", "owner"].includes(name.toLowerCase())),
  permissions: z.number().int().nonnegative().max(allPermissions),
}).strict();

const oauthQuerySchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(512),
}).strict();

const githubTokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().optional(),
});

const githubProfileSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().trim().min(1).max(100),
  avatar_url: z.string().url().optional(),
});

const memberInputSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
}).strict();

const hostAssignmentInputSchema = z.object({
  hostId: z.string().uuid(),
  priority: z.number().int().min(0).max(10_000).default(100),
}).strict();

export async function expireStaleHosts(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - config.hostHeartbeatTimeoutMs);
  const expired = await db.update(hosts).set({ status: "offline" })
    .where(and(eq(hosts.status, "online"), lt(hosts.lastSeenAt, cutoff)))
    .returning({ id: hosts.id });
  const expiredIds = new Set(expired.map((host) => host.id));
  if (expiredIds.size > 0) {
    for (const connection of hostConnections) {
      if (!expiredIds.has(connection.hostId)) continue;
      hostConnections.delete(connection);
      connection.socket.close(4001, "Host heartbeat timed out");
    }
  }
  return [...expiredIds];
}

async function broadcastChannel(channelId: string, payload: unknown, excludedUserId?: string) {
  const channelRows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const channel = channelRows[0];
  if (!channel) return;
  const memberships = await db.select({ userId: members.userId })
    .from(members)
    .where(eq(members.serverId, channel.serverId));
  const memberIds = new Set(memberships.map((membership) => membership.userId));
  const encoded = JSON.stringify(payload);
  for (const recipient of userConnections) {
    if (recipient.socket.readyState !== 1) continue;
    if (!memberIds.has(recipient.userId) || (recipient.userId === excludedUserId && !recipient.echoMessages)) continue;
    if (!await hasChannelPermission(channel, recipient.userId, permissions.readMessages)) continue;
    recipient.socket.send(encoded);
  }
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

app.get("/auth/github", async (request, reply) => {
  if (!config.githubClientId) {
    return reply.code(503).send({ error: "GITHUB_CLIENT_ID is not configured" });
  }
  const state = createSecret();
  reply.setCookie("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", config.githubCallbackUrl);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get("/auth/github/callback", async (request, reply) => {
  if (!config.githubClientId || !config.githubClientSecret) {
    return reply.code(503).send({ error: "GitHub OAuth is not configured" });
  }
  const query = oauthQuerySchema.safeParse(request.query);
  if (!query.success || query.data.state !== request.cookies.oauth_state) {
    return reply.code(400).send({ error: "Invalid OAuth state" });
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code: query.data.code,
        redirect_uri: config.githubCallbackUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return reply.code(502).send({ error: "Could not contact GitHub" });
  }
  if (!tokenResponse.ok) {
    return reply.code(502).send({ error: "GitHub rejected the OAuth code" });
  }
  const tokenResult = githubTokenSchema.safeParse(await tokenResponse.json().catch(() => null));
  if (!tokenResult.success || !tokenResult.data.access_token) {
    return reply.code(502).send({ error: "GitHub did not return an access token" });
  }

  let profileResponse: Response;
  try {
    profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenResult.data.access_token}`,
        "user-agent": "Swarmroom",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return reply.code(502).send({ error: "Could not contact GitHub" });
  }
  if (!profileResponse.ok) {
    return reply.code(502).send({ error: "Could not read GitHub profile" });
  }
  const profileResult = githubProfileSchema.safeParse(await profileResponse.json().catch(() => null));
  if (!profileResult.success) return reply.code(502).send({ error: "GitHub returned an invalid profile" });
  const profile = profileResult.data;
  const [user] = await db.insert(users).values({
    githubId: String(profile.id),
    handle: profile.login,
    avatarUrl: profile.avatar_url,
  }).onConflictDoUpdate({
    target: users.githubId,
    set: { handle: profile.login, avatarUrl: profile.avatar_url },
  }).returning();
  if (!user) {
    return reply.code(500).send({ error: "Could not create user" });
  }

  await setSessionCookie(reply, user.id, 30 * 24 * 60 * 60);
  reply.clearCookie("oauth_state", { path: "/" });
  return reply.redirect("/");
});

app.post("/auth/logout", async (request, reply) => {
  const cookie = request.cookies.session;
  if (cookie) {
    await db.update(sessions).set({ revokedAt: new Date() })
      .where(eq(sessions.secretHash, hashSecret(cookie)));
  }
  reply.clearCookie("session", { path: "/" });
  return reply.send({ ok: true });
});

app.get("/api/me", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  return reply.send({ id: user.id, handle: user.handle, avatarUrl: user.avatarUrl });
});

app.post("/api/servers", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const parsed = z.object({ name: z.string().trim().min(1) }).strict().safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Provide a workspace name." });
  const name = parsed.data.name;
  const server = await db.transaction(async (transaction) => {
    const inserted = await transaction.insert(servers).values({
      name,
      ownerId: user.id,
    }).returning();
    const created = inserted[0];
    if (!created) return null;
    await transaction.insert(members).values({ serverId: created.id, userId: user.id });
    const insertedRoles = await transaction.insert(roles).values([
      { serverId: created.id, name: "Member", permissions: defaultMemberPermissions },
      { serverId: created.id, name: "Owner", permissions: allPermissions },
    ]).returning();
    const ownerRole = insertedRoles.find((role) => role.name === "Owner");
    if (!ownerRole) throw new Error("Could not create owner role");
    await transaction.insert(memberRoles).values({
      serverId: created.id,
      userId: user.id,
      roleId: ownerRole.id,
    });
    return created;
  });
  if (!server) return reply.code(500).send({ error: "Could not create server" });
  return reply.code(201).send(server);
});

app.get("/api/servers/:serverId/roles", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  if (!await hasServerPermission(params.serverId, user.id, permissions.readMessages)) {
    return reply.code(403).send({ error: "Not allowed to view server roles" });
  }
  const rows = await db.select({ id: roles.id, name: roles.name, permissions: roles.permissions })
    .from(roles).where(eq(roles.serverId, params.serverId));
  return reply.send(rows);
});

app.post("/api/servers/:serverId/roles", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  if (!await hasServerPermission(params.serverId, user.id, permissions.manageRoles)) {
    return reply.code(403).send({ error: "Not allowed to manage server roles" });
  }
  const parsed = roleInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid role" });
  const inserted = await db.insert(roles).values({
    serverId: params.serverId,
    name: parsed.data.name,
    permissions: parsed.data.permissions,
  }).returning({ id: roles.id, serverId: roles.serverId, name: roles.name, permissions: roles.permissions });
  return reply.code(201).send(inserted[0]);
});

app.post("/api/servers/:serverId/members", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  if (!await hasServerPermission(params.serverId, user.id, permissions.manageMembers)) {
    return reply.code(403).send({ error: "Not allowed to manage server members" });
  }
  const parsed = memberInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid member" });
  if (parsed.data.roleId && !await hasServerPermission(params.serverId, user.id, permissions.manageRoles)) {
    return reply.code(403).send({ error: "Managing roles is required to assign a role" });
  }
  const roleRows = parsed.data.roleId
    ? await db.select().from(roles).where(and(eq(roles.id, parsed.data.roleId), eq(roles.serverId, params.serverId))).limit(1)
    : await db.select().from(roles).where(and(eq(roles.serverId, params.serverId), eq(roles.name, "Member"))).limit(1);
  const role = roleRows[0];
  if (!role) return reply.code(404).send({ error: "Role not found" });
  const existingUser = await db.select({ id: users.id }).from(users).where(eq(users.id, parsed.data.userId)).limit(1);
  if (!existingUser[0]) return reply.code(404).send({ error: "User not found" });
  await db.transaction(async (transaction) => {
    await transaction.insert(members).values({ serverId: params.serverId, userId: parsed.data.userId }).onConflictDoNothing();
    await transaction.insert(memberRoles).values({
      serverId: params.serverId,
      userId: parsed.data.userId,
      roleId: role.id,
    }).onConflictDoNothing();
  });
  return reply.code(201).send({ userId: parsed.data.userId, roleId: role.id });
});

app.post("/api/servers/:serverId/channels", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  if (!await hasServerPermission(params.serverId, user.id, permissions.manageChannels)) {
    return reply.code(403).send({ error: "Not allowed to manage channels" });
  }
  const parsed = createChannelSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Provide a channel name and a valid kind (text, voice, or task)." });
  }
  const inserted = await db.insert(channels).values({
    serverId: params.serverId,
    ...parsed.data,
  }).returning();
  return reply.code(201).send(inserted[0]);
});

app.post("/api/servers/:serverId/agents", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  if (!await hasServerPermission(params.serverId, user.id, permissions.manageAgents)) {
    return reply.code(403).send({ error: "Not allowed to manage agents" });
  }
  const body = (request.body ?? {}) as { name?: string; role?: string };
  if (!body.name || body.name.trim().length === 0) {
    return reply.code(400).send({ error: "Agent name is required" });
  }
  const inserted = await db.insert(agents).values({
    serverId: params.serverId,
    ownerId: user.id,
    name: body.name.trim(),
    role: body.role?.trim() || "teammate",
  }).returning();
  return reply.code(201).send(inserted[0]);
});

app.post("/api/agents/:agentId/hosts", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { agentId: string };
  const parsed = hostAssignmentInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid host assignment" });
  const agentRows = await db.select().from(agents).where(eq(agents.id, params.agentId)).limit(1);
  const agent = agentRows[0];
  if (!agent) return reply.code(404).send({ error: "Agent not found" });
  if (agent.ownerId !== user.id && !await hasServerPermission(agent.serverId, user.id, permissions.manageAgents)) {
    return reply.code(403).send({ error: "Not allowed to manage this agent's hosts" });
  }
  const hostRows = await db.select().from(hosts).where(eq(hosts.id, parsed.data.hostId)).limit(1);
  const host = hostRows[0];
  if (!host || host.status === "revoked") return reply.code(404).send({ error: "Host not found" });
  const hostMembership = await db.select({ userId: members.userId }).from(members)
    .where(and(eq(members.serverId, agent.serverId), eq(members.userId, host.ownerId))).limit(1);
  if (!hostMembership[0]) return reply.code(400).send({ error: "Host owner must belong to the agent's server" });
  await db.insert(agentHosts).values({
    agentId: agent.id,
    hostId: host.id,
    priority: parsed.data.priority,
    enabled: true,
  }).onConflictDoUpdate({
    target: [agentHosts.agentId, agentHosts.hostId],
    set: { priority: parsed.data.priority, enabled: true },
  });
  return reply.code(201).send({ agentId: agent.id, hostId: host.id, priority: parsed.data.priority });
});

app.post("/api/hosts", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const body = (request.body ?? {}) as { machine?: string };
  if (!body.machine || body.machine.trim().length === 0) {
    return reply.code(400).send({ error: "Machine label is required" });
  }
  const token = createSecret();
  const inserted = await db.insert(hosts).values({
    ownerId: user.id,
    machineLabel: body.machine.trim(),
    tokenHash: hashSecret(token),
  }).returning();
  const host = inserted[0];
  if (!host) return reply.code(500).send({ error: "Could not register host" });
  return reply.code(201).send({ id: host.id, machine: host.machineLabel, token });
});

app.get("/api/hosts", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const rows = await db.select({
    id: hosts.id,
    machine: hosts.machineLabel,
    status: hosts.status,
    lastSeenAt: hosts.lastSeenAt,
  }).from(hosts).where(eq(hosts.ownerId, user.id));
  return reply.send(rows);
});

app.delete("/api/hosts/:hostId", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { hostId: string };
  const revoked = await db.update(hosts).set({ status: "revoked", lastSeenAt: null })
    .where(and(eq(hosts.id, params.hostId), eq(hosts.ownerId, user.id)))
    .returning({ id: hosts.id });
  if (!revoked[0]) return reply.code(404).send({ error: "Host not found" });
  for (const connection of hostConnections) {
    if (connection.hostId !== params.hostId) continue;
    hostConnections.delete(connection);
    connection.socket.close(1008, "Host revoked");
  }
  return reply.send({ ok: true });
});

app.post("/api/hosts/:hostId/rotate", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { hostId: string };
  const ownedHost = await db.select({ id: hosts.id, status: hosts.status, tokenHash: hosts.tokenHash }).from(hosts)
    .where(and(eq(hosts.id, params.hostId), eq(hosts.ownerId, user.id))).limit(1);
  if (!ownedHost[0]) return reply.code(404).send({ error: "Host not found" });
  if (ownedHost[0].status === "revoked") {
    return reply.code(409).send({ error: "A revoked host cannot be rotated" });
  }
  const token = createSecret();
  const rotated = await db.update(hosts).set({
    tokenHash: hashSecret(token),
    status: "offline",
    lastSeenAt: null,
  }).where(and(
    eq(hosts.id, params.hostId),
    eq(hosts.ownerId, user.id),
    eq(hosts.tokenHash, ownedHost[0].tokenHash),
    ne(hosts.status, "revoked"),
  )).returning({ id: hosts.id });
  if (!rotated[0]) return reply.code(409).send({ error: "Host is no longer active" });
  for (const connection of hostConnections) {
    if (connection.hostId !== params.hostId) continue;
    hostConnections.delete(connection);
    connection.socket.close(1008, "Host token rotated");
  }
  return reply.send({ id: rotated[0].id, token });
});

app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
  let connection: HostConnection | UserConnection | null = null;

  const close = () => {
    if (connection && "hostId" in connection) {
      voiceBroker.close(connection.connectionId);
      const cleanup = closeAdapterSessions(connection.connectionId).catch((error: unknown) => {
        app.log.error({ error }, "Could not close adapter sessions");
      });
      pendingHostStatusUpdates.add(cleanup);
      void cleanup.then(() => pendingHostStatusUpdates.delete(cleanup));
    }
    if (connection && "hostId" in connection && hostConnections.delete(connection)) {
      const closingConnection = connection;
      const statusUpdate = db.update(hosts).set({ status: "offline" }).where(and(
        eq(hosts.id, closingConnection.hostId),
        eq(hosts.tokenHash, closingConnection.tokenHash),
      )).then(
        () => undefined,
        (error: unknown) => app.log.error({ error }, "Could not mark disconnected host offline"),
      );
      pendingHostStatusUpdates.add(statusUpdate);
      void statusUpdate.then(() => pendingHostStatusUpdates.delete(statusUpdate));
    }
    if (connection && "userId" in connection) userConnections.delete(connection);
  };
  socket.on("close", close);

  socket.on("message", (raw) => {
    void (async () => {
      if (Buffer.byteLength(raw.toString()) > 16 * 1024) {
        socket.close(1009, "Chat frame is too large");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, "Invalid JSON");
        return;
      }
      const parsed = inboundFrameSchema.safeParse(value);
      if (!parsed.success) {
        socket.send(JSON.stringify({ t: "error", code: "invalid_frame", message: "Malformed or unknown frame" }));
        return;
      }
      const frame = parsed.data;

      if (connection && (frame.t === "hello" || frame.t === "host")) {
        socket.close(1008, "Connection is already authenticated");
        return;
      }

      if (frame.t === "hello") {
        // Cookie-authenticated upgrades must come from the configured public origin.
        const cookieAuth = frame.session === undefined;
        if (cookieAuth && request.headers.origin !== new URL(config.githubCallbackUrl).origin) {
          socket.close(1008, "Invalid origin");
          return;
        }
        const user = await getUserBySessionSecret(frame.session ?? request.cookies.session);
        if (!user) {
          socket.close(1008, "Invalid session");
          return;
        }
        if (socket.readyState !== 1) return;
        connection = { socket, userId: user.id, echoMessages: cookieAuth };
        userConnections.add(connection);
        const channelRows = await db.select({
          id: channels.id, name: channels.name, kind: channels.kind, serverId: channels.serverId,
        })
          .from(channels).innerJoin(members, eq(members.serverId, channels.serverId))
          .where(eq(members.userId, user.id));
        const readableChannels = [];
        for (const channel of channelRows) {
          if (await hasChannelPermission(channel, user.id, permissions.readMessages)) {
            readableChannels.push({ id: channel.id, name: channel.name, kind: channel.kind, serverId: channel.serverId });
          }
        }
        socket.send(JSON.stringify({
          t: "init",
          channels: readableChannels,
          agents: [],
        }));
        return;
      }

      if (frame.t === "host") {
        const rows = await db.select().from(hosts).where(eq(hosts.tokenHash, hashSecret(frame.token))).limit(1);
        const host = rows[0];
        if (!host || host.status === "revoked") {
          socket.close(1008, "Invalid host token");
          return;
        }
        for (const previous of hostConnections) {
          if (previous.hostId !== host.id) continue;
          hostConnections.delete(previous);
          previous.socket.close(4000, "Host reconnected");
        }
        const activated = await db.update(hosts).set({
          machineLabel: frame.machine,
          status: "online",
          lastSeenAt: new Date(),
        }).where(and(
          eq(hosts.id, host.id),
          eq(hosts.tokenHash, hashSecret(frame.token)),
          ne(hosts.status, "revoked"),
        )).returning({ id: hosts.id });
        if (!activated[0]) {
          socket.close(1008, "Host token is no longer valid");
          return;
        }
        await db.update(agentHosts).set({ enabled: false }).where(eq(agentHosts.hostId, host.id));
        for (const agentName of frame.agents) {
          const agentRows = await db.select({ id: agents.id })
            .from(agents)
            .innerJoin(members, and(eq(members.serverId, agents.serverId), eq(members.userId, host.ownerId)))
            .where(and(eq(agents.name, agentName), eq(agents.ownerId, host.ownerId)));
          for (const agent of agentRows) {
            await db.insert(agentHosts).values({
              agentId: agent.id,
              hostId: host.id,
              priority: 100,
              enabled: true,
            }).onConflictDoUpdate({
              target: [agentHosts.agentId, agentHosts.hostId],
              set: { enabled: true },
            });
          }
          const approvedRows = await db.select({ agentId: agentHosts.agentId })
            .from(agentHosts)
            .innerJoin(agents, eq(agents.id, agentHosts.agentId))
            .innerJoin(members, and(eq(members.serverId, agents.serverId), eq(members.userId, host.ownerId)))
            .where(and(eq(agentHosts.hostId, host.id), eq(agents.name, agentName)));
          for (const approved of approvedRows) {
            await db.update(agentHosts).set({ enabled: true }).where(and(
              eq(agentHosts.agentId, approved.agentId),
              eq(agentHosts.hostId, host.id),
            ));
          }
        }
        if (socket.readyState !== 1) {
          await db.update(hosts).set({ status: "offline" }).where(and(
            eq(hosts.id, host.id),
            eq(hosts.tokenHash, host.tokenHash),
          ));
          return;
        }
        connection = {
          socket, hostId: host.id, tokenHash: host.tokenHash, connectionId: randomUUID(),
          supportsThreads: (frame.version ?? 1) >= threadedHostProtocolVersion,
          supportsVoice: frame.voice === true,
        };
        hostConnections.add(connection);
        socket.send(JSON.stringify({ t: "host.registered", hostId: host.id }));
        return;
      }

      if (!connection) {
        socket.close(1008, "Connection not registered");
        return;
      }

      if (frame.t === "voice.token.response") {
        if ("hostId" in connection && connection.supportsVoice && hostConnections.has(connection)) {
          voiceBroker.accept(connection.connectionId, frame);
        }
        return;
      }

      if (frame.t === "adapter.register" || frame.t === "adapter.session.start" || frame.t === "adapter.resource" ||
          frame.t === "adapter.snapshot" || frame.t === "adapter.session.stop") {
        if ("hostId" in connection) {
          const result = await handleAdapterFrame(connection, frame);
          if (socket.readyState === 1) socket.send(JSON.stringify(result));
          else if (frame.t === "adapter.session.start") await closeAdapterSessions(connection.connectionId);
        }
        return;
      }

      if (frame.t === "host.heartbeat") {
        if (!("hostId" in connection)) return;
        await db.update(hosts).set({ lastSeenAt: new Date() })
          .where(and(
            eq(hosts.id, connection.hostId),
            eq(hosts.tokenHash, connection.tokenHash),
            eq(hosts.status, "online"),
          ));
        return;
      }

      if (frame.t === "agent.usage") {
        if (!("hostId" in connection)) return;
        const routes = await db.select({ agentId: agents.id, id: channels.id, serverId: agents.serverId, ownerId: hosts.ownerId })
          .from(agents)
          .innerJoin(agentHosts, eq(agentHosts.agentId, agents.id))
          .innerJoin(hosts, eq(hosts.id, agentHosts.hostId))
          .innerJoin(channels, and(eq(channels.serverId, agents.serverId), eq(channels.id, frame.channelId)))
          .innerJoin(usageRequesterMembers, and(
            eq(usageRequesterMembers.serverId, agents.serverId),
            eq(usageRequesterMembers.userId, frame.requesterId),
          ))
          .innerJoin(usageHostMembers, and(
            eq(usageHostMembers.serverId, agents.serverId),
            eq(usageHostMembers.userId, hosts.ownerId),
          ))
          .where(and(
            eq(agents.name, frame.agent),
            eq(agentHosts.hostId, connection.hostId),
            eq(agentHosts.enabled, true),
            eq(hosts.tokenHash, connection.tokenHash),
            eq(hosts.status, "online"),
          ))
          .limit(1);
        const route = routes[0];
        if (!route ||
            !await hasChannelPermission(route, route.ownerId, permissions.readMessages) ||
            !await hasChannelPermission(route, frame.requesterId, permissions.invokeAgents)) {
          socket.send(JSON.stringify({
            t: "error",
            code: "unauthorized_usage",
            message: "Host is not authorized to report usage for this requester and agent",
          }));
          return;
        }
        await db.insert(agentUsage).values({
          agentId: route.agentId,
          requesterId: frame.requesterId,
          hostId: connection.hostId,
          tokensIn: frame.tokensIn,
          tokensOut: frame.tokensOut,
        });
        await broadcastChannel(frame.channelId, frame);
        return;
      }

      if (frame.t === "msg") {
        if (!("userId" in connection)) return;
        const channelRows = await db.select().from(channels).where(eq(channels.id, frame.channelId)).limit(1);
        const channel = channelRows[0];
        if (!channel) return;
        if (!await hasChannelPermission(channel, connection.userId, permissions.sendMessages)) {
          if (connection.echoMessages) {
            socket.send(JSON.stringify({ t: "error", code: "forbidden", message: "You cannot send messages in this channel." }));
          }
          return;
        }
        if (frame.threadId && !await threadRootExists(frame.channelId, frame.threadId)) {
          socket.send(JSON.stringify({ t: "error", code: "invalid_thread", message: "Thread root not found in this channel" }));
          return;
        }
        const message = await storeMessage({
          channelId: frame.channelId,
          threadId: frame.threadId,
          authorKind: "user",
          authorId: connection.userId,
          body: frame.text,
        }, channel.serverId, { kind: "person", id: connection.userId });
        const notification = {
          t: "msg",
          id: message.id,
          channelId: frame.channelId,
          threadId: frame.threadId,
          text: frame.text,
        };
        await broadcastChannel(frame.channelId, notification, connection.userId);

        if (!await hasChannelPermission(channel, connection.userId, permissions.invokeAgents)) return;
        const mentions = [...frame.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name));
        for (const agentName of mentions) {
          const routes = await db.select({ hostId: agentHosts.hostId, ownerId: hosts.ownerId })
            .from(agents)
            .innerJoin(agentHosts, eq(agentHosts.agentId, agents.id))
            .innerJoin(hosts, eq(hosts.id, agentHosts.hostId))
            .innerJoin(members, and(eq(members.serverId, agents.serverId), eq(members.userId, hosts.ownerId)))
            .where(and(
              eq(agents.name, agentName),
              eq(agents.serverId, channel.serverId),
              eq(agentHosts.enabled, true),
              eq(hosts.status, "online"),
            ))
            .orderBy(agentHosts.priority, agentHosts.hostId);
          let route: (typeof routes)[number] | undefined;
          for (const candidate of routes) {
            const connected = [...hostConnections].find((host) => host.hostId === candidate.hostId
              && host.socket.readyState === 1 && (!frame.threadId || host.supportsThreads));
            if (connected && await hasChannelPermission(channel, candidate.ownerId, permissions.readMessages)) {
              route = candidate;
              break;
            }
          }
          if (!route) continue;
          for (const hostConnection of hostConnections) {
            if (hostConnection.hostId !== route.hostId || hostConnection.socket.readyState !== 1 ||
                (frame.threadId && !hostConnection.supportsThreads)) continue;
            hostConnection.socket.send(JSON.stringify({
              t: "task",
              channelId: frame.channelId,
              threadId: frame.threadId,
              from: connection.userId,
              agent: agentName,
              text: frame.text,
            }));
          }
        }
        return;
      }

      if (frame.t === "reply") {
        if (!("hostId" in connection)) return;
        const routes = await db.select({
          id: channels.id, serverId: agents.serverId, ownerId: hosts.ownerId, agentId: agents.id,
        })
          .from(agents)
          .innerJoin(agentHosts, eq(agentHosts.agentId, agents.id))
          .innerJoin(hosts, eq(hosts.id, agentHosts.hostId))
          .innerJoin(members, and(eq(members.serverId, agents.serverId), eq(members.userId, hosts.ownerId)))
          .innerJoin(channels, eq(channels.serverId, agents.serverId))
          .where(and(
            eq(agents.name, frame.agent),
            eq(agentHosts.hostId, connection.hostId),
            eq(agentHosts.enabled, true),
            eq(hosts.tokenHash, connection.tokenHash),
            eq(hosts.status, "online"),
            eq(channels.id, frame.channelId),
          ))
          .limit(1);
        const route = routes[0];
        if (!route || !await hasChannelPermission(route, route.ownerId, permissions.readMessages)) {
          socket.send(JSON.stringify({
            t: "error",
            code: "unauthorized_reply",
            message: "Host is not authorized to reply as this agent in this channel",
          }));
          return;
        }
        if (frame.threadId && !await threadRootExists(frame.channelId, frame.threadId)) {
          socket.send(JSON.stringify({ t: "error", code: "invalid_thread", message: "Thread root not found in this channel" }));
          return;
        }
        const message = await storeMessage({
          channelId: frame.channelId,
          threadId: frame.threadId,
          authorKind: "agent",
          authorId: frame.agent,
          hostId: connection.hostId,
          body: frame.text,
        }, route.serverId, { kind: "agent", id: route.agentId });
        await broadcastChannel(frame.channelId, {
          t: "msg",
          id: message.id,
          channelId: frame.channelId,
          threadId: frame.threadId,
          text: frame.text,
          from: frame.agent,
          kind: "agent",
          via: connection.hostId,
        });
      }
    })().catch((error: unknown) => {
      app.log.error({ error }, "WebSocket frame handling failed");
      socket.close(1011, "Server error");
    });
  });
});

