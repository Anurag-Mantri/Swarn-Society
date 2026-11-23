import { randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app, expireStaleHosts, flushHostStatusUpdates } from "./index.js";
import { db, pool } from "./db/index.js";
import { channels, hosts, members, messages, sessions, users } from "./db/schema.js";
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

function nextWebSocketFrame(socket: WebSocket, matches: (frame: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a WebSocket frame"));
    }, 5000);
    const onMessage = (raw: RawData) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!matches(frame)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
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
    await pool.query("TRUNCATE TABLE agent_hosts, agents, messages, channels, member_roles, members, roles, hosts, sessions, servers, users CASCADE");
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
  });

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

    const membership = await db.select().from(members)
      .where(and(eq(members.serverId, server.id), eq(members.userId, userId)));
    expect(membership).toHaveLength(1);
    expect((await db.select().from(channels).where(eq(channels.id, channel.id))).length).toBe(1);
  });

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
    const channel = channelResponse.json<{ id: string }>();
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

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Could not read test server address");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const hostSocket = await connectWebSocket(url);
    const userSocket = await connectWebSocket(url);
    try {
      const registered = nextWebSocketFrame(hostSocket, (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "host.registered");
      hostSocket.send(JSON.stringify({
        t: "host",
        token: host.token,
        machine: "routing test host",
        agents: ["routing-agent"],
      }));
      expect(await registered).toMatchObject({ t: "host.registered", hostId: host.id });

      const initialized = nextWebSocketFrame(userSocket, (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "init");
      userSocket.send(JSON.stringify({ t: "hello", session: sessionSecret }));
      expect(await initialized).toMatchObject({ t: "init" });

      const task = nextWebSocketFrame(hostSocket, (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "task");
      userSocket.send(JSON.stringify({ t: "msg", channelId: channel.id, text: "@routing-agent inspect this" }));
      expect(await task).toMatchObject({
        t: "task",
        channelId: channel.id,
        agent: "routing-agent",
      });

      const reply = nextWebSocketFrame(userSocket, (frame) =>
        typeof frame === "object" && frame !== null && "t" in frame && frame.t === "msg" && "kind" in frame && frame.kind === "agent");
      userSocket.send(JSON.stringify({ t: "reply", channelId: channel.id, agent: "routing-agent", text: "completed" }));
      expect(await reply).toMatchObject({ t: "msg", text: "completed", from: "routing-agent", kind: "agent" });
    } finally {
      hostSocket.terminate();
      userSocket.terminate();
    }

    const history = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    const persistedMessages = history.json<Array<{ body: string; authorKind: string }>>();
    expect(persistedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorKind: "user", body: "@routing-agent inspect this" }),
      expect.objectContaining({ authorKind: "agent", body: "completed" }),
    ]));
  });

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
  });
});
