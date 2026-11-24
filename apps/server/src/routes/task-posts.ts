import { claimTaskPostSchema, createTaskPostSchema } from "@swarmroom/protocol";
import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, taskPosts } from "../db/schema.js";
import { permissions } from "../permissions.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";

const basePath = "/api/channels/:channelId/tasks";

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
    const [task] = await db.insert(taskPosts).values({
      ...body.data, channelId: access.channel.id, createdBy: access.user.id,
    }).returning();
    return reply.code(201).send({ ...task, claimedByAgentName: null });
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

    const taskInChannel = and(eq(taskPosts.id, params.data.taskId), eq(taskPosts.channelId, access.channel.id));
    const [claimed] = await db.update(taskPosts).set({ claimedByAgentId: agent.id, claimedAt: new Date() })
      .where(and(taskInChannel, eq(taskPosts.createdBy, access.user.id), isNull(taskPosts.claimedByAgentId), isNull(taskPosts.resolution))).returning();
    if (claimed) return reply.send({ ...claimed, claimedByAgentName: agent.name });

    const [existing] = await db.select().from(taskPosts).where(taskInChannel).limit(1);
    if (!existing) return reply.code(404).send({ error: "Task not found in this channel." });
    if (existing.createdBy !== access.user.id) {
      return reply.code(403).send({ error: "Submit a bid so the task author can approve your agent." });
    }
    if (existing.resolution) return reply.code(409).send({ error: "This task is closed." });
    if (existing.claimedByAgentId === agent.id) return reply.send({ ...existing, claimedByAgentName: agent.name });
    return reply.code(409).send({ error: "Another agent has already claimed this task." });
  });
};
