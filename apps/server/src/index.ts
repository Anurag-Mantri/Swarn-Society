import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { inboundFrameSchema } from "@swarmroom/protocol";
import { eq, and, desc, lt, ne } from "drizzle-orm";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { requireUser, getSessionUser } from "./auth.js";
import { config } from "./config.js";
import { db, pool } from "./db/index.js";
import {
  agents,
  agentHosts,
  channels,
  hosts,
  memberRoles,
  members,
  messages,
  roles,
  sessions,
  users,
  servers,
} from "./db/schema.js";
import { allPermissions, defaultMemberPermissions, includesPermission, permissions } from "./permissions.js";
import { createSecret, hashSecret } from "./security.js";

export const app = Fastify({
  logger: true,
  bodyLimit: 64 * 1024,
});

await app.register(cookie);
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});
await app.register(websocket, {
  options: { maxPayload: 16 * 1024 },
});

type HostConnection = {
  socket: WebSocket;
  hostId: string;
  tokenHash: string;
};

type UserConnection = {
  socket: WebSocket;
  userId: string;
};

const hostConnections = new Set<HostConnection>();
const userConnections = new Set<UserConnection>();
const pendingHostStatusUpdates = new Set<Promise<unknown>>();

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

async function hasServerPermission(serverId: string, userId: string, permission: number): Promise<boolean> {
  const serverRows = await db.select({ ownerId: servers.ownerId }).from(servers)
    .where(eq(servers.id, serverId)).limit(1);
  const server = serverRows[0];
  if (!server) return false;
  if (server.ownerId === userId) return true;

  const assignments = await db.select({ granted: roles.permissions })
    .from(memberRoles)
    .innerJoin(members, and(
      eq(members.serverId, memberRoles.serverId),
      eq(members.userId, memberRoles.userId),
    ))
    .innerJoin(roles, eq(memberRoles.roleId, roles.id))
    .where(and(
      eq(memberRoles.serverId, serverId),
      eq(memberRoles.userId, userId),
      eq(roles.serverId, serverId),
    ));
  const grants = assignments.reduce((combined, assignment) => combined | assignment.granted, 0);
  return includesPermission(grants, permission);
}

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
    if (recipient.userId === excludedUserId || !memberIds.has(recipient.userId)) continue;
    if (!await hasServerPermission(channel.serverId, recipient.userId, permissions.readMessages)) continue;
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

  const secret = createSecret();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId: user.id,
    secretHash: hashSecret(secret),
    expiresAt,
  });
  reply.clearCookie("oauth_state", { path: "/" });
  reply.setCookie("session", secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
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
  const body = (request.body ?? {}) as { name?: string };
  if (!body.name || body.name.trim().length === 0) {
    return reply.code(400).send({ error: "Server name is required" });
  }
  const server = await db.transaction(async (transaction) => {
    const inserted = await transaction.insert(servers).values({
      name: body.name!.trim(),
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
  const body = (request.body ?? {}) as { name?: string };
  if (!body.name || body.name.trim().length === 0) {
    return reply.code(400).send({ error: "Channel name is required" });
  }
  const inserted = await db.insert(channels).values({
    serverId: params.serverId,
    name: body.name.trim(),
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

app.get("/api/channels/:channelId/messages", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { channelId: string };
  const channel = await db.select().from(channels).where(eq(channels.id, params.channelId)).limit(1);
  if (!channel[0]) return reply.code(404).send({ error: "Channel not found" });
  if (!await hasServerPermission(channel[0].serverId, user.id, permissions.readMessages)) {
    return reply.code(403).send({ error: "Not allowed to read channel messages" });
  }
  const rows = await db.select().from(messages)
    .where(eq(messages.channelId, params.channelId))
    .orderBy(desc(messages.createdAt))
    .limit(100);
  return reply.send(rows.reverse());
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
        const user = await getSessionUser({ cookies: { session: frame.session } } as never);
        if (!user) {
          socket.close(1008, "Invalid session");
          return;
        }
        if (socket.readyState !== 1) return;
        connection = { socket, userId: user.id };
        userConnections.add(connection);
        const channelRows = await db.select({ id: channels.id, name: channels.name, serverId: channels.serverId })
          .from(channels).innerJoin(members, eq(members.serverId, channels.serverId))
          .where(eq(members.userId, user.id));
        const readableChannels = [];
        for (const channel of channelRows) {
          if (await hasServerPermission(channel.serverId, user.id, permissions.readMessages)) {
            readableChannels.push({ id: channel.id, name: channel.name });
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
        connection = { socket, hostId: host.id, tokenHash: host.tokenHash };
        hostConnections.add(connection);
        socket.send(JSON.stringify({ t: "host.registered", hostId: host.id }));
        return;
      }

      if (!connection) {
        socket.close(1008, "Connection not registered");
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

      if (frame.t === "msg") {
        if (!("userId" in connection)) return;
        const channelRows = await db.select().from(channels).where(eq(channels.id, frame.channelId)).limit(1);
        const channel = channelRows[0];
        if (!channel) return;
        if (!await hasServerPermission(channel.serverId, connection.userId, permissions.sendMessages)) return;
        await db.insert(messages).values({
          channelId: frame.channelId,
          authorKind: "user",
          authorId: connection.userId,
          body: frame.text,
        });
        await broadcastChannel(frame.channelId, {
          t: "msg",
          channelId: frame.channelId,
          text: frame.text,
        }, connection.userId);

        if (!await hasServerPermission(channel.serverId, connection.userId, permissions.invokeAgents)) return;
        const mentions = [...frame.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name));
        for (const agentName of mentions) {
          const routes = await db.select({ hostId: agentHosts.hostId })
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
            .orderBy(agentHosts.priority)
            .limit(1);
          const route = routes[0];
          if (!route) continue;
          for (const hostConnection of hostConnections) {
            if (hostConnection.hostId !== route.hostId || hostConnection.socket.readyState !== 1) continue;
            hostConnection.socket.send(JSON.stringify({
              t: "task",
              channelId: frame.channelId,
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
        const routes = await db.select({ agentId: agents.id })
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
        if (!routes[0]) {
          socket.send(JSON.stringify({
            t: "error",
            code: "unauthorized_reply",
            message: "Host is not authorized to reply as this agent in this channel",
          }));
          return;
        }
        await db.insert(messages).values({
          channelId: frame.channelId,
          authorKind: "agent",
          authorId: frame.agent,
          hostId: connection.hostId,
          body: frame.text,
        });
        await broadcastChannel(frame.channelId, {
          t: "msg",
          channelId: frame.channelId,
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

