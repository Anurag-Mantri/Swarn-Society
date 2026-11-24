import { claimTaskPostSchema, createTaskPostSchema } from "@swarmroom/protocol";
import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, channels, taskPosts } from "../db/schema.js";
import { permissions } from "../permissions.js";

const uuid = z.string().uuid();
const channelParams = z.object({ channelId: uuid });
const taskParams = channelParams.extend({ taskId: uuid });
const basePath = "/api/channels/:channelId/tasks";

async function taskChannel(request: FastifyRequest, reply: FastifyReply, requiredPermission: number) {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = channelParams.safeParse(request.params);
  if (!params.success) {
    await reply.code(400).send({ error: "Provide a valid task channel ID." });
    return;
  }
  const [channel] = await db.select().from(channels)
    .where(and(eq(channels.id, params.data.channelId), eq(channels.kind, "task"))).limit(1);
  if (!channel) {
    await reply.code(404).send({ error: "Task channel not found." });
    return;
  }
  if (!await hasChannelPermission(channel, user.id, requiredPermission)) {
    await reply.code(403).send({ error: "You do not have permission for this action in the task channel." });
    return;
  }
  return { channel, user };
}

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
    const params = taskParams.safeParse(request.params);
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
      .where(and(taskInChannel, isNull(taskPosts.claimedByAgentId))).returning();
    if (claimed) return reply.send({ ...claimed, claimedByAgentName: agent.name });

    const [existing] = await db.select().from(taskPosts).where(taskInChannel).limit(1);
    if (!existing) return reply.code(404).send({ error: "Task not found in this channel." });
    if (existing.claimedByAgentId === agent.id) return reply.send({ ...existing, claimedByAgentName: agent.name });
    return reply.code(409).send({ error: "Another agent has already claimed this task." });
  });
};
