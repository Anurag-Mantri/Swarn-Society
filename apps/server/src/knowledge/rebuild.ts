import { extractKnowledge } from "@swarmroom/knowledge-graph";
import { and, eq, gt, inArray, notExists, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  knowledgeEdges, knowledgeEdgeSources, knowledgeNodes, knowledgeNodeSources, knowledgeReviews, knowledgeSources,
} from "../db/knowledge-schema.js";
import { servers } from "../db/schema.js";
import { lockKnowledgeWorkspace, writeKnowledgeFacts } from "./storage.js";

const workspaceId = z.string().uuid().transform((value) => value.toLowerCase());

/** Repair derived facts from one workspace's immutable sources in one transaction. */
export function rebuildKnowledgeGraph(input: string): Promise<{ sourcesReplayed: number }> {
  const serverId = workspaceId.parse(input);
  return db.transaction(async (transaction) => {
    await lockKnowledgeWorkspace(transaction, serverId, "exclusive");
    const [workspace] = await transaction.select({ id: servers.id }).from(servers)
      .where(eq(servers.id, serverId)).limit(1);
    if (!workspace) throw new Error("Workspace not found.");

    let after = "";
    let sourcesReplayed = 0;
    while (true) {
      const sources = await transaction.select().from(knowledgeSources).where(and(
        eq(knowledgeSources.serverId, serverId), eq(knowledgeSources.method, "structured-v1"), gt(knowledgeSources.id, after),
      )).orderBy(knowledgeSources.id).limit(250);
      for (const source of sources) {
        const facts = extractKnowledge(source.event);
        if (facts.source.id !== source.id || facts.source.serverId !== serverId || facts.source.channelId !== source.channelId) {
          throw new Error("A stored source failed its metadata check.");
        }
        await transaction.delete(knowledgeNodeSources).where(and(
          eq(knowledgeNodeSources.serverId, serverId), eq(knowledgeNodeSources.sourceId, source.id),
        ));
        const deterministicEdges = transaction.select({ id: knowledgeEdges.id }).from(knowledgeEdges).where(and(
          eq(knowledgeEdges.serverId, serverId), eq(knowledgeEdges.method, "deterministic"),
        ));
        await transaction.delete(knowledgeEdgeSources).where(and(
          eq(knowledgeEdgeSources.serverId, serverId), eq(knowledgeEdgeSources.sourceId, source.id),
          inArray(knowledgeEdgeSources.edgeId, deterministicEdges),
        ));
        await writeKnowledgeFacts(transaction, facts);
        sourcesReplayed += 1;
        after = source.id;
      }
      if (sources.length < 250) break;
    }

    await transaction.delete(knowledgeEdges).where(and(
      eq(knowledgeEdges.serverId, serverId), eq(knowledgeEdges.method, "deterministic"),
      notExists(transaction.select().from(knowledgeEdgeSources).where(eq(knowledgeEdgeSources.edgeId, knowledgeEdges.id))),
      notExists(transaction.select().from(knowledgeReviews).where(eq(knowledgeReviews.edgeId, knowledgeEdges.id))),
    ));
    await transaction.delete(knowledgeNodes).where(and(
      eq(knowledgeNodes.serverId, serverId),
      notExists(transaction.select().from(knowledgeNodeSources).where(eq(knowledgeNodeSources.nodeId, knowledgeNodes.id))),
      notExists(transaction.select().from(knowledgeEdges).where(or(
        eq(knowledgeEdges.fromId, knowledgeNodes.id), eq(knowledgeEdges.toId, knowledgeNodes.id),
      ))),
    ));
    return { sourcesReplayed };
  });
}
