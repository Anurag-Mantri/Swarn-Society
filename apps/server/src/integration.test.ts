import type { InjectOptions } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app, expireStaleHosts, flushHostStatusUpdates } from "./index.js";
import { config } from "./config.js";
import { db, pool } from "./db/index.js";
import { agentHosts, agentUsage, agents, channels, hosts, members, messages, sessions, users } from "./db/schema.js";
import { knowledgeEdges, knowledgeEdgeSources, knowledgeSources } from "./db/knowledge-schema.js";
import { storeKnowledgeEvent } from "./knowledge/storage.js";
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
  let testAddress = 1;
  const inject = (options: InjectOptions) => app.inject({ ...options, remoteAddress: `127.0.0.${testAddress}` });

  // Each test uses its own simulated client IP so suite order cannot consume another test's rate limit.
  beforeEach(() => { testAddress += 1; });

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
    const start = await inject({ method: "GET", url: "/auth/github" });
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

    const rejectedState = await inject({
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

    const callback = await inject({
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
    const me = await inject({ method: "GET", url: "/api/me", headers: { cookie: sessionPair } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ handle: string }>().handle).toBe("oauth-integration-user");

    const persistedUser = await db.select().from(users).where(eq(users.githubId, "987654321")).limit(1);
    expect(persistedUser).toHaveLength(1);
    const persistedSession = await db.select().from(sessions).where(eq(sessions.userId, persistedUser[0]!.id)).limit(1);
    expect(persistedSession[0]?.secretHash).not.toContain("mock-provider-token");
  }, 30_000);

  it("creates a server and channel, then reads persisted messages only for members", async () => {
    const cookie = `session=${sessionSecret}`;
    const serverResponse = await inject({
      method: "POST",
      url: "/api/servers",
      headers: { cookie },
      payload: { name: "Integration workspace" },
    });
    expect(serverResponse.statusCode).toBe(201);
    const server = serverResponse.json<{ id: string }>();

    const channelResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie },
      payload: { name: "general" },
    });
    expect(channelResponse.statusCode).toBe(201);
    const channel = channelResponse.json<{ id: string }>();

    const directory = await inject({ url: "/api/servers", headers: { cookie } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toContainEqual({ id: server.id, name: "Integration workspace", ownerId: userId });
    expect((await inject({ url: "/api/servers" })).statusCode).toBe(401);

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
    const historyResponse = await inject({
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

    const roleResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/roles`,
      headers: { cookie },
      payload: { name: "No message access", permissions: 0 },
    });
    expect(roleResponse.statusCode).toBe(201);
    const role = roleResponse.json<{ id: string }>();

    const memberResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/members`,
      headers: { cookie },
      payload: { userId: outsider.id, roleId: role.id },
    });
    expect(memberResponse.statusCode).toBe(201);

    const filesUrl = `/api/servers/${server.id}/files`;
    const file = await inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "src/main.ts" },
    });
    expect(file.statusCode).toBe(201);
    expect(file.json()).toMatchObject({ path: "src/main.ts" });
    const fileList = await inject({ url: filesUrl, headers: { cookie } });
    expect(fileList.json()).toEqual([file.json()]);
    const [fileSource] = await db.select().from(knowledgeSources)
      .where(eq(knowledgeSources.sourceId, `created:${file.json<{ id: string }>().id}`));
    expect(fileSource).toMatchObject({ serverId: server.id, channelId: null, type: "file.changed" });
    const snapshot = await inject({ url: `${filesUrl}/snapshot`, headers: { cookie } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.headers["cache-control"]).toBe("no-store");
    expect(snapshot.json()).toEqual({ serverId: server.id, files: [{ path: "src/main.ts", content: "" }] });
    expect((await inject({
      url: `${filesUrl}/snapshot`, headers: { cookie: `session=${outsiderSecret}` },
    })).statusCode).toBe(403);
    expect((await inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "SRC" },
    })).statusCode).toBe(409);
    expect((await inject({
      method: "POST", url: filesUrl, headers: { cookie }, payload: { path: "../private.txt" },
    })).statusCode).toBe(400);
    expect((await inject({
      url: filesUrl, headers: { cookie: `session=${outsiderSecret}` },
    })).statusCode).toBe(403);

    const outsiderHistory = await inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie: `session=${outsiderSecret}` },
    });
    expect(outsiderHistory.statusCode).toBe(403);

    const outsiderChannel = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie: `session=${outsiderSecret}` },
      payload: { name: "forbidden" },
    });
    expect(outsiderChannel.statusCode).toBe(403);

    const readerRoleResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/roles`,
      headers: { cookie },
      payload: { name: "Reader", permissions: 1 },
    });
    expect(readerRoleResponse.statusCode).toBe(201);
    const readerRole = readerRoleResponse.json<{ id: string }>();
    const addReader = await inject({
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
    expect((await inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(200);
    expect((await inject({
      method: "PUT", url: restrictionUrl, headers: outsiderHeaders, payload: { denied: 1 },
    })).statusCode).toBe(403);
    expect((await inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 8 },
    })).statusCode).toBe(400);
    expect((await inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 1 },
    })).statusCode).toBe(200);
    const listed = await inject({ url: restrictionsUrl, headers: { cookie } });
    expect(listed.json()).toEqual([{ roleId: role.id, denied: 1 }]);
    expect((await inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(403);
    expect((await inject({ url: historyUrl, headers: { cookie } })).statusCode).toBe(200);
    const hiddenGraphSource = await storeKnowledgeEvent({
      type: "message.posted", sourceId: "private-test-graph-message", occurredAt: new Date().toISOString(),
      serverId: server.id, channelId: channel.id, messageId: "00000000-0000-4000-8000-000000000001",
      author: { kind: "person", id: userId },
    });
    const knowledgeUrl = `/api/servers/${server.id}/knowledge`;
    const ownerGraph = await inject({ url: knowledgeUrl, headers: { cookie } });
    expect(ownerGraph.json()).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ id: hiddenGraphSource.sourceId })]),
    });
    const restrictedGraph = await inject({ url: knowledgeUrl, headers: outsiderHeaders });
    expect(restrictedGraph.statusCode).toBe(200);
    expect(restrictedGraph.json()).toMatchObject({
      sources: [expect.objectContaining({ channelId: null, type: "file.changed" })],
    });
    expect(JSON.stringify(restrictedGraph.json())).not.toContain(hiddenGraphSource.sourceId);
    expect((await inject({
      url: `${knowledgeUrl}?channelId=${channel.id}`, headers: outsiderHeaders,
    })).statusCode).toBe(403);
    const restrictedSocket = await app.injectWS("/ws");
    try {
      const initialized = nextWebSocketFrame(restrictedSocket, "restricted channel listing", (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "init");
      restrictedSocket.send(JSON.stringify({ t: "hello", session: outsiderSecret }));
      expect(await initialized).toMatchObject({ t: "init", channels: [] });
    } finally {
      restrictedSocket.terminate();
    }
    expect((await inject({
      method: "PUT", url: restrictionUrl, headers: { cookie }, payload: { denied: 0 },
    })).statusCode).toBe(200);
    expect((await inject({ url: historyUrl, headers: outsiderHeaders })).statusCode).toBe(200);

    const agentResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/agents`,
      headers: { cookie },
      payload: { name: "shared-agent" },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agent = agentResponse.json<{ id: string }>();
    const outsiderHostResponse = await inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: `session=${outsiderSecret}` },
      payload: { machine: "outsider host" },
    });
    expect(outsiderHostResponse.statusCode).toBe(201);
    const outsiderHost = outsiderHostResponse.json<{ id: string }>();
    const allowHostResponse = await inject({
      method: "POST",
      url: `/api/agents/${agent.id}/hosts`,
      headers: { cookie },
      payload: { hostId: outsiderHost.id },
    });
    expect(allowHostResponse.statusCode).toBe(201);
    const unauthorizedAllow = await inject({
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
    const serverResponse = await inject({
      method: "POST",
      url: "/api/servers",
      headers: { cookie },
      payload: { name: "WebSocket integration workspace" },
    });
    const server = serverResponse.json<{ id: string }>();
    const channelResponse = await inject({
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
      const response = await inject({
        method: "POST",
        url: `/api/servers/${server.id}/channels`,
        headers: { cookie },
        payload: { name: kind, kind },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ kind });
      typedChannels.push(response.json<{ id: string; name: string; kind: string }>());
    }
    const invalidChannel = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/channels`,
      headers: { cookie },
      payload: { name: "invalid", kind: "video" },
    });
    expect(invalidChannel.statusCode).toBe(400);
    const agentResponse = await inject({
      method: "POST",
      url: `/api/servers/${server.id}/agents`,
      headers: { cookie },
      payload: { name: "routing-agent" },
    });
    expect(agentResponse.statusCode).toBe(201);

    const hostResponse = await inject({
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
      const threadHistory = await inject({
        url: `/api/channels/${channel.id}/messages?threadId=${root.id}`, headers: { cookie },
      });
      expect(threadHistory.statusCode).toBe(200);
      expect(threadHistory.json<Array<{ body: string }>>().map(({ body }) => body))
        .toEqual(["@routing-agent follow up", "thread complete"]);

      const extension = await inject({
        method: "POST", url: `/api/servers/${server.id}/extensions`, headers: { cookie },
        payload: {
          slug: "notes-adapter", name: "Notes Adapter", version: "1.0.0", protocolVersion: 1,
          operatingSystems: ["linux"], capabilities: ["resource.read", "snapshot.create"],
          resources: [{ type: "document", extensions: [".txt"] }], snapshotFormat: "metadata-json",
        },
      });
      expect(extension.statusCode).toBe(201);
      const manifestId = extension.json<{ id: string }>().id;
      const adapterId = randomUUID();
      const sessionId = randomUUID();
      const resourceId = randomUUID();
      const snapshotId = randomUUID();
      const approvalUrl = `/api/hosts/${host.id}/extensions/${manifestId}/approval`;
      const sendAdapter = async (socket: WebSocket, frame: object) => {
        const response = nextWebSocketFrame(socket, "adapter response", (value) =>
          typeof value === "object" && value !== null && "t" in value && (value.t === "adapter.ack" || value.t === "error"));
        socket.send(JSON.stringify(frame));
        return response;
      };

      const adapterRegistration = { t: "adapter.register", adapterId, manifestId, protocolVersion: 1 };
      expect(await sendAdapter(hostSocket, adapterRegistration)).toMatchObject({ code: "adapter_denied" });
      expect((await inject({
        method: "PUT", url: approvalUrl, headers: { cookie }, payload: { capabilities: ["resource.read"] },
      })).statusCode).toBe(200);
      expect(await sendAdapter(hostSocket, adapterRegistration)).toMatchObject({ action: "register", id: adapterId });
      expect(await sendAdapter(hostSocket, { t: "adapter.session.start", adapterId, sessionId, channelId: channel.id }))
        .toMatchObject({ action: "session.start", id: sessionId });

      const resourceFrame = { t: "adapter.resource", sessionId, resourceId, resourceType: "document", extension: ".txt", byteLength: 42 };
      expect(await sendAdapter(hostSocket, { ...resourceFrame, extension: ".exe" })).toMatchObject({ code: "adapter_denied" });
      expect(await sendAdapter(hostSocket, resourceFrame)).toMatchObject({ action: "resource", id: resourceId });
      const snapshotFrame = {
        t: "adapter.snapshot", sessionId, resourceId, snapshotId, format: "metadata-json",
        sha256: "a".repeat(64), byteLength: 42,
      };
      expect(await sendAdapter(hostSocket, snapshotFrame)).toMatchObject({ code: "adapter_denied" });
      expect((await inject({
        method: "PUT", url: approvalUrl, headers: { cookie }, payload: { capabilities: ["resource.read", "snapshot.create"] },
      })).statusCode).toBe(200);
      expect(await sendAdapter(hostSocket, snapshotFrame)).toMatchObject({ action: "snapshot", id: snapshotId });
      expect(await sendAdapter(hostSocket, { ...snapshotFrame, sha256: "b".repeat(64) })).toMatchObject({ code: "adapter_conflict" });
      expect((await inject({ method: "DELETE", url: approvalUrl, headers: { cookie } })).statusCode).toBe(204);
      expect(await sendAdapter(hostSocket, resourceFrame)).toMatchObject({ code: "adapter_denied" });

      const oldHostClosed = new Promise<number>((resolve) => {
        hostSocket.once("close", (code) => resolve(code));
      });
      const rotated = await inject({
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
      expect((await inject({
        method: "PUT", url: approvalUrl, headers: { cookie }, payload: { capabilities: ["resource.read"] },
      })).statusCode).toBe(200);
      expect(await sendAdapter(replacementSocket, resourceFrame)).toMatchObject({ code: "adapter_denied" });
    } finally {
      for (const socket of hostSockets) socket.terminate();
      userSocket.terminate();
    }

    const history = await inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    const persistedMessages = history.json<Array<{ body: string; authorKind: string }>>();
    expect(persistedMessages).toHaveLength(2);
    const messageSources = await db.select().from(knowledgeSources).where(and(
      eq(knowledgeSources.channelId, channel.id), eq(knowledgeSources.type, "message.posted"),
    ));
    expect(messageSources).toHaveLength(4);
    expect(messageSources.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: { kind: "person", id: userId } }),
      expect.objectContaining({ author: expect.objectContaining({ kind: "agent" }) }),
    ]));
    expect(JSON.stringify(messageSources)).not.toContain("follow up");
    expect(persistedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorKind: "user", body: "@routing-agent inspect this" }),
      expect.objectContaining({ authorKind: "agent", body: "completed" }),
    ]));
  }, 30_000);

  it("allows one concurrent claim for an open task and restricts claims to owned agents", async () => {
    const headers = { cookie: `session=${sessionSecret}` };
    const workspace = await inject({
      method: "POST", url: "/api/servers", headers, payload: { name: "Task board test" },
    });
    expect(workspace.statusCode).toBe(201);
    const { id: serverId } = workspace.json<{ id: string }>();
    const channelResponse = await inject({
      method: "POST", url: `/api/servers/${serverId}/channels`, headers, payload: { name: "queue", kind: "task" },
    });
    expect(channelResponse.statusCode).toBe(201);
    const { id: channelId } = channelResponse.json<{ id: string }>();
    const url = `/api/channels/${channelId}/tasks`;
    expect((await inject({ url })).statusCode).toBe(401);
    expect((await inject({ method: "POST", url, headers, payload: { title: " " } })).statusCode).toBe(400);
    const posted = await inject({
      method: "POST", url, headers, payload: { title: "Review the docs", description: "Check task examples" },
    });
    expect(posted.statusCode).toBe(201);
    const task = posted.json<{ id: string }>();
    expect(task).toMatchObject({ channelId, createdBy: userId, title: "Review the docs", claimedByAgentId: null });

    const selectedAgents = [];
    for (const name of ["reviewer-a", "reviewer-b"]) {
      const created = await inject({
        method: "POST", url: `/api/servers/${serverId}/agents`, headers, payload: { name },
      });
      expect(created.statusCode).toBe(201);
      selectedAgents.push({ id: created.json<{ id: string }>().id, name });
    }
    const claimants = await inject({ url: `${url}/claimants`, headers });
    expect(claimants.json()).toEqual(selectedAgents);

    const [teammate] = await db.insert(users).values({ githubId: "task-claim-test", handle: "teammate" }).returning();
    if (!teammate) throw new Error("Could not create task channel member");
    const teammateSecret = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId: teammate.id, secretHash: hashSecret(teammateSecret), expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await inject({
      method: "POST", url: `/api/servers/${serverId}/members`, headers, payload: { userId: teammate.id },
    })).statusCode).toBe(201);
    const firstAgent = selectedAgents[0]!;
    expect((await inject({
      method: "POST", url: `${url}/${task.id}/claim`, headers: { cookie: `session=${teammateSecret}` },
      payload: { agentId: firstAgent.id },
    })).statusCode).toBe(403);

    const claims = await Promise.all(selectedAgents.map(({ id: agentId }) => inject({
      method: "POST", url: `${url}/${task.id}/claim`, headers, payload: { agentId },
    })));
    expect(claims.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const winner = claims.find(({ statusCode }) => statusCode === 200)?.json<{ claimedByAgentId: string }>();
    expect(winner).toBeDefined();
    const list = await inject({ url, headers });
    expect(list.json()).toEqual([expect.objectContaining({ id: task.id, ...winner, claimedAt: expect.any(String) })]);
    expect((await inject({
      method: "POST", url: `${url}/${task.id}/claim`, headers, payload: { agentId: winner?.claimedByAgentId },
    })).statusCode).toBe(200);
    const losingAgentId = selectedAgents.find(({ id }) => id !== winner?.claimedByAgentId)?.id;
    const duplicate = await inject({
      method: "POST", url, headers, payload: { title: "  REVIEW   THE docs  " },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({ intent: "review the docs" });
    const duplicateClaim = await inject({
      method: "POST", url: `${url}/${duplicate.json<{ id: string }>().id}/claim`, headers,
      payload: { agentId: losingAgentId },
    });
    expect(duplicateClaim.statusCode).toBe(409);
    expect(duplicateClaim.json()).toMatchObject({ error: expect.stringContaining("already working on this intent") });

    const otherChannel = await inject({
      method: "POST", url: `/api/servers/${serverId}/channels`, headers,
      payload: { name: "further-work", kind: "task" },
    });
    expect(otherChannel.statusCode).toBe(201);
    const otherUrl = `/api/channels/${otherChannel.json<{ id: string }>().id}/tasks`;
    const other = await inject({
      method: "POST", url: otherUrl, headers, payload: { title: "Cross-check the implementation", intent: "Regression checks" },
    });
    expect(other.statusCode).toBe(201);
    const otherClaimUrl = `${otherUrl}/${other.json<{ id: string }>().id}/claim`;
    const busyClaim = await inject({
      method: "POST", url: otherClaimUrl, headers, payload: { agentId: winner?.claimedByAgentId },
    });
    expect(busyClaim.statusCode).toBe(409);
    expect(busyClaim.json()).toMatchObject({ error: expect.stringContaining("active task") });
    expect((await inject({
      method: "POST", url: `${url}/${task.id}/resolve`, headers, payload: { resolution: "done" },
    })).statusCode).toBe(200);
    expect((await inject({
      method: "POST", url: otherClaimUrl, headers, payload: { agentId: winner?.claimedByAgentId },
    })).statusCode).toBe(200);
    const metrics = await inject({ url: `${url}/metrics?days=7`, headers });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      days: 7, posted: 2, open: 1, inProgress: 0, completed: 1, cancelled: 0,
      meanCompletionSeconds: expect.any(Number),
      duplicateIntentAttempts: 1, busyAgentAttempts: 0, competingClaimAttempts: 1,
    });
    const otherMetrics = await inject({ url: `${otherUrl}/metrics`, headers });
    expect(otherMetrics.json()).toMatchObject({
      posted: 1, inProgress: 1, completed: 0, meanCompletionSeconds: null,
      duplicateIntentAttempts: 0, busyAgentAttempts: 1, competingClaimAttempts: 0,
    });
    expect((await inject({ url: `${url}/metrics?days=15`, headers })).statusCode).toBe(400);
    expect((await inject({ url: `${url}/metrics` })).statusCode).toBe(401);
  }, 30_000);

  it("requires the task author to approve a teammate's proposed contract", async () => {
    const authorHeaders = { cookie: `session=${sessionSecret}` };
    const workspace = await inject({
      method: "POST", url: "/api/servers", headers: authorHeaders, payload: { name: "Bid approvals test" },
    });
    expect(workspace.statusCode).toBe(201);
    const { id: serverId } = workspace.json<{ id: string }>();
    const channel = await inject({
      method: "POST", url: `/api/servers/${serverId}/channels`, headers: authorHeaders,
      payload: { name: "contracts", kind: "task" },
    });
    const url = `/api/channels/${channel.json<{ id: string }>().id}/tasks`;
    const posted = await inject({
      method: "POST", url, headers: authorHeaders, payload: { title: "Write a summary" },
    });
    expect(posted.statusCode).toBe(201);
    const { id: taskId } = posted.json<{ id: string }>();

    const [bidder] = await db.insert(users).values({ githubId: "bid-test", handle: "bidder" }).returning();
    if (!bidder) throw new Error("Could not create a bidder");
    const secret = randomBytes(32).toString("base64url");
    const bidderHeaders = { cookie: `session=${secret}` };
    await db.insert(sessions).values({
      userId: bidder.id, secretHash: hashSecret(secret), expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await inject({
      method: "POST", url: `/api/servers/${serverId}/members`, headers: authorHeaders, payload: { userId: bidder.id },
    })).statusCode).toBe(201);
    const bidAgents = await db.insert(agents).values([
      { name: "first-bidder", role: "Writer", serverId, ownerId: bidder.id },
      { name: "second-bidder", role: "Writer", serverId, ownerId: bidder.id },
    ]).returning({ id: agents.id });
    expect(bidAgents).toHaveLength(2);

    const bidsPath = `${url}/${taskId}/bids`;
    const [first, second] = await Promise.all(bidAgents.map(({ id: agentId }) => inject({
      method: "POST", url: bidsPath, headers: bidderHeaders,
      payload: { agentId, plan: "Summarize the source", deliverable: "A short summary", estimatedTokens: 500 },
    })));
    expect(first?.statusCode).toBe(201);
    expect(second?.statusCode).toBe(201);
    const bids = [first!, second!].map((response) => response.json<{ id: string; agentId: string }>());
    expect((await inject({
      method: "POST", url: `${url}/${taskId}/claim`, headers: bidderHeaders, payload: { agentId: bids[0]!.agentId },
    })).statusCode).toBe(403);
    expect((await inject({
      method: "POST", url: `${bidsPath}/${bids[0]!.id}/approve`, headers: bidderHeaders,
    })).statusCode).toBe(403);

    const results = await Promise.all(bids.map(({ id }) => inject({
      method: "POST", url: `${bidsPath}/${id}/approve`, headers: authorHeaders,
    })));
    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const winnerIndex = results.findIndex(({ statusCode }) => statusCode === 200);
    const winner = bids[winnerIndex]!;
    expect(results[winnerIndex]?.json()).toMatchObject({ claimedByAgentId: winner.agentId });
    const listed = await inject({ url: bidsPath, headers: authorHeaders });
    expect(listed.json<Array<{ approvedBy: string | null; id: string }>>().filter(({ approvedBy }) => approvedBy))
      .toEqual([expect.objectContaining({ id: winner.id, approvedBy: userId })]);
    expect((await inject({
      method: "POST", url: `${bidsPath}/${winner.id}/approve`, headers: authorHeaders,
    })).statusCode).toBe(200);
    const resolvePath = `${url}/${taskId}/resolve`;
    expect((await inject({
      method: "POST", url: resolvePath, headers: bidderHeaders, payload: { resolution: "cancelled" },
    })).statusCode).toBe(403);
    const completed = await inject({
      method: "POST", url: resolvePath, headers: bidderHeaders,
      payload: { resolution: "done", result: "Shared the completed summary." },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      resolution: "done", result: "Shared the completed summary.",
      resolvedBy: bidder.id, claimedByAgentId: winner.agentId,
    });
    const taskSources = await db.select({ type: knowledgeSources.type, event: knowledgeSources.event })
      .from(knowledgeSources).where(eq(knowledgeSources.sourceId, taskId));
    expect(taskSources.map(({ type }) => type).sort()).toEqual(["task.assigned", "task.completed", "task.posted"]);
    expect(JSON.stringify(taskSources)).not.toContain("Shared the completed summary.");
    expect((await inject({
      method: "POST", url: resolvePath, headers: authorHeaders, payload: { resolution: "cancelled" },
    })).statusCode).toBe(409);

    const openTask = await inject({
      method: "POST", url, headers: authorHeaders, payload: { title: "Cancel this request" },
    });
    expect(openTask.statusCode).toBe(201);
    const openId = openTask.json<{ id: string }>().id;
    expect((await inject({
      method: "POST", url: `${url}/${openId}/resolve`, headers: authorHeaders, payload: { resolution: "done" },
    })).statusCode).toBe(409);
    const cancelled = await inject({
      method: "POST", url: `${url}/${openId}/resolve`, headers: authorHeaders,
      payload: { resolution: "cancelled", result: "No longer needed." },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ resolution: "cancelled", claimedByAgentId: null });
    expect((await inject({
      method: "POST", url: `${url}/${openId}/bids`, headers: bidderHeaders,
      payload: { agentId: winner.agentId, plan: "Late work", deliverable: "A late result" },
    })).statusCode).toBe(409);
  }, 30_000);

  it("stores immutable graph provenance and confines it to its workspace and channel", async () => {
    const headers = { cookie: `session=${sessionSecret}` };
    const workspace = await inject({
      method: "POST", url: "/api/servers", headers, payload: { name: "Knowledge storage test" },
    });
    const { id: serverId } = workspace.json<{ id: string }>();
    const created = await inject({
      method: "POST", url: `/api/servers/${serverId}/channels`, headers, payload: { name: "knowledge" },
    });
    const { id: channelId } = created.json<{ id: string }>();
    const event = {
      type: "task.assigned", sourceId: "assignment:1", occurredAt: "2026-11-24T10:00:00Z",
      serverId, channelId, assignedBy: userId,
      taskId: "00000000-0000-4000-8000-000000000001",
      agentId: "00000000-0000-4000-8000-000000000002",
    };
    const first = await storeKnowledgeEvent(event);
    expect(first.inserted).toBe(true);
    await expect(storeKnowledgeEvent(event)).resolves.toEqual({ sourceId: first.sourceId, inserted: false });
    await expect(storeKnowledgeEvent({ ...event, agentId: "00000000-0000-4000-8000-000000000003" }))
      .rejects.toThrow("identity already belongs");
    const second = await storeKnowledgeEvent({ ...event, sourceId: "assignment:2" });
    expect(second.inserted).toBe(true);
    const edges = await db.select().from(knowledgeEdges).where(and(
      eq(knowledgeEdges.serverId, serverId), eq(knowledgeEdges.relation, "assigned_to"),
    ));
    expect(edges).toHaveLength(1);
    const evidence = await db.select({ id: knowledgeEdgeSources.sourceId }).from(knowledgeEdgeSources)
      .where(eq(knowledgeEdgeSources.edgeId, edges[0]!.id));
    expect(evidence.map(({ id }) => id).sort()).toEqual([first.sourceId, second.sourceId].sort());
    const edgeId = edges[0]!.id;
    const visibleEdges = async () => {
      const graph = await inject({ url: `/api/servers/${serverId}/knowledge?channelId=${channelId}`, headers });
      expect(graph.statusCode).toBe(200);
      return graph.json<{ edges: { id: string }[] }>().edges.map(({ id }) => id);
    };
    await db.update(knowledgeEdges).set({ confidence: 90 }).where(eq(knowledgeEdges.id, edgeId));
    expect(await visibleEdges()).toContain(edgeId);
    await db.update(knowledgeEdges).set({ confidence: 89 }).where(eq(knowledgeEdges.id, edgeId));
    expect(await visibleEdges()).not.toContain(edgeId);
    await db.update(knowledgeEdges).set({ confidence: 100, hasConflict: true }).where(eq(knowledgeEdges.id, edgeId));
    expect(await visibleEdges()).not.toContain(edgeId);
    await db.update(knowledgeEdges).set({ hasConflict: false, method: "inferred" }).where(eq(knowledgeEdges.id, edgeId));
    expect(await visibleEdges()).not.toContain(edgeId);

    const other = await inject({
      method: "POST", url: "/api/servers", headers, payload: { name: "Separate knowledge workspace" },
    });
    const otherId = other.json<{ id: string }>().id;
    await expect(storeKnowledgeEvent({ ...event, serverId: otherId })).rejects.toThrow();
    expect(await db.select().from(knowledgeSources).where(eq(knowledgeSources.serverId, otherId))).toHaveLength(0);

    await db.delete(channels).where(eq(channels.id, channelId));
    expect(await db.select().from(knowledgeSources).where(eq(knowledgeSources.serverId, serverId))).toHaveLength(0);
    expect(await db.select().from(knowledgeEdgeSources).where(eq(knowledgeEdgeSources.edgeId, edges[0]!.id))).toHaveLength(0);
  }, 30_000);

  it("registers immutable manifests and limits approval to the host owner's declared capabilities", async () => {
    const headers = { cookie: `session=${sessionSecret}` };
    const workspace = await inject({
      method: "POST", url: "/api/servers", headers, payload: { name: "Extension test" },
    });
    const { id: serverId } = workspace.json<{ id: string }>();
    const directory = `/api/servers/${serverId}/extensions`;
    const manifest = {
      slug: "file-preview", name: "File Preview", version: "1.0.0", protocolVersion: 1,
      operatingSystems: ["linux"], capabilities: ["resource.read", "snapshot.create"],
      resources: [{ type: "document", extensions: [".txt"] }], snapshotFormat: "metadata-json",
    };
    expect((await inject({
      method: "POST", url: directory, headers, payload: { ...manifest, command: "undeclared" },
    })).statusCode).toBe(400);
    const registered = await inject({ method: "POST", url: directory, headers, payload: manifest });
    expect(registered.statusCode).toBe(201);
    const { id: manifestId } = registered.json<{ id: string }>();
    expect((await inject({ method: "POST", url: directory, headers, payload: manifest })).statusCode).toBe(409);
    expect((await inject({ url: directory, headers })).json()).toEqual([
      expect.objectContaining({ id: manifestId, manifest }),
    ]);

    const hostResponse = await inject({
      method: "POST", url: "/api/hosts", headers, payload: { machine: "Approved host" },
    });
    const { id: hostId } = hostResponse.json<{ id: string }>();
    const approvalPath = `/api/hosts/${hostId}/extensions/${manifestId}/approval`;
    const approvalsPath = `/api/hosts/${hostId}/extensions`;
    const [anotherUser] = await db.insert(users).values({ githubId: "extension-test-user", handle: "other" }).returning();
    if (!anotherUser) throw new Error("Could not create another user");
    const secret = randomBytes(32).toString("base64url");
    const otherHeaders = { cookie: `session=${secret}` };
    await db.insert(sessions).values({
      userId: anotherUser.id, secretHash: hashSecret(secret), expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await inject({
      method: "PUT", url: approvalPath, headers: otherHeaders, payload: { capabilities: ["resource.read"] },
    })).statusCode).toBe(404);
    expect((await inject({
      method: "PUT", url: approvalPath, headers, payload: { capabilities: ["resource.write"] },
    })).statusCode).toBe(400);
    expect((await inject({
      method: "PUT", url: approvalPath, headers, payload: { capabilities: ["resource.read"] },
    })).statusCode).toBe(200);
    expect((await inject({ url: approvalsPath, headers })).json()).toEqual([
      expect.objectContaining({ hostId, manifestId, approvedBy: userId, capabilities: ["resource.read"] }),
    ]);
    const revised = await inject({
      method: "POST", url: directory, headers, payload: { ...manifest, version: "2.0.0" },
    });
    expect(revised.statusCode).toBe(201);
    expect((await inject({ url: approvalsPath, headers })).json()).toHaveLength(1);
    expect((await inject({ method: "DELETE", url: approvalPath, headers })).statusCode).toBe(204);
    expect((await inject({ url: approvalsPath, headers })).json()).toEqual([]);
  }, 30_000);

  it("moves internal credits once per request and prevents concurrent overspending", async () => {
    const headers = { cookie: `session=${sessionSecret}` };
    const workspace = await inject({ method: "POST", url: "/api/servers", headers, payload: { name: "Credit ledger test" } });
    expect(workspace.statusCode).toBe(201);
    const { id: serverId } = workspace.json<{ id: string }>();
    const agent = await inject({
      method: "POST", url: `/api/servers/${serverId}/agents`, headers, payload: { name: "credit-agent" },
    });
    const host = await inject({ method: "POST", url: "/api/hosts", headers, payload: { machine: "credit host" } });
    expect(agent.statusCode).toBe(201);
    expect(host.statusCode).toBe(201);
    const agentAccount = { kind: "agent", id: agent.json<{ id: string }>().id };
    const hostAccount = { kind: "host", id: host.json<{ id: string }>().id };
    const url = `/api/servers/${serverId}/credits`;
    const grant = { requestId: randomUUID(), to: agentAccount, amount: 10, reason: "Pilot allocation" };
    expect((await inject({ method: "POST", url, payload: grant })).statusCode).toBe(401);
    const inserted = await inject({ method: "POST", url, headers, payload: grant });
    expect(inserted.statusCode).toBe(201);
    const replay = await inject({ method: "POST", url, headers, payload: grant });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(inserted.json());
    expect((await inject({ method: "POST", url, headers, payload: { ...grant, amount: 11 } })).statusCode).toBe(409);
    expect((await inject({
      method: "POST", url, headers, payload: { ...grant, requestId: randomUUID(), to: { kind: "host", id: randomUUID() } },
    })).statusCode).toBe(404);

    const transfers = await Promise.all([randomUUID(), randomUUID()].map((requestId) => inject({
      method: "POST", url, headers, payload: { requestId, from: agentAccount, to: hostAccount, amount: 7, reason: "Host allocation" },
    })));
    expect(transfers.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    const agentLedger = await inject({ url: `${url}?kind=agent&id=${agentAccount.id}`, headers });
    const hostLedger = await inject({ url: `${url}?kind=host&id=${hostAccount.id}`, headers });
    expect(agentLedger.json()).toMatchObject({ balance: "3", entries: expect.any(Array) });
    expect(hostLedger.json()).toMatchObject({ balance: "7", entries: expect.any(Array) });
    expect(agentLedger.json<{ entries: unknown[] }>().entries).toHaveLength(2);
    expect(hostLedger.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  }, 30_000);

  it("rotates host tokens and expires hosts that miss heartbeats", async () => {
    const cookie = `session=${sessionSecret}`;
    const hostResponse = await inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie },
      payload: { machine: "integration host" },
    });
    expect(hostResponse.statusCode).toBe(201);
    const createdHost = hostResponse.json<{ id: string; token: string }>();
    const storedBeforeRotation = await db.select().from(hosts).where(eq(hosts.id, createdHost.id)).limit(1);
    expect(storedBeforeRotation[0]?.tokenHash).toBe(hashSecret(createdHost.token));

    const rotationResponse = await inject({
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

    const revokeResponse = await inject({
      method: "DELETE",
      url: `/api/hosts/${createdHost.id}`,
      headers: { cookie },
    });
    expect(revokeResponse.statusCode).toBe(200);
    const rejectedRotation = await inject({
      method: "POST",
      url: `/api/hosts/${createdHost.id}/rotate`,
      headers: { cookie },
    });
    expect(rejectedRotation.statusCode).toBe(409);
  }, 30_000);
});
