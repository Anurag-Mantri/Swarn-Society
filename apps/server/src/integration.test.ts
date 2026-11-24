import { randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app, expireStaleHosts, flushHostStatusUpdates } from "./index.js";
import { config } from "./config.js";
import { db, pool } from "./db/index.js";
import { agentHosts, agentUsage, agents, channels, hosts, members, messages, sessions, users } from "./db/schema.js";
import { hashSecret } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextWebSocketFrame(
  socket: WebSocket,
  description: string,
  matches: (frame: unknown) => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}; received ${JSON.stringify(received)}`));
    }, 10_000);
    const received: unknown[] = [];
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    const onMessage = (raw: RawData) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      received.push(frame);
      if (!matches(frame)) return;
      cleanup();
      resolve(frame);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`WebSocket closed before ${description}: ${code} ${reason.toString()}`));
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

integration("Postgres-backed server routes", () => {
  const sessionSecret = randomBytes(32).toString("base64url");
  let userId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Set TEST_DATABASE_URL to a disposable test database");
    const databaseName = new URL(databaseUrl).pathname.slice(1);
    if (!databaseName.endsWith("_test")) {
      throw new Error("Refusing to truncate a database whose name does not end in _test");
    }
    await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
    await pool.query("TRUNCATE TABLE agent_usage, agent_hosts, agents, messages, channels, member_roles, members, roles, hosts, sessions, servers, users CASCADE");
    const [user] = await db.insert(users).values({ githubId: "integration-user", handle: "integration" }).returning();
    if (!user) throw new Error("Could not seed integration user");
    userId = user.id;
    await db.insert(sessions).values({
      userId,
      secretHash: hashSecret(sessionSecret),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await app.close();
    await flushHostStatusUpdates();
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates OAuth state, verifies the GitHub profile and creates a hashed session", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/github" });
    expect(start.statusCode).toBe(302);
    const stateHeader = start.headers["set-cookie"];
    const startCookies = Array.isArray(stateHeader) ? stateHeader : stateHeader ? [stateHeader] : [];
    const stateCookie = startCookies.find((cookie) => cookie.startsWith("oauth_state="));
    if (!stateCookie) throw new Error("OAuth state cookie was not set");
    const statePair = stateCookie.split(";")[0];
    if (!statePair) throw new Error("OAuth state cookie is invalid");
    const state = decodeURIComponent(statePair.slice("oauth_state=".length));
    const authorizeUrl = new URL(start.headers.location!);
    expect(authorizeUrl.searchParams.get("state")).toBe(state);

    const rejectedState = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=mock-code&state=wrong-state",
      headers: { cookie: statePair },
    });
    expect(rejectedState.statusCode).toBe(400);

    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "mock-provider-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 987654321,
        login: "oauth-integration-user",
        avatar_url: "https://avatars.githubusercontent.com/u/987654321",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", mockedFetch);

    const callback = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: statePair },
    });
    expect(callback.statusCode).toBe(302);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    const sessionHeader = callback.headers["set-cookie"];
    const callbackCookies = Array.isArray(sessionHeader) ? sessionHeader : sessionHeader ? [sessionHeader] : [];
    const sessionCookie = callbackCookies.find((cookie) => cookie.startsWith("session="));
    if (!sessionCookie) throw new Error("Session cookie was not set");
    const sessionPair = sessionCookie.split(";")[0];
    if (!sessionPair) throw new Error("Session cookie is invalid");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionPair } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ handle: string }>().handle).toBe("oauth-integration-user");

    const persistedUser = await db.select().from(users).where(eq(users.githubId, "987654321")).limit(1);
    expect(persistedUser).toHaveLength(1);
    const persistedSession = await db.select().from(sessions).where(eq(sessions.userId, persistedUser[0]!.id)).limit(1);
    expect(persistedSession[0]?.secretHash).not.toContain("mock-provider-token");
  }, 30_000);

  it("creates a server and channel, then reads persisted messages only for members", async () => {
    const cookie = `session=${sessionSecret}`;
    const serverResponse = await app.inject({
      method: "POST",
      url: "/api/servers",
      headers: { cookie },
      payload: { name: "Integration workspace" },
    });
    expect(serverResponse.statusCode).toBe(201);
    const server = serverResponse.json<{ id: string }>();

    const channelResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie },
      payload: { name: "general" },
    });
    expect(channelResponse.statusCode).toBe(201);
    const channel = channelResponse.json<{ id: string }>();

    const directory = await app.inject({ url: "/api/servers", headers: { cookie } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toContainEqual({ id: server.id, name: "Integration workspace", ownerId: userId });
    expect((await app.inject({ url: "/api/servers" })).statusCode).toBe(401);

    const origin = new URL(config.githubCallbackUrl).origin;
    const invalidSocket = await app.injectWS("/ws", { headers: { cookie, origin: "https://invalid.example" } });
    const invalidConnection = new Promise<number>((resolve) => invalidSocket.once("close", resolve));
    invalidSocket.send(JSON.stringify({ t: "hello" }));
    expect(await invalidConnection).toBe(1008);

    const browserSocket = await app.injectWS("/ws", { headers: { cookie, origin } });
    try {
      const ready = nextWebSocketFrame(browserSocket, "browser initialization", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "init");
      browserSocket.send(JSON.stringify({ t: "hello" }));
      expect(await ready).toMatchObject({
        channels: expect.arrayContaining([{ id: channel.id, name: "general", kind: "text", serverId: server.id }]),
      });
    } finally {
      browserSocket.terminate();
    }

    await db.insert(messages).values({
      channelId: channel.id,
      authorKind: "user",
      authorId: userId,
      body: "persisted from Postgres",
    });
    const historyResponse = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie },
    });
    expect(historyResponse.statusCode).toBe(200);
    expect(historyResponse.json<Array<{ body: string }>>().map(({ body }) => body))
      .toEqual(["persisted from Postgres"]);

    const [outsider] = await db.insert(users).values({ githubId: "integration-outsider", handle: "outsider" }).returning();
    if (!outsider) throw new Error("Could not seed integration outsider");
    const outsiderSecret = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId: outsider.id,
      secretHash: hashSecret(outsiderSecret),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const roleResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/roles`,
      headers: { cookie },
      payload: { name: "No message access", permissions: 0 },
    });
    expect(roleResponse.statusCode).toBe(201);
    const role = roleResponse.json<{ id: string }>();

    const memberResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/members`,
      headers: { cookie },
      payload: { userId: outsider.id, roleId: role.id },
    });
    expect(memberResponse.statusCode).toBe(201);

    const filesUrl = `/api/servers/${server.id}/files`;
    const file = await app.inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "src/main.ts" },
    });
    expect(file.statusCode).toBe(201);
    expect(file.json()).toMatchObject({ path: "src/main.ts" });
    const fileList = await app.inject({ url: filesUrl, headers: { cookie } });
    expect(fileList.json()).toEqual([file.json()]);
    const snapshot = await app.inject({ url: `${filesUrl}/snapshot`, headers: { cookie } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers["cache-control"]).toBe("no-store");
    expect(snapshot.json()).toEqual({ serverId: server.id, files: [{ path: "src/main.ts", content: "" }] });
    expect((await app.inject({
      url: `${filesUrl}/snapshot`, headers: { cookie: `session=${outsiderSecret}` },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "SRC" },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "../private.txt" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      url: filesUrl, headers: { cookie: `session=${outsiderSecret}` },
    })).statusCode).toBe(403);

    const outsiderHistory = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie: `session=${outsiderSecret}` },
    });
    expect(outsiderHistory.statusCode).toBe(403);

    const outsiderChannel = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie: `session=${outsiderSecret}` },
      payload: { name: "forbidden" },
    });
    expect(outsiderChannel.statusCode).toBe(403);

    const readerRoleResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/roles`,
      headers: { cookie },
      payload: { name: "Reader", permissions: 1 },
    });
    expect(readerRoleResponse.statusCode).toBe(201);
    const readerRole = readerRoleResponse.json<{ id: string }>();
    const addReader = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/members`,
      headers: { cookie },
      payload: { userId: outsider.id, roleId: readerRole.id },
    });
    expect(addReader.statusCode).toBe(201);
    const outsiderHeaders = { cookie: `session=${outsiderSecret}` };
    const historyUrl = `/api/channels/${channel.id}/messages`;
    const restrictionsUrl = `/api/channels/${channel.id}/role-restrictions`;
    const restrictionUrl = `${restrictionsUrl}/${role.id}`;
    expect((await app.inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PUT", url: restrictionUrl, headers: outsiderHeaders, payload: { denied: 1 },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 8 },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 1 },
    })).statusCode).toBe(200);
    const listed = await app.inject({ url: restrictionsUrl, headers: { cookie } });
    expect(listed.json()).toEqual([{ roleId: role.id, denied: 1 }]);
    expect((await app.inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: historyUrl, headers: { cookie } })).statusCode).toBe(200);
    const restrictedSocket = await app.injectWS("/ws");
    try {
      const initialized = nextWebSocketFrame(restrictedSocket, "restricted channel listing", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "init");
      restrictedSocket.send(JSON.stringify({ t: "hello", session: outsiderSecret }));
      expect(await initialized).toMatchObject({ t: "init", channels: [] });
    } finally {
      restrictedSocket.terminate();
    }
    expect((await app.inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 0 },
    })).statusCode).toBe(200);
    expect((await app.inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(200);

    const agentResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/agents`,
      headers: { cookie },
      payload: { name: "shared-agent" },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agent = agentResponse.json<{ id: string }>();
    const outsiderHostResponse = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: `session=${outsiderSecret}` },
      payload: { machine: "outsider host" },
    });
    expect(outsiderHostResponse.statusCode).toBe(201);
    const outsiderHost = outsiderHostResponse.json<{ id: string }>();
    const allowHostResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/hosts`,
      headers: { cookie },
      payload: { hostId: outsiderHost.id },
    });
    expect(allowHostResponse.statusCode).toBe(201);
    const unauthorizedAllow = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/hosts`,
      headers: { cookie: `session=${outsiderSecret}` },
      payload: { hostId: outsiderHost.id },
    });
    expect(unauthorizedAllow.statusCode).toBe(403);

    const membership = await db.select().from(members)
      .where(and(eq(members.serverId, server.id), eq(members.userId, userId)));
    expect(membership).toHaveLength(1);
    expect((await db.select().from(channels).where(eq(channels.id, channel.id))).length).toBe(1);
  }, 30_000);

  it("routes WebSocket tasks only to the registered host and persists agent replies", async () => {
    const cookie = `session=${sessionSecret}`;
    const serverResponse = await app.inject({
      method: "POST",
      url: "/api/servers",
      headers: { cookie },
      payload: { name: "WebSocket integration workspace" },
    });
    const server = serverResponse.json<{ id: string }>();
    const channelResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie },
      payload: { name: "routing" },
    });
    expect(channelResponse.statusCode).toBe(201);
    const channel = channelResponse.json<{ id: string }>();
    expect(channel).toMatchObject({ kind: "text" });
    const typedChannels = [];
    for (const kind of ["voice", "task"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/servers/${server.id}/channels`,
        headers: { cookie },
        payload: { name: kind, kind },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ kind });
      typedChannels.push(response.json<{ id: string; name: string; kind: string }>());
    }
    const invalidChannel = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie },
      payload: { name: "invalid", kind: "video" },
    });
    expect(invalidChannel.statusCode).toBe(400);
    const agentResponse = await app.inject({
      method: "POST",
      url: `/api/servers/${server.id}/agents`,
      headers: { cookie },
      payload: { name: "routing-agent" },
    });
    expect(agentResponse.statusCode).toBe(201);

    const hostResponse = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie },
      payload: { machine: "routing test host" },
    });
    const host = hostResponse.json<{ id: string; token: string }>();
    const hostSockets: WebSocket[] = [];

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Could not read test server address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const hostSocket = await connectWebSocket(url);
    hostSockets.push(hostSocket);
    const userSocket = await connectWebSocket(url);
    try {
      const registered = nextWebSocketFrame(hostSocket, "host registration", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "host.registered");
      hostSocket.send(JSON.stringify({
        t: "host",
        token: host.token,
        machine: "routing test host",
        agents: ["routing-agent"],
        version: 2,
      }));
      expect(await registered).toMatchObject({ t: "host.registered", hostId: host.id });

      const initialized = nextWebSocketFrame(userSocket, "user initialization", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "init");
      userSocket.send(JSON.stringify({ t: "hello", session: sessionSecret }));
      expect(await initialized).toMatchObject({
        t: "init",
        channels: expect.arrayContaining([
          { id: channel.id, name: "routing", kind: "text", serverId: server.id },
          ...typedChannels.map(({ id, name, kind }) => ({ id, name, kind, serverId: server.id })),
        ]),
      });

      const task = nextWebSocketFrame(hostSocket, "agent task", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "task");
      userSocket.send(JSON.stringify({ t: "msg", channelId: channel.id, text: "@routing-agent inspect this" }));
      expect(await task).toMatchObject({
        t: "task",
        channelId: channel.id,
        agent: "routing-agent",
      });

      const registeredRoute = await db.select({
        agentId: agents.id,
        enabled: agentHosts.enabled,
        tokenHash: hosts.tokenHash,
        status: hosts.status,
        hostOwnerId: hosts.ownerId,
        channelServerId: channels.serverId,
      }).from(agents)
        .innerJoin(agentHosts, eq(agentHosts.agentId, agents.id))
        .innerJoin(hosts, eq(hosts.id, agentHosts.hostId))
        .innerJoin(members, and(eq(members.serverId, agents.serverId), eq(members.userId, hosts.ownerId)))
        .innerJoin(channels, eq(channels.serverId, agents.serverId))
        .where(and(
          eq(agents.name, "routing-agent"),
          eq(agentHosts.hostId, host.id),
          eq(agentHosts.enabled, true),
          eq(hosts.tokenHash, hashSecret(host.token)),
          eq(hosts.status, "online"),
          eq(channels.id, channel.id),
        ));
      expect(registeredRoute).toHaveLength(1);

      const reply = nextWebSocketFrame(hostSocket, "agent reply authorization", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "error");
      const userReply = nextWebSocketFrame(userSocket, "agent reply", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "msg" && "kind" in frame && frame.kind === "agent");
      hostSocket.send(JSON.stringify({ t: "reply", channelId: channel.id, agent: "routing-agent", text: "completed" }));
      const replyResult = await Promise.race([
        reply.then((frame) => ({ kind: "error" as const, frame })),
        userReply.then((frame) => ({ kind: "reply" as const, frame })),
      ]);
      expect(replyResult.kind).toBe("reply");
      if (replyResult.kind === "reply") {
        expect(replyResult.frame).toMatchObject({ t: "msg", text: "completed", from: "routing-agent", kind: "agent" });
      } else {
        expect(replyResult.frame).toMatchObject({ t: "error", code: "unauthorized_reply" });
      }

      const usageBroadcast = nextWebSocketFrame(userSocket, "agent usage broadcast", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "agent.usage");
      hostSocket.send(JSON.stringify({
        t: "agent.usage",
        channelId: channel.id,
        agent: "routing-agent",
        requesterId: userId,
        tokensIn: 321,
        tokensOut: 87,
      }));
      expect(await usageBroadcast).toMatchObject({
        t: "agent.usage", channelId: channel.id, agent: "routing-agent", requesterId: userId,
        tokensIn: 321, tokensOut: 87,
      });
      const usageRows = await db.select().from(agentUsage).where(eq(agentUsage.requesterId, userId));
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]).toMatchObject({ tokensIn: 321, tokensOut: 87, hostId: host.id });

      const [root] = await db.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.authorKind, "user")));
      if (!root) throw new Error("Thread root was not persisted");
      const invalidThread = nextWebSocketFrame(userSocket, "cross-channel thread rejection", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "error");
      userSocket.send(JSON.stringify({
        t: "msg", channelId: typedChannels[0]!.id, threadId: root.id, text: "wrong channel",
      }));
      expect(await invalidThread).toMatchObject({ code: "invalid_thread" });

      const threadedTask = nextWebSocketFrame(hostSocket, "threaded task", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "task");
      userSocket.send(JSON.stringify({
        t: "msg", channelId: channel.id, threadId: root.id, text: "@routing-agent follow up",
      }));
      expect(await threadedTask).toMatchObject({ channelId: channel.id, threadId: root.id });

      const threadedReply = nextWebSocketFrame(userSocket, "threaded reply", (frame) =>
        typeof frame === "object" && frame !== null && "threadId" in frame && frame.threadId === root.id);
      hostSocket.send(JSON.stringify({
        t: "reply", channelId: channel.id, threadId: root.id, agent: "routing-agent", text: "thread complete",
      }));
      expect(await threadedReply).toMatchObject({ t: "msg", id: expect.any(String), text: "thread complete" });
      const threadHistory = await app.inject({
        url: `/api/channels/${channel.id}/messages?threadId=${root.id}`, headers: { cookie },
      });
      expect(threadHistory.statusCode).toBe(200);
      expect(threadHistory.json<Array<{ body: string }>>().map(({ body }) => body))
        .toEqual(["@routing-agent follow up", "thread complete"]);

      const oldHostClosed = new Promise<number>((resolve) => {
        hostSocket.once("close", (code) => resolve(code));
      });
      const rotated = await app.inject({
        method: "POST",
        url: `/api/hosts/${host.id}/rotate`,
        headers: { cookie },
      });
      expect(rotated.statusCode).toBe(200);
      const replacement = rotated.json<{ token: string }>();
      expect(await oldHostClosed).toBe(1008);

      const replacementSocket = await connectWebSocket(url);
      hostSockets.push(replacementSocket);
      const replacementRegistered = nextWebSocketFrame(replacementSocket, "rotated host registration", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "host.registered");
      replacementSocket.send(JSON.stringify({
        t: "host",
        token: replacement.token,
        machine: "routing test host",
        agents: ["routing-agent"],
      }));
      expect(await replacementRegistered).toMatchObject({ t: "host.registered", hostId: host.id });
    } finally {
      for (const socket of hostSockets) socket.terminate();
      userSocket.terminate();
    }

    const history = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    const persistedMessages = history.json<Array<{ body: string; authorKind: string }>>();
    expect(persistedMessages).toHaveLength(2);
    expect(persistedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorKind: "user", body: "@routing-agent inspect this" }),
      expect.objectContaining({ authorKind: "agent", body: "completed" }),
    ]));
  }, 30_000);

  it("rotates host tokens and expires hosts that miss heartbeats", async () => {
    const cookie = `session=${sessionSecret}`;
    const hostResponse = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie },
      payload: { machine: "integration host" },
    });
    expect(hostResponse.statusCode).toBe(201);
    const createdHost = hostResponse.json<{ id: string; token: string }>();
    const storedBeforeRotation = await db.select().from(hosts).where(eq(hosts.id, createdHost.id)).limit(1);
    expect(storedBeforeRotation[0]?.tokenHash).toBe(hashSecret(createdHost.token));

    const rotationResponse = await app.inject({
      method: "POST",
      url: `/api/hosts/${createdHost.id}/rotate`,
      headers: { cookie },
    });
    expect(rotationResponse.statusCode).toBe(200);
    const rotatedHost = rotationResponse.json<{ id: string; token: string }>();
    expect(rotatedHost.token).not.toBe(createdHost.token);
    const storedAfterRotation = await db.select().from(hosts).where(eq(hosts.id, createdHost.id)).limit(1);
    expect(storedAfterRotation[0]?.tokenHash).toBe(hashSecret(rotatedHost.token));

    const [staleHost] = await db.insert(hosts).values({
      ownerId: userId,
      machineLabel: "stale integration host",
      tokenHash: hashSecret(randomBytes(32).toString("base64url")),
      status: "online",
      lastSeenAt: new Date(Date.now() - 120_000),
    }).returning();
    if (!staleHost) throw new Error("Could not seed stale host");
    const expiredIds = await expireStaleHosts(new Date());
    expect(expiredIds).toContain(staleHost.id);
    const storedStaleHost = await db.select().from(hosts).where(eq(hosts.id, staleHost.id)).limit(1);
    expect(storedStaleHost[0]?.status).toBe("offline");

    const revokeResponse = await app.inject({
      method: "DELETE",
      url: `/api/hosts/${createdHost.id}`,
      headers: { cookie },
    });
    expect(revokeResponse.statusCode).toBe(200);
    const rejectedRotation = await app.inject({
      method: "POST",
      url: `/api/hosts/${createdHost.id}/rotate`,
      headers: { cookie },
    });
    expect(rejectedRotation.statusCode).toBe(409);
  }, 30_000);
});
