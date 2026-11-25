import { claimTaskPostSchema, createTaskPostSchema, maximumTaskDelegationDepth } from "@swarmroom/protocol";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, taskPosts } from "../db/schema.js";
import { recordKnowledgeEvent } from "../knowledge/storage.js";
import { permissions } from "../permissions.js";
import { assignTask } from "../task-assignment.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";

const basePath = "/api/channels/:channelId/tasks";
type CreateTaskResult = { task: typeof taskPosts.$inferSelect } | { status: 403 | 404 | 409; error: string };

export const taskPostRoutes: FastifyPluginAsync = async (app) => {
  app.get(basePath, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    const rows = await db.select({ ...getTableColumns(taskPosts), claimedByAgentName: agents.name })
      .from(taskPosts).leftJoin(agents, eq(agents.id, taskPosts.claimedByAgentId))
      .where(eq(taskPosts.channelId, access.channel.id))
      .orderBy(desc(taskPosts.createdAt), desc(taskPosts.id)).limit(100);
    return reply.send(rows);
  });

  app.post(basePath, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.sendMessages);
    if (!access) return;
    const body = createTaskPostSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Provide a task title and a description of up to 4,000 characters." });
    const result = await db.transaction<CreateTaskResult>(async (transaction) => {
      let parentTaskId: string | null = null;
      let delegationDepth = 0;
      if (body.data.parentTaskId) {
        const [parent] = await transaction.select({
          id: taskPosts.id, authorId: taskPosts.createdBy, resolution: taskPosts.resolution,
          depth: taskPosts.delegationDepth, agentOwner: agents.ownerId,
        }).from(taskPosts).leftJoin(agents, eq(agents.id, taskPosts.claimedByAgentId))
          .where(and(eq(taskPosts.channelId, access.channel.id), eq(taskPosts.id, body.data.parentTaskId)))
          .for("update", { of: taskPosts });
        if (!parent) return { status: 404, error: "Parent task not found in this channel." };
        if (parent.authorId !== access.user.id && parent.agentOwner !== access.user.id) {
          return { status: 403, error: "Only the parent task author or assigned agent owner can delegate a subtask." };
        }
        if (parent.resolution) return { status: 409, error: "Delegate from an open task." };
        if (parent.depth >= maximumTaskDelegationDepth) {
          return { status: 409, error: "This task has reached the delegation depth limit." };
        }
        parentTaskId = parent.id;
        delegationDepth = parent.depth + 1;
      }
      const [created] = await transaction.insert(taskPosts).values({
        title: body.data.title, description: body.data.description,
        intent: sql`lower(regexp_replace(btrim(${body.data.intent ?? body.data.title}), '[[:space:]]+', ' ', 'g'))`,
        channelId: access.channel.id, createdBy: access.user.id, parentTaskId, delegationDepth,
      }).returning();
      if (!created) throw new Error("Task insert did not return an ID");
      await recordKnowledgeEvent(transaction, {
        type: "task.posted", sourceId: created.id, occurredAt: created.createdAt.toISOString(),
        serverId: access.channel.serverId, channelId: access.channel.id, taskId: created.id, authorId: access.user.id,
      });
      return { task: created };
    });
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ ...result.task, claimedByAgentName: null });
  });

  app.get(`${basePath}/claimants`, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    if (!await hasChannelPermission(access.channel, access.user.id, permissions.invokeAgents)) return reply.send([]);
    const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
      eq(agents.serverId, access.channel.serverId), eq(agents.ownerId, access.user.id),
    )).orderBy(agents.name, agents.id);
    return reply.send(rows);
  });

  app.post(`${basePath}/:taskId/claim`, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.invokeAgents);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    const body = claimTaskPostSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide valid task and agent IDs." });
    }
    const [agent] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
      eq(agents.id, body.data.agentId),
      eq(agents.serverId, access.channel.serverId),
      eq(agents.ownerId, access.user.id),
    )).limit(1);
    if (!agent) return reply.code(403).send({ error: "Choose one of your agents in this workspace." });

    const result = await assignTask({
      channelId: access.channel.id,
      serverId: access.channel.serverId,
      taskId: params.data.taskId,
      agentId: agent.id,
      actorId: access.user.id,
    });
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    return reply.send({ ...result.task, claimedByAgentName: agent.name });
  });
};
