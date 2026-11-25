import { taskReputationInputSchema } from "@swarmroom/protocol";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, taskPosts, taskReputationReviews } from "../db/schema.js";
import { permissions } from "../permissions.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";

const taskPath = "/api/channels/:channelId/tasks/:taskId/reputation";

function reviewableTask(channelId: string, taskId: string) {
  return db.select({
    createdBy: taskPosts.createdBy, resolution: taskPosts.resolution, agentOwner: agents.ownerId,
  }).from(taskPosts).leftJoin(agents, eq(agents.id, taskPosts.claimedByAgentId))
    .where(and(eq(taskPosts.channelId, channelId), eq(taskPosts.id, taskId))).limit(1);
}

export const taskReputationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/channels/:channelId/tasks/reputation", async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    const stats = await db.select({
      agentId: agents.id,
      name: agents.name,
      reviewedTasks: sql<number>`count(*)::int`,
      helpful: sql<number>`(count(*) filter (where ${taskReputationReviews.feedback} = 'helpful'))::int`,
      needsWork: sql<number>`(count(*) filter (where ${taskReputationReviews.feedback} = 'needs_work'))::int`,
      testsPassed: sql<number>`(count(*) filter (where ${taskReputationReviews.tests} = 'passed'))::int`,
      testsFailed: sql<number>`(count(*) filter (where ${taskReputationReviews.tests} = 'failed'))::int`,
      mergedPullRequests: sql<number>`count(distinct ${taskReputationReviews.mergedPullRequest})::int`,
    }).from(taskReputationReviews).innerJoin(taskPosts, eq(taskPosts.id, taskReputationReviews.taskId))
      .innerJoin(agents, eq(agents.id, taskPosts.claimedByAgentId))
      .where(and(eq(taskPosts.channelId, access.channel.id), eq(agents.serverId, access.channel.serverId)))
      .groupBy(agents.id, agents.name).orderBy(agents.name, agents.id);
    return reply.header("Cache-Control", "no-store").send(stats);
  });

  app.get(taskPath, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid task ID." });
    const { taskId } = params.data;
    const [task] = await reviewableTask(access.channel.id, taskId);
    if (!task) return reply.code(404).send({ error: "Task not found in this channel." });
    if (task.createdBy !== access.user.id) return reply.code(403).send({ error: "Only the task author can read its individual review." });
    const [review] = await db.select().from(taskReputationReviews).where(eq(taskReputationReviews.taskId, taskId)).limit(1);
    return reply.header("Cache-Control", "no-store").send({
      canReview: task.resolution === "done" && !!task.agentOwner && task.agentOwner !== access.user.id &&
        await hasChannelPermission(access.channel, access.user.id, permissions.sendMessages),
      review: review ?? null,
    });
  });

  app.post(taskPath, { bodyLimit: 4096 }, async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.sendMessages);
    if (!access) return;
    const params = taskPostParams.safeParse(request.params);
    const body = taskReputationInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide a valid task ID and at least one review signal." });
    }
    const { taskId } = params.data;
    const [task] = await reviewableTask(access.channel.id, taskId);
    if (!task) return reply.code(404).send({ error: "Task not found in this channel." });
    if (task.createdBy !== access.user.id || task.agentOwner === access.user.id) {
      return reply.code(403).send({ error: "The task author can review work completed by another person's agent." });
    }
    if (task.resolution !== "done" || !task.agentOwner) {
      return reply.code(409).send({ error: "Complete the assigned task before reviewing its outcome." });
    }
    const reviewData = {
      taskId, reviewerId: access.user.id,
      feedback: body.data.feedback ?? null,
      tests: body.data.tests ?? null,
      mergedPullRequest: body.data.mergedPullRequest ?? null,
    };
    const [inserted] = await db.insert(taskReputationReviews).values(reviewData).onConflictDoNothing()
      .returning();
    if (inserted) return reply.code(201).header("Cache-Control", "no-store").send(inserted);
    const [existing] = await db.select().from(taskReputationReviews).where(eq(taskReputationReviews.taskId, taskId)).limit(1);
    if (existing?.reviewerId === reviewData.reviewerId && existing.feedback === reviewData.feedback &&
        existing.tests === reviewData.tests && existing.mergedPullRequest === reviewData.mergedPullRequest) {
      return reply.header("Cache-Control", "no-store").send(existing);
    }
    return reply.code(409).send({ error: "This task already has a different outcome review." });
  });
};
