import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { channels, messages } from "../db/schema.js";
import { threadRootExists } from "../message-threads.js";
import { permissions } from "../permissions.js";

const historyParams = z.object({ channelId: z.string().uuid() });
const historyQuery = z.object({ threadId: z.string().uuid().optional() });

export const messageHistoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/channels/:channelId/messages", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = historyParams.safeParse(request.params);
    const query = historyQuery.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Provide valid channel and thread IDs." });
    }
    const { channelId } = params.data;
    const { threadId } = query.data;
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    if (!await hasChannelPermission(channel, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "Not allowed to read channel messages" });
    }
    if (threadId && !await threadRootExists(channelId, threadId)) {
      return reply.code(404).send({ error: "Thread root not found in this channel" });
    }
    const rows = await db.select().from(messages).where(and(
      eq(messages.channelId, channelId),
      threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
    )).orderBy(desc(messages.createdAt), desc(messages.id)).limit(100);
    return reply.send(rows.reverse());
  });
};
