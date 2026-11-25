import { knowledgeReviewSchema } from "@swarmroom/protocol";
import { and, desc, eq, not, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { knowledgeEdgeSources, knowledgeEdges, knowledgeNodes, knowledgeReviews, knowledgeSources } from "../db/knowledge-schema.js";
import { lockKnowledgeWorkspace } from "../knowledge/storage.js";
import {
  automaticEdge, edgeHasEvidence, edgeReview, readableEdgeEvidence, readableEndpoint, readableKnowledgeChannels,
} from "../knowledge/visibility.js";
import { permissions } from "../permissions.js";

const workspaceParams = z.object({ serverId: z.string().uuid().transform((id) => id.toLowerCase()) });
const reviewParams = workspaceParams.extend({ edgeId: z.string().min(1).max(200) });
const endpoint = "/api/servers/:serverId/knowledge/reviews";
const reviewPermission = permissions.readMessages | permissions.manageRoles;
const from = alias(knowledgeNodes, "from_node");
const to = alias(knowledgeNodes, "to_node");

function reviewVisibility(channelIds: string[]) {
  return and(
    edgeHasEvidence(), readableEdgeEvidence(channelIds),
    readableEndpoint(knowledgeEdges.fromId, channelIds), readableEndpoint(knowledgeEdges.toId, channelIds),
  );
}

export const knowledgeReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get(endpoint, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = workspaceParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    const { serverId } = params.data;
    if (!await hasServerPermission(serverId, user.id, reviewPermission)) {
      return reply.code(403).send({ error: "You cannot review knowledge in this workspace." });
    }
    const channelIds = await readableKnowledgeChannels(serverId, user.id);
    const queue = db.$with("review_queue").as(db.select().from(knowledgeEdges).where(and(
      eq(knowledgeEdges.serverId, serverId), not(automaticEdge), notExists(edgeReview()), reviewVisibility(channelIds),
    )).orderBy(knowledgeEdges.id).limit(25));
    const sources = db.select({
      id: knowledgeSources.id, channelId: knowledgeSources.channelId, type: knowledgeSources.type,
      sourceId: knowledgeSources.sourceId, method: knowledgeSources.method, occurredAt: knowledgeSources.occurredAt,
    }).from(knowledgeEdgeSources).innerJoin(knowledgeSources, and(
      eq(knowledgeSources.serverId, knowledgeEdgeSources.serverId), eq(knowledgeSources.id, knowledgeEdgeSources.sourceId),
    )).where(and(
      eq(knowledgeEdgeSources.serverId, queue.serverId), eq(knowledgeEdgeSources.edgeId, queue.id),
    )).orderBy(desc(knowledgeSources.occurredAt), desc(knowledgeSources.id)).limit(20).as("recent_evidence");
    const rows = await db.with(queue).select({
      id: queue.id, relation: queue.relation, confidence: queue.confidence,
      method: queue.method, hasConflict: queue.hasConflict,
      from: { kind: from.kind, key: from.key }, to: { kind: to.kind, key: to.key },
      source: {
        id: sources.id, channelId: sources.channelId, type: sources.type,
        sourceId: sources.sourceId, method: sources.method, occurredAt: sources.occurredAt,
      },
    }).from(queue)
      .innerJoin(from, and(eq(from.serverId, queue.serverId), eq(from.id, queue.fromId)))
      .innerJoin(to, and(eq(to.serverId, queue.serverId), eq(to.id, queue.toId)))
      .innerJoinLateral(sources, sql`true`)
      .orderBy(queue.id, desc(sources.occurredAt), desc(sources.id));

    const candidates = new Map<string, Omit<(typeof rows)[number], "source"> & { sources: (typeof rows)[number]["source"][] }>();
    for (const { source, ...edge } of rows) {
      const candidate = candidates.get(edge.id);
      if (candidate) candidate.sources.push(source);
      else candidates.set(edge.id, { ...edge, sources: [source] });
    }
    return reply.header("Cache-Control", "no-store").send([...candidates.values()]);
  });

  app.post(`${endpoint}/:edgeId`, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = reviewParams.safeParse(request.params);
    const body = knowledgeReviewSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Provide a valid edge, decision, and reason." });
    const { serverId, edgeId } = params.data;
    if (!await hasServerPermission(serverId, user.id, reviewPermission)) {
      return reply.code(403).send({ error: "You cannot review knowledge in this workspace." });
    }
    const result = await db.transaction(async (transaction) => {
      await lockKnowledgeWorkspace(transaction, serverId, "exclusive");
      if (!await hasServerPermission(serverId, user.id, reviewPermission, transaction)) return { status: 403 } as const;
      const channelIds = await readableKnowledgeChannels(serverId, user.id, transaction);
      const [edge] = await transaction.select({ automatic: automaticEdge.as("automatic") }).from(knowledgeEdges).where(and(
        eq(knowledgeEdges.serverId, serverId), eq(knowledgeEdges.id, edgeId), reviewVisibility(channelIds),
      )).for("update");
      if (!edge) return { status: 404 } as const;
      const [previous] = await transaction.select().from(knowledgeReviews)
        .where(and(eq(knowledgeReviews.serverId, serverId), eq(knowledgeReviews.edgeId, edgeId))).limit(1);
      if (previous) {
        if (previous.reviewerId === user.id && previous.decision === body.data.decision && previous.reason === body.data.reason) {
          return { status: 200, review: previous } as const;
        }
        return { status: 409 } as const;
      }
      if (edge.automatic) return { status: 409 } as const;
      const [review] = await transaction.insert(knowledgeReviews)
        .values({ serverId, edgeId, reviewerId: user.id, ...body.data }).returning();
      return { status: 201, review } as const;
    });
    switch (result.status) {
      case 403: return reply.code(403).send({ error: "You cannot review knowledge in this workspace." });
      case 404: return reply.code(404).send({ error: "This relationship is unavailable for review." });
      case 409: return reply.code(409).send({ error: "This relationship no longer needs a review. Refresh the queue." });
      default: return reply.code(result.status).header("Cache-Control", "no-store").send(result.review);
    }
  });
};
