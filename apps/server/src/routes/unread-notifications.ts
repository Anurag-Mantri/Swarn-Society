import { markChannelReadSchema } from "@swarmroom/protocol";
import { and, desc, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission, hasServerPermission, readableChannelIds } from "../channel-access.js";
import { db } from "../db/index.js";
import { channelReadCursors, channels, messages } from "../db/schema.js";
import { permissions } from "../permissions.js";

const serverParams = z.object({ serverId: z.string().uuid() });
const channelParams = z.object({ channelId: z.string().uuid() });

export const unreadNotificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers/:serverId/unread", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = serverParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    const { serverId } = params.data;
    if (!await hasServerPermission(serverId, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot see notifications in this workspace." });
    }
    const readable = await readableChannelIds(serverId, user.id);
    if (!readable.length) return reply.send([]);

    const unread = db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.channelId, channels.id), isNull(messages.threadId),
      not(and(eq(messages.authorKind, "user"), eq(messages.authorId, user.id))!),
      or(isNull(channelReadCursors.readId), sql`
        (${messages.createdAt}, ${messages.id}) > (${channelReadCursors.readAt}, ${channelReadCursors.readId})
      `),
    )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(100).as("unread");
    const counts = await db.select({ channelId: channels.id, count: sql<number>`count(*)::int` }).from(channels)
      .leftJoin(channelReadCursors, and(
        eq(channelReadCursors.channelId, channels.id), eq(channelReadCursors.userId, user.id),
      )).innerJoinLateral(unread, sql`true`)
      .where(and(eq(channels.serverId, serverId), inArray(channels.id, readable))).groupBy(channels.id).orderBy(channels.id);
    return reply.send(counts);
  });

  app.post("/api/channels/:channelId/read", { bodyLimit: 4096 }, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = channelParams.safeParse(request.params);
    const body = markChannelReadSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide valid channel and message IDs." });
    }
    const { channelId } = params.data;
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels)
      .where(eq(channels.id, channelId)).limit(1);
    if (!channel || !await hasChannelPermission(channel, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot mark this channel read." });
    }
    const result = await db.execute<{ found: boolean }>(sql`
      with target_message as (
        select ${messages.createdAt} as read_at, ${messages.id} as read_id from ${messages}
        where ${messages.channelId} = ${channelId} and ${messages.id} = ${body.data.messageId}
          and ${messages.threadId} is null
      ), moved as (
        insert into ${channelReadCursors} (channel_id, user_id, read_at, read_id)
        select ${channelId}::uuid, ${user.id}::uuid, read_at, read_id from target_message
        on conflict (channel_id, user_id) do update set read_at = excluded.read_at, read_id = excluded.read_id
        where (${channelReadCursors.readAt}, ${channelReadCursors.readId}) < (excluded.read_at, excluded.read_id)
      )
      select exists (select 1 from target_message) as found
    `);
    if (!result.rows[0]?.found) return reply.code(404).send({ error: "That message is unavailable in this channel." });
    return reply.header("Cache-Control", "no-store").send({ ok: true });
  });
};
