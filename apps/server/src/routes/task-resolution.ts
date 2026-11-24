import { resolveTaskPostSchema } from "@swarmroom/protocol";
import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/index.js";
import { agents, taskPosts } from "../db/schema.js";
import { recordKnowledgeEvent } from "../knowledge/storage.js";
import { permissions } from "../permissions.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";

export const taskResolutionRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/channels/:channelId/tasks/:taskId/resolve", async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.sendMessages);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    const body = resolveTaskPostSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide a task ID, a resolution, and optional result text." });
    }
    const { resolution, result } = body.data;
    const taskInChannel = and(eq(taskPosts.id, params.data.taskId), eq(taskPosts.channelId, access.channel.id));
    const [task] = await db.select({
      ...getTableColumns(taskPosts), claimedByAgentName: agents.name, agentOwnerId: agents.ownerId,
    }).from(taskPosts).leftJoin(agents, eq(agents.id, taskPosts.claimedByAgentId)).where(taskInChannel).limit(1);
    if (!task) return reply.code(404).send({ error: "Task not found in this channel." });

    const { agentOwnerId, claimedByAgentName, ...record } = task;
    const isAuthor = task.createdBy === access.user.id;
    if (!isAuthor && (resolution !== "done" || agentOwnerId !== access.user.id)) {
      return reply.code(403).send({ error: "Only the task author or the assigned agent owner can complete the task. Only the author can cancel it." });
    }
    if (task.resolution === resolution) return reply.send({ ...record, claimedByAgentName });
    if (task.resolution) return reply.code(409).send({ error: "This task has already been resolved." });
    if (resolution === "done" && !task.claimedByAgentId) {
      return reply.code(409).send({ error: "Assign an agent before completing the task." });
    }

    const updated = await db.transaction(async (transaction) => {
      const resolvedAt = new Date();
      const [resolved] = await transaction.update(taskPosts).set({
        resolution, result, resolvedAt, resolvedBy: access.user.id,
      }).where(and(taskInChannel, isNull(taskPosts.resolution))).returning();
      if (resolved?.resolution === "done" && resolved.claimedByAgentId) {
        await recordKnowledgeEvent(transaction, {
          type: "task.completed", sourceId: resolved.id, occurredAt: resolvedAt.toISOString(),
          serverId: access.channel.serverId, channelId: access.channel.id, taskId: resolved.id,
          agentId: resolved.claimedByAgentId, resolvedBy: access.user.id,
        });
      }
      return resolved;
    });
    if (!updated) return reply.code(409).send({ error: "This task has already been resolved." });

    // A claim may have committed between the initial read and resolution.
    const [assigned] = updated.claimedByAgentId ? await db.select({ name: agents.name }).from(agents)
      .where(eq(agents.id, updated.claimedByAgentId)).limit(1) : [];
    return reply.send({ ...updated, claimedByAgentName: assigned?.name ?? null });
  });
};
