import { and, desc, eq, exists, inArray, notExists, or } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import {
  knowledgeEdgeSources, knowledgeEdges, knowledgeNodeSources, knowledgeNodes, knowledgeSources,
} from "../db/knowledge-schema.js";
import { automaticEdge, edgeReview, minimumConfidence, readableEdgeEvidence, readableKnowledgeChannels, readableSource } from "../knowledge/visibility.js";
import { permissions } from "../permissions.js";

const paramsSchema = z.object({ serverId: z.string().uuid() });
const querySchema = z.object({ channelId: z.string().uuid().optional() });

function groupSources<T extends { id: string; sourceId: string }>(rows: T[]) {
  const grouped = new Map<string, Omit<T, "sourceId"> & { sourceIds: string[] }>();
  for (const { sourceId, ...fact } of rows) {
    const previous = grouped.get(fact.id);
    if (previous) previous.sourceIds.push(sourceId);
    else grouped.set(fact.id, { ...fact, sourceIds: [sourceId] });
  }
  return [...grouped.values()];
}

export const knowledgeOverviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers/:serverId/knowledge", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Provide valid workspace and channel IDs." });
    const { serverId } = params.data;
    const { channelId } = query.data;
    if (!await hasServerPermission(serverId, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot view knowledge in this workspace." });
    }

    const allowed = await readableKnowledgeChannels(serverId, user.id);
    if (channelId && !allowed.includes(channelId)) {
      return reply.code(403).send({ error: "You cannot view knowledge in this channel." });
    }
    const scope = channelId ? eq(knowledgeSources.channelId, channelId) : readableSource(allowed);

    const sources = await db.select({
      id: knowledgeSources.id,
      channelId: knowledgeSources.channelId,
      type: knowledgeSources.type,
      sourceId: knowledgeSources.sourceId,
      method: knowledgeSources.method,
      occurredAt: knowledgeSources.occurredAt,
    }).from(knowledgeSources).where(and(eq(knowledgeSources.serverId, serverId), scope))
      .orderBy(desc(knowledgeSources.occurredAt), desc(knowledgeSources.id)).limit(20);
    reply.header("Cache-Control", "no-store");
    if (sources.length === 0) return reply.send({ sources, nodes: [], edges: [] });

    const sourceIds = sources.map(({ id }) => id);
    const [linkedNodes, linkedEdges] = await Promise.all([
      db.select({
        id: knowledgeNodes.id,
        kind: knowledgeNodes.kind,
        key: knowledgeNodes.key,
        confidence: knowledgeNodes.confidence,
        sourceId: knowledgeNodeSources.sourceId,
      }).from(knowledgeNodes).innerJoin(knowledgeNodeSources, and(
        eq(knowledgeNodeSources.serverId, knowledgeNodes.serverId), eq(knowledgeNodeSources.nodeId, knowledgeNodes.id),
      )).where(and(
        eq(knowledgeNodes.serverId, serverId),
        inArray(knowledgeNodeSources.sourceId, sourceIds),
      )).orderBy(knowledgeNodes.kind, knowledgeNodes.id, knowledgeNodeSources.sourceId),
      db.select({
        id: knowledgeEdges.id,
        fromId: knowledgeEdges.fromId,
        toId: knowledgeEdges.toId,
        relation: knowledgeEdges.relation,
        confidence: knowledgeEdges.confidence,
        sourceId: knowledgeEdgeSources.sourceId,
      }).from(knowledgeEdges).innerJoin(knowledgeEdgeSources, and(
        eq(knowledgeEdgeSources.serverId, knowledgeEdges.serverId), eq(knowledgeEdgeSources.edgeId, knowledgeEdges.id),
      )).where(and(
        eq(knowledgeEdges.serverId, serverId),
        notExists(edgeReview("rejected")),
        or(
          and(automaticEdge, notExists(edgeReview())),
          and(exists(edgeReview("approved")), readableEdgeEvidence(allowed)),
        ),
        inArray(knowledgeEdgeSources.sourceId, sourceIds),
      )).orderBy(knowledgeEdges.relation, knowledgeEdges.id, knowledgeEdgeSources.sourceId),
    ]);
    const nodes = groupSources(linkedNodes);
    const availableNodes = new Set(nodes.map(({ id }) => id));
    const edges = groupSources(linkedEdges).filter(({ fromId, toId }) => availableNodes.has(fromId) && availableNodes.has(toId));
    const connected = new Set(edges.flatMap(({ fromId, toId }) => [fromId, toId]));
    return reply.send({
      sources,
      nodes: nodes.filter(({ confidence, id }) => confidence >= minimumConfidence || connected.has(id)),
      edges,
    });
  });
};
