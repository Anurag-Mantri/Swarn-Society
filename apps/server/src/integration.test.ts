import { randomBytes } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { db, pool } from "./db/index.js";
import { channels, members, messages, sessions, users } from "./db/schema.js";
import { hashSecret } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

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
    await pool.end();
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

    const outsider = await db.insert(users).values({ githubId: "integration-outsider", handle: "outsider" }).returning();
    const outsiderSecret = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({
      userId: outsider[0]!.id,
      secretHash: hashSecret(outsiderSecret),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const outsiderHistory = await app.inject({
      method: "GET",
      url: `/api/channels/${channel.id}/messages`,
      headers: { cookie: `session=${outsiderSecret}` },
    });
    expect(outsiderHistory.statusCode).toBe(403);

    const membership = await db.select().from(members)
      .where(and(eq(members.serverId, server.id), eq(members.userId, userId)));
    expect(membership).toHaveLength(1);
    expect((await db.select().from(channels).where(eq(channels.id, channel.id))).length).toBe(1);
  });
});
