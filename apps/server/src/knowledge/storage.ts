import { extractKnowledge, knowledgeEventSchema } from "@swarmroom/knowledge-graph";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  knowledgeEdges, knowledgeEdgeSources, knowledgeNodes, knowledgeNodeSources, knowledgeSources,
} from "../db/knowledge-schema.js";

export type KnowledgeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class KnowledgeSourceConflictError extends Error {}

export function storeKnowledgeEvent(input: unknown): Promise<{ sourceId: string; inserted: boolean }> {
  return db.transaction((transaction) => recordKnowledgeEvent(transaction, input));
}

export async function recordKnowledgeEvent(
  transaction: KnowledgeTransaction,
  input: unknown,
): Promise<{ sourceId: string; inserted: boolean }> {
  const event = knowledgeEventSchema.parse(input);
  const facts = extractKnowledge(event);
  const { source } = facts;
  const { serverId, id: sourceId } = source;
  await lockKnowledgeWorkspace(transaction, serverId, "shared");
  const [inserted] = await transaction.insert(knowledgeSources).values({
    ...source, occurredAt: new Date(source.occurredAt), event,
  }).onConflictDoNothing({ target: knowledgeSources.id }).returning({ id: knowledgeSources.id });
  if (!inserted) {
    const [same] = await transaction.select({ id: knowledgeSources.id }).from(knowledgeSources)
      .where(and(eq(knowledgeSources.id, sourceId), sql`${knowledgeSources.event} = ${JSON.stringify(event)}::jsonb`)).limit(1);
    if (!same) throw new KnowledgeSourceConflictError("Knowledge source identity already belongs to another event.");
    return { sourceId, inserted: false };
  }

  await writeKnowledgeFacts(transaction, facts);
  return { sourceId, inserted: true };
}

export async function lockKnowledgeWorkspace(transaction: KnowledgeTransaction, serverId: string, mode: "shared" | "exclusive") {
  if (mode === "shared") {
    await transaction.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${serverId}::text, 5381901))`);
  } else {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${serverId}::text, 5381901))`);
  }
}

export async function writeKnowledgeFacts(
  transaction: KnowledgeTransaction, { source, nodes, edges }: ReturnType<typeof extractKnowledge>,
) {
  const { serverId, id: sourceId } = source;
  await transaction.insert(knowledgeNodes).values(nodes).onConflictDoNothing({ target: knowledgeNodes.id });
  await transaction.insert(knowledgeEdges).values(edges.map((edge) => ({ ...edge, method: "deterministic" as const })))
    .onConflictDoNothing({ target: knowledgeEdges.id });
  await transaction.insert(knowledgeNodeSources).values(nodes.map(({ id: nodeId }) => ({ serverId, nodeId, sourceId }))).onConflictDoNothing();
  await transaction.insert(knowledgeEdgeSources).values(edges.map(({ id: edgeId }) => ({ serverId, edgeId, sourceId }))).onConflictDoNothing();
}
