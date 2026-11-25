import { knowledgeExtractionInputSchema, knowledgeProposalFileSchema } from "@swarmroom/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission, hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { channels, messages, taskPosts } from "../db/schema.js";
import { KnowledgeSourceConflictError, recordKnowledgeEvent } from "../knowledge/storage.js";
import { permissions } from "../permissions.js";

const paramsSchema = z.object({ channelId: z.string().uuid().transform((id) => id.toLowerCase()) });
const querySchema = z.object({ messageId: z.string().uuid() }).strict();
const basePath = "/api/channels/:channelId/knowledge";

async function getChannel(channelId: string, userId: string) {
  const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.kind, "task"))).limit(1);
  if (!channel ||
      !await hasServerPermission(channel.serverId, userId, permissions.manageRoles) ||
      !await hasChannelPermission(channel, userId, permissions.readMessages)) return null;
  return channel;
}

export const knowledgeProposalRoutes: FastifyPluginAsync = async (app) => {
  app.get(`${basePath}/extraction-input`, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Provide a valid channel and message ID." });
    const channel = await getChannel(params.data.channelId, user.id);
    if (!channel) return reply.code(403).send({ error: "You cannot export extraction input for this task channel." });

    const [message] = await db.select({ id: messages.id, body: messages.body }).from(messages)
      .where(and(eq(messages.id, query.data.messageId), eq(messages.channelId, channel.id))).limit(1);
    if (!message) return reply.code(404).send({ error: "Message is unavailable in this channel." });
    const tasks = await db.select({ id: taskPosts.id, title: taskPosts.title }).from(taskPosts)
      .where(eq(taskPosts.channelId, channel.id)).orderBy(desc(taskPosts.createdAt), taskPosts.id).limit(8);
    if (!tasks.length) return reply.code(409).send({ error: "Post a task in this channel before exporting extraction input." });
    const input = knowledgeExtractionInputSchema.safeParse({
      serverId: channel.serverId, channelId: channel.id, messageId: message.id,
      excerpt: message.body.slice(0, 1800), tasks: tasks.map(({ id, title }) => ({ id, title: title.slice(0, 120) })),
    });
    if (!input.success) return reply.code(422).send({ error: "This extraction input contains a blocked credential pattern." });
    return reply.header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="swarmroom-extraction-${message.id}.json"`)
      .send(input.data);
  });

  app.post(`${basePath}/proposals`, { bodyLimit: 4096 }, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = paramsSchema.safeParse(request.params);
    const body = knowledgeProposalFileSchema.safeParse(request.body);
    if (!params.success || !body.success || body.data.channelId !== params.data.channelId || !body.data.references.length) {
      return reply.code(400).send({ error: "Provide a proposal with at least one task reference for this channel." });
    }
    const channel = await getChannel(params.data.channelId, user.id);
    if (!channel || channel.serverId !== body.data.serverId) {
      return reply.code(403).send({ error: "You cannot import knowledge proposals for this task channel." });
    }

    const { messageId, references } = body.data;
    try {
      const result = await db.transaction(async (transaction) => {
        const [message] = await transaction.select({ at: messages.createdAt }).from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.channelId, channel.id))).limit(1);
        const taskIds = await transaction.select({ id: taskPosts.id }).from(taskPosts)
          .where(and(eq(taskPosts.channelId, channel.id), inArray(taskPosts.id, references.map(({ taskId }) => taskId))));
        if (!message || taskIds.length !== references.length) return null;
        let inserted = 0;
        references.sort((one, two) => one.taskId.localeCompare(two.taskId));
        for (const { taskId, confidence } of references) {
          const result = await recordKnowledgeEvent(transaction, {
            type: "task.reference.proposed", sourceId: `${messageId}:${taskId}`,
            serverId: channel.serverId, channelId: channel.id, occurredAt: message.at.toISOString(),
            messageId, taskId, confidence, proposedBy: user.id,
          });
          if (result.inserted) inserted += 1;
        }
        return { inserted };
      });
      if (!result) return reply.code(404).send({ error: "The message and tasks must all be in this channel." });
      return reply.code(result.inserted ? 201 : 200).header("Cache-Control", "no-store").send(result);
    } catch (problem) {
      if (problem instanceof KnowledgeSourceConflictError) {
        return reply.code(409).send({ error: "A proposed relationship already exists with different metadata." });
      }
      throw problem;
    }
  });
};
