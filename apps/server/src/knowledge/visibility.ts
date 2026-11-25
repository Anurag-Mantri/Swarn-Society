import { and, eq, exists, gte, inArray, isNull, not, notExists, or } from "drizzle-orm";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { knowledgeEdgeSources, knowledgeEdges, knowledgeNodeSources, knowledgeReviews, knowledgeSources } from "../db/knowledge-schema.js";
import { channels } from "../db/schema.js";
import { permissions } from "../permissions.js";

export const minimumConfidence = 90;
export const automaticEdge = and(
  eq(knowledgeEdges.method, "deterministic"),
  eq(knowledgeEdges.hasConflict, false),
  gte(knowledgeEdges.confidence, minimumConfidence),
)!;

export async function readableKnowledgeChannels(serverId: string, userId: string, database: Pick<typeof db, "select"> = db) {
  const candidates = await database.select({ id: channels.id, serverId: channels.serverId }).from(channels)
    .where(eq(channels.serverId, serverId));
  const allowed: string[] = [];
  for (const channel of candidates) {
    if (await hasChannelPermission(channel, userId, permissions.readMessages, database)) allowed.push(channel.id);
  }
  return allowed;
}

export function readableSource(channelIds: string[]) {
  const workspaceSource = isNull(knowledgeSources.channelId);
  return channelIds.length ? or(workspaceSource, inArray(knowledgeSources.channelId, channelIds))! : workspaceSource;
}

export function edgeReview(decision?: "approved" | "rejected") {
  return db.select({ id: knowledgeReviews.id }).from(knowledgeReviews).where(and(
    eq(knowledgeReviews.serverId, knowledgeEdges.serverId), eq(knowledgeReviews.edgeId, knowledgeEdges.id),
    decision ? eq(knowledgeReviews.decision, decision) : undefined,
  ));
}

export function readableEdgeEvidence(channelIds: string[]) {
  const evidence = db.select({ id: knowledgeEdgeSources.sourceId }).from(knowledgeEdgeSources)
    .innerJoin(knowledgeSources, and(
      eq(knowledgeSources.serverId, knowledgeEdgeSources.serverId), eq(knowledgeSources.id, knowledgeEdgeSources.sourceId),
    )).where(and(
      eq(knowledgeEdgeSources.serverId, knowledgeEdges.serverId), eq(knowledgeEdgeSources.edgeId, knowledgeEdges.id),
      not(readableSource(channelIds)),
    ));
  return notExists(evidence);
}

export function edgeHasEvidence() {
  return exists(db.select({ id: knowledgeEdgeSources.sourceId }).from(knowledgeEdgeSources).where(and(
    eq(knowledgeEdgeSources.serverId, knowledgeEdges.serverId), eq(knowledgeEdgeSources.edgeId, knowledgeEdges.id),
  )));
}

export function readableEndpoint(nodeId: typeof knowledgeEdges.fromId | typeof knowledgeEdges.toId, channelIds: string[]) {
  return exists(db.select({ id: knowledgeNodeSources.sourceId }).from(knowledgeNodeSources)
    .innerJoin(knowledgeSources, and(
      eq(knowledgeSources.serverId, knowledgeNodeSources.serverId), eq(knowledgeSources.id, knowledgeNodeSources.sourceId),
    )).where(and(
      eq(knowledgeNodeSources.serverId, knowledgeEdges.serverId), eq(knowledgeNodeSources.nodeId, nodeId),
      readableSource(channelIds),
    )));
}
