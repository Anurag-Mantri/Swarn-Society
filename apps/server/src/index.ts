import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { inboundFrameSchema } from "@swarmroom/protocol";
import { eq, and, desc } from "drizzle-orm";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { requireUser, getSessionUser } from "./auth.js";
import { config } from "./config.js";
import { db, pool } from "./db/index.js";
import { agents, agentHosts, channels, hosts, members, messages, sessions, users, servers } from "./db/schema.js";
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
};

type UserConnection = {
  socket: WebSocket;
  userId: string;
};

const hostConnections = new Set<HostConnection>();
const userConnections = new Set<UserConnection>();

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
    if (recipient.userId === excludedUserId || !memberIds.has(recipient.userId)) continue;
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
  const query = request.query as { code?: string; state?: string };
  if (!query.code || !query.state || query.state !== request.cookies.oauth_state) {
    return reply.code(400).send({ error: "Invalid OAuth state" });
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code: query.code,
      redirect_uri: config.githubCallbackUrl,
    }),
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string };
  if (!tokenBody.access_token) {
    return reply.code(502).send({ error: "GitHub did not return an access token" });
  }

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenBody.access_token}`,
      "user-agent": "Swarmroom",
    },
  });
  if (!profileResponse.ok) {
    return reply.code(502).send({ error: "Could not read GitHub profile" });
  }
  const profile = await profileResponse.json() as {
    id: number;
    login: string;
    avatar_url?: string;
  };

  const existing = await db.select().from(users).where(eq(users.githubId, String(profile.id))).limit(1);
  let user = existing[0];
  if (!user) {
    const inserted = await db.insert(users).values({
      githubId: String(profile.id),
      handle: profile.login,
      avatarUrl: profile.avatar_url,
    }).returning();
    user = inserted[0];
  } else {
    await db.update(users).set({
      handle: profile.login,
      avatarUrl: profile.avatar_url,
    }).where(eq(users.id, user.id));
  }
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
  const inserted = await db.insert(servers).values({
    name: body.name.trim(),
    ownerId: user.id,
  }).returning();
  const server = inserted[0];
  if (!server) return reply.code(500).send({ error: "Could not create server" });
  await db.insert(members).values({ serverId: server.id, userId: user.id });
  return reply.code(201).send(server);
});

app.post("/api/servers/:serverId/channels", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { serverId: string };
  const membership = await db.select().from(members)
    .where(and(eq(members.serverId, params.serverId), eq(members.userId, user.id)))
    .limit(1);
  if (!membership[0]) return reply.code(403).send({ error: "Not a server member" });
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
  const membership = await db.select().from(members)
    .where(and(eq(members.serverId, params.serverId), eq(members.userId, user.id)))
    .limit(1);
  if (!membership[0]) return reply.code(403).send({ error: "Not a server member" });
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

app.get("/api/channels/:channelId/messages", async (request, reply) => {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = request.params as { channelId: string };
  const channel = await db.select().from(channels).where(eq(channels.id, params.channelId)).limit(1);
  if (!channel[0]) return reply.code(404).send({ error: "Channel not found" });
  const membership = await db.select().from(members)
    .where(and(eq(members.serverId, channel[0].serverId), eq(members.userId, user.id)))
    .limit(1);
  if (!membership[0]) return reply.code(403).send({ error: "Not a server member" });
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
  await db.update(hosts).set({ status: "revoked", lastSeenAt: null })
    .where(and(eq(hosts.id, params.hostId), eq(hosts.ownerId, user.id)));
  return reply.send({ ok: true });
});

app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
  let connection: HostConnection | UserConnection | null = null;

  const close = () => {
    if (connection && "hostId" in connection) {
      hostConnections.delete(connection);
      void db.update(hosts).set({ status: "offline" }).where(eq(hosts.id, connection.hostId));
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

      if (frame.t === "hello") {
        const user = await getSessionUser({ cookies: { session: frame.session } } as never);
        if (!user) {
          socket.close(1008, "Invalid session");
          return;
        }
        connection = { socket, userId: user.id };
        userConnections.add(connection);
        const channelRows = await db.select({ id: channels.id, name: channels.name })
          .from(channels).innerJoin(members, eq(members.serverId, channels.serverId))
          .where(eq(members.userId, user.id));
        socket.send(JSON.stringify({
          t: "init",
          channels: channelRows,
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
        await db.update(hosts).set({ machineLabel: frame.machine, status: "online", lastSeenAt: new Date() })
          .where(eq(hosts.id, host.id));
        for (const agentName of frame.agents) {
          const agentRows = await db.select().from(agents).where(eq(agents.name, agentName));
          for (const agent of agentRows) {
            await db.insert(agentHosts).values({
              agentId: agent.id,
              hostId: host.id,
              priority: 100,
              enabled: true,
            }).onConflictDoNothing();
          }
        }
        connection = { socket, hostId: host.id };
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
        await db.update(hosts).set({ status: "online", lastSeenAt: new Date() })
          .where(eq(hosts.id, connection.hostId));
        return;
      }

      if (frame.t === "msg") {
        if (!("userId" in connection)) return;
        const channelRows = await db.select().from(channels).where(eq(channels.id, frame.channelId)).limit(1);
        const channel = channelRows[0];
        if (!channel) return;
        const membership = await db.select().from(members)
          .where(and(eq(members.serverId, channel.serverId), eq(members.userId, connection.userId)))
          .limit(1);
        if (!membership[0]) return;
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

        const mentions = [...frame.text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)]
          .map((match) => match[1])
          .filter((name): name is string => Boolean(name));
        for (const agentName of mentions) {
          const routes = await db.select({ hostId: agentHosts.hostId })
            .from(agents)
            .innerJoin(agentHosts, eq(agentHosts.agentId, agents.id))
            .innerJoin(hosts, eq(hosts.id, agentHosts.hostId))
            .where(and(eq(agents.name, agentName), eq(agentHosts.enabled, true), eq(hosts.status, "online")))
            .orderBy(agentHosts.priority)
            .limit(1);
          const route = routes[0];
          if (!route) continue;
          for (const hostConnection of hostConnections) {
            if (hostConnection.hostId !== route.hostId) continue;
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
          .where(and(eq(agents.name, frame.agent), eq(agentHosts.hostId, connection.hostId)))
          .limit(1);
        if (!routes[0]) return;
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

