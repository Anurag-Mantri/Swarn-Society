import type { KnowledgeEvent } from "@swarmroom/knowledge-graph";
import { and, eq, gt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { knowledgeSources } from "../db/knowledge-schema.js";
import { channels, messages, servers, taskPosts } from "../db/schema.js";
import { lockKnowledgeWorkspace, recordKnowledgeEvent, type KnowledgeTransaction } from "./storage.js";

const workspaceId = z.string().uuid().transform((value) => value.toLowerCase());
const personId = z.string().uuid();
const batchSize = 250;

type BackfillRow = { id: string; events: KnowledgeEvent[] };
type ReadBatch = (transaction: KnowledgeTransaction, serverId: string, after?: string) => Promise<BackfillRow[]>;

async function readMessages(transaction: KnowledgeTransaction, serverId: string, after?: string) {
  const recorded = transaction.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(
    eq(knowledgeSources.serverId, serverId), eq(knowledgeSources.type, "message.posted"),
    eq(knowledgeSources.sourceId, sql`${messages.id}::text`),
  ));
  const rows = await transaction.select({
    id: messages.id, channelId: messages.channelId, at: messages.createdAt,
    authorKind: messages.authorKind, authorId: messages.authorId,
  }).from(messages).innerJoin(channels, eq(messages.channelId, channels.id))
    .where(and(eq(channels.serverId, serverId), after ? gt(messages.id, after) : undefined, notExists(recorded)))
    .orderBy(messages.id).limit(batchSize).for("key share", { of: channels });
  return rows.map((row): BackfillRow => {
    const authorId = personId.safeParse(row.authorId);
    const author = row.authorKind === "user" && authorId.success ? { kind: "person" as const, id: authorId.data } : undefined;
    return { id: row.id, events: [{
      type: "message.posted", serverId, channelId: row.channelId, sourceId: row.id,
      messageId: row.id, occurredAt: row.at.toISOString(), author, mentionedAgentIds: [],
    }] };
  });
}

async function readTasks(transaction: KnowledgeTransaction, serverId: string, after?: string) {
  const rows = await transaction.select({
    id: taskPosts.id, channelId: taskPosts.channelId, authorId: taskPosts.createdBy,
    createdAt: taskPosts.createdAt, claimedAt: taskPosts.claimedAt, agentId: taskPosts.claimedByAgentId,
    resolvedAt: taskPosts.resolvedAt, resolvedBy: taskPosts.resolvedBy, resolution: taskPosts.resolution,
  }).from(taskPosts).innerJoin(channels, eq(taskPosts.channelId, channels.id))
    .where(and(eq(channels.serverId, serverId), after ? gt(taskPosts.id, after) : undefined))
    .orderBy(taskPosts.id).limit(batchSize).for("key share", { of: channels });
  return rows.map((row): BackfillRow => {
    const base = { serverId, channelId: row.channelId, sourceId: row.id, taskId: row.id };
    const events: KnowledgeEvent[] = [{
      ...base, type: "task.posted", occurredAt: row.createdAt.toISOString(), authorId: row.authorId,
    }];
    if (row.claimedAt && row.agentId) {
      events.push({
        ...base, type: "task.assigned", occurredAt: row.claimedAt.toISOString(),
        agentId: row.agentId, assignedBy: row.authorId,
      });
    }
    if (row.resolution === "done" && row.agentId && row.resolvedAt && row.resolvedBy) {
      events.push({
        ...base, type: "task.completed", occurredAt: row.resolvedAt.toISOString(), agentId: row.agentId,
        resolvedBy: row.resolvedBy,
      });
    }
    return { id: row.id, events };
  });
}

async function importRows(serverId: string, readBatch: ReadBatch) {
  let after: string | undefined;
  let inserted = 0;
  while (true) {
    const batch = await db.transaction(async (transaction) => {
      await lockKnowledgeWorkspace(transaction, serverId, "exclusive");
      const rows = await readBatch(transaction, serverId, after);
      let newEvents = 0;
      for (const { events } of rows) {
        for (const event of events) {
          if ((await recordKnowledgeEvent(transaction, event)).inserted) newEvents += 1;
        }
      }
      return { size: rows.length, lastId: rows.at(-1)?.id, newEvents };
    });
    inserted += batch.newEvents;
    if (batch.size < batchSize) return inserted;
    after = batch.lastId;
  }
}

export async function backfillKnowledgeGraph(input: string) {
  const serverId = workspaceId.parse(input);
  const [workspace] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!workspace) throw new Error("Workspace not found.");
  const messagesImported = await importRows(serverId, readMessages);
  const taskEventsImported = await importRows(serverId, readTasks);
  return { messagesImported, taskEventsImported };
}
