import { createTaskBidSchema } from "@swarmroom/protocol";
import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, taskBids, taskPosts } from "../db/schema.js";
import { permissions } from "../permissions.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";

const basePath = "/api/channels/:channelId/tasks/:taskId/bids";
const approvalParams = taskPostParams.extend({ bidId: z.string().uuid() });

export const taskBidRoutes: FastifyPluginAsync = async (app) => {
  app.get(basePath, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid task ID." });
    const rows = await db.select({ ...getTableColumns(taskBids), agentName: agents.name })
      .from(taskBids).innerJoin(taskPosts, eq(taskBids.taskId, taskPosts.id))
      .innerJoin(agents, eq(agents.id, taskBids.agentId)).where(and(
        eq(taskPosts.id, params.data.taskId), eq(taskPosts.channelId, access.channel.id),
      )).orderBy(taskBids.createdAt, taskBids.id).limit(100);
    return reply.send(rows);
  });

  app.post(basePath, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.invokeAgents);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    const body = createTaskBidSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Provide an agent, work plan, and deliverable." });
    const [agent] = await db.select({ name: agents.name }).from(agents).where(and(
      eq(agents.id, body.data.agentId), eq(agents.serverId, access.channel.serverId), eq(agents.ownerId, access.user.id),
    )).limit(1);
    if (!agent) return reply.code(403).send({ error: "Choose one of your agents in this workspace." });

    const result = await db.transaction(async (transaction) => {
      const [task] = await transaction.select().from(taskPosts).where(and(
        eq(taskPosts.id, params.data.taskId), eq(taskPosts.channelId, access.channel.id),
      )).for("update");
      if (!task) return { status: 404, error: "Task not found in this channel." } as const;
      if (task.claimedByAgentId) return { status: 409, error: "This task already has a claim." } as const;
      const [bid] = await transaction.insert(taskBids).values({
        ...body.data, taskId: task.id, proposedBy: access.user.id,
      }).onConflictDoNothing({ target: [taskBids.taskId, taskBids.agentId] }).returning();
      if (!bid) return { status: 409, error: "This agent already submitted a bid." } as const;
      return { status: 201, bid: { ...bid, agentName: agent.name } } as const;
    });
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send(result.bid);
  });

  app.post(`${basePath}/:bidId/approve`, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.sendMessages | permissions.invokeAgents);
    if (!access) return;
    const params = approvalParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide valid task and bid IDs." });
    const { taskId, bidId } = params.data;
    const [bid] = await db.select({
      agentId: taskBids.agentId, agentName: agents.name, proposedBy: taskBids.proposedBy, ownerId: agents.ownerId,
      createdBy: taskPosts.createdBy,
    }).from(taskBids).innerJoin(taskPosts, eq(taskPosts.id, taskBids.taskId))
      .innerJoin(agents, eq(agents.id, taskBids.agentId)).where(and(
        eq(taskBids.id, bidId), eq(taskPosts.id, taskId),
        eq(taskPosts.channelId, access.channel.id), eq(agents.serverId, access.channel.serverId),
      )).limit(1);
    if (!bid) return reply.code(404).send({ error: "Bid not found for this task." });
    if (bid.createdBy !== access.user.id) return reply.code(403).send({ error: "Only the task author can approve a bid." });
    if (bid.proposedBy !== bid.ownerId ||
        !await hasChannelPermission(access.channel, bid.proposedBy, permissions.invokeAgents)) {
      return reply.code(409).send({ error: "This agent owner can no longer claim tasks in this channel." });
    }

    const result = await db.transaction(async (transaction) => {
      const approvedAt = new Date();
      const [claimed] = await transaction.update(taskPosts).set({ claimedByAgentId: bid.agentId, claimedAt: approvedAt })
        .where(and(eq(taskPosts.id, taskId), isNull(taskPosts.claimedByAgentId))).returning();
      if (!claimed) {
        const [approved] = await transaction.select({ approvedBy: taskBids.approvedBy })
          .from(taskBids).where(eq(taskBids.id, bidId)).limit(1);
        if (approved?.approvedBy !== access.user.id) return undefined;
        const [existing] = await transaction.select().from(taskPosts).where(eq(taskPosts.id, taskId)).limit(1);
        return existing;
      }
      const [approved] = await transaction.update(taskBids).set({ approvedAt, approvedBy: access.user.id })
        .where(eq(taskBids.id, bidId)).returning({ id: taskBids.id });
      if (!approved) throw new Error("The approved bid did not exist");
      return claimed;
    });
    if (!result) return reply.code(409).send({ error: "Another claim was accepted for this task." });
    return reply.send({ ...result, claimedByAgentName: bid.agentName });
  });
};
