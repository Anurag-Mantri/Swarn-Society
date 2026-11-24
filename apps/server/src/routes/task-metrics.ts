import { and, eq, gte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { taskCoordinationDaily, taskPosts } from "../db/schema.js";
import { permissions } from "../permissions.js";
import { taskChannel } from "../task-channel-access.js";

const querySchema = z.object({ days: z.enum(["7", "30", "90"]).default("30").transform(Number) });

export const taskMetricsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/channels/:channelId/tasks/metrics", async (request, reply) => {
    const access = await taskChannel(request, reply, permissions.readMessages);
    if (!access) return;
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Select a 7, 30, or 90 day window." });
    const { days } = query.data;
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(today) - (days - 1) * 86_400_000);
    const fromDay = from.toISOString().slice(0, 10);
    const channelId = access.channel.id;

    const [[tasks], [conflicts]] = await Promise.all([
      db.select({
        posted: sql<number>`count(*)::int`,
        open: sql<number>`(count(*) filter (where ${taskPosts.resolution} is null and ${taskPosts.claimedByAgentId} is null))::int`,
        inProgress: sql<number>`(count(*) filter (where ${taskPosts.resolution} is null and ${taskPosts.claimedByAgentId} is not null))::int`,
        completed: sql<number>`(count(*) filter (where ${taskPosts.resolution} = 'done'))::int`,
        cancelled: sql<number>`(count(*) filter (where ${taskPosts.resolution} = 'cancelled'))::int`,
        meanCompletionSeconds: sql<number | null>`round(avg(extract(epoch from (${taskPosts.resolvedAt} - ${taskPosts.createdAt})))
          filter (where ${taskPosts.resolution} = 'done'))::int`,
      }).from(taskPosts).where(and(eq(taskPosts.channelId, channelId), gte(taskPosts.createdAt, from))),
      db.select({
        duplicateIntentAttempts: sql<number>`coalesce(sum(${taskCoordinationDaily.duplicateIntentAttempts}), 0)::int`,
        busyAgentAttempts: sql<number>`coalesce(sum(${taskCoordinationDaily.busyAgentAttempts}), 0)::int`,
        competingClaimAttempts: sql<number>`coalesce(sum(${taskCoordinationDaily.competingClaimAttempts}), 0)::int`,
      }).from(taskCoordinationDaily).where(and(
        eq(taskCoordinationDaily.channelId, channelId), gte(taskCoordinationDaily.day, fromDay),
      )),
    ]);
    return reply.send({ days, from: fromDay, through: today, ...tasks, ...conflicts });
  });
};
