import { extractKnowledge, knowledgeEventSchema } from "@swarmroom/knowledge-graph";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  knowledgeEdges, knowledgeEdgeSources, knowledgeNodes, knowledgeNodeSources, knowledgeSources,
} from "../db/knowledge-schema.js";

export async function storeKnowledgeEvent(input: unknown): Promise<{ sourceId: string; inserted: boolean }> {
  const event = knowledgeEventSchema.parse(input);
  const { source, nodes, edges } = extractKnowledge(event);
  const { serverId, id: sourceId } = source;
  return db.transaction(async (transaction) => {
    const [inserted] = await transaction.insert(knowledgeSources).values({
      ...source, occurredAt: new Date(source.occurredAt), event,
    }).onConflictDoNothing({ target: knowledgeSources.id }).returning({ id: knowledgeSources.id });
    if (!inserted) {
      const [same] = await transaction.select({ id: knowledgeSources.id }).from(knowledgeSources)
        .where(and(eq(knowledgeSources.id, sourceId), sql`${knowledgeSources.event} = ${JSON.stringify(event)}::jsonb`)).limit(1);
      if (!same) throw new Error("Knowledge source identity already belongs to another event.");
      return { sourceId, inserted: false };
    }

    await transaction.insert(knowledgeNodes).values(nodes).onConflictDoNothing({ target: knowledgeNodes.id });
    await transaction.insert(knowledgeEdges).values(edges.map((edge) => ({ ...edge, method: "deterministic" as const })))
      .onConflictDoNothing({ target: knowledgeEdges.id });
    await transaction.insert(knowledgeNodeSources).values(nodes.map(({ id: nodeId }) => ({ serverId, nodeId, sourceId })));
    await transaction.insert(knowledgeEdgeSources).values(edges.map(({ id: edgeId }) => ({ serverId, edgeId, sourceId })));
    return { sourceId, inserted: true };
  });
}
