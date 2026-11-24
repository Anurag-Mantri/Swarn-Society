import type { KnowledgeEvent, NodeKind, Relation } from "@swarmroom/knowledge-graph";
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { channels, servers, users } from "./schema.js";

export const knowledgeNodes = pgTable("knowledge_nodes", {
  id: text("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  kind: text("kind").$type<NodeKind>().notNull(),
  key: text("canonical_key").notNull(),
  confidence: integer("confidence").notNull().default(100),
}, (table) => [
  unique("knowledge_nodes_scoped_id").on(table.serverId, table.id),
  unique("knowledge_nodes_canonical_key").on(table.serverId, table.kind, table.key),
  check("knowledge_nodes_confidence_valid", sql`${table.confidence} between 0 and 100`),
]);

export const knowledgeEdges = pgTable("knowledge_edges", {
  id: text("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  fromId: text("from_node_id").notNull(),
  toId: text("to_node_id").notNull(),
  relation: text("relation").$type<Relation>().notNull(),
  confidence: integer("confidence").notNull().default(100),
  method: text("method").$type<"deterministic" | "inferred">().notNull(),
  hasConflict: boolean("has_conflict").notNull().default(false),
}, (table) => [
  unique("knowledge_edges_scoped_id").on(table.serverId, table.id),
  unique("knowledge_edges_relationship").on(table.serverId, table.fromId, table.relation, table.toId),
  foreignKey({ name: "knowledge_edges_from_node_scope_fk", columns: [table.serverId, table.fromId],
    foreignColumns: [knowledgeNodes.serverId, knowledgeNodes.id] }).onDelete("cascade"),
  foreignKey({ name: "knowledge_edges_to_node_scope_fk", columns: [table.serverId, table.toId],
    foreignColumns: [knowledgeNodes.serverId, knowledgeNodes.id] }).onDelete("cascade"),
  index("knowledge_edges_target_idx").on(table.serverId, table.toId),
  check("knowledge_edges_confidence_valid", sql`${table.confidence} between 0 and 100`),
  check("knowledge_edges_method_valid", sql`${table.method} in ('deterministic', 'inferred')`),
]);

export const knowledgeSources = pgTable("knowledge_sources", {
  id: text("id").primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id"),
  type: text("source_type").$type<KnowledgeEvent["type"]>().notNull(),
  sourceId: text("source_id").notNull(),
  method: text("method").notNull(),
  event: jsonb("event").$type<KnowledgeEvent>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("knowledge_sources_scoped_id").on(table.serverId, table.id),
  unique("knowledge_sources_identity").on(table.serverId, table.type, table.sourceId),
  foreignKey({ name: "knowledge_sources_channel_scope_fk", columns: [table.serverId, table.channelId],
    foreignColumns: [channels.serverId, channels.id] }).onDelete("cascade"),
  index("knowledge_sources_visibility_idx").on(table.serverId, table.channelId, table.occurredAt),
]);

export const knowledgeNodeSources = pgTable("knowledge_node_sources", {
  serverId: uuid("server_id").notNull(),
  nodeId: text("node_id").notNull(),
  sourceId: text("source_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.serverId, table.nodeId, table.sourceId] }),
  foreignKey({ name: "knowledge_node_sources_node_scope_fk", columns: [table.serverId, table.nodeId],
    foreignColumns: [knowledgeNodes.serverId, knowledgeNodes.id] }).onDelete("cascade"),
  foreignKey({ name: "knowledge_node_sources_source_scope_fk", columns: [table.serverId, table.sourceId],
    foreignColumns: [knowledgeSources.serverId, knowledgeSources.id] }).onDelete("cascade"),
  index("knowledge_node_sources_reverse_idx").on(table.serverId, table.sourceId),
]);

export const knowledgeEdgeSources = pgTable("knowledge_edge_sources", {
  serverId: uuid("server_id").notNull(),
  edgeId: text("edge_id").notNull(),
  sourceId: text("source_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.serverId, table.edgeId, table.sourceId] }),
  foreignKey({ name: "knowledge_edge_sources_edge_scope_fk", columns: [table.serverId, table.edgeId],
    foreignColumns: [knowledgeEdges.serverId, knowledgeEdges.id] }).onDelete("cascade"),
  foreignKey({ name: "knowledge_edge_sources_source_scope_fk", columns: [table.serverId, table.sourceId],
    foreignColumns: [knowledgeSources.serverId, knowledgeSources.id] }).onDelete("cascade"),
  index("knowledge_edge_sources_reverse_idx").on(table.serverId, table.sourceId),
]);

export const knowledgeReviews = pgTable("knowledge_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull(),
  edgeId: text("edge_id").notNull(),
  reviewerId: uuid("reviewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  decision: text("decision").$type<"approved" | "rejected">().notNull(),
  reason: text("reason").notNull().default(""),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "knowledge_reviews_edge_scope_fk", columns: [table.serverId, table.edgeId],
    foreignColumns: [knowledgeEdges.serverId, knowledgeEdges.id] }).onDelete("cascade"),
  index("knowledge_reviews_edge_idx").on(table.serverId, table.edgeId, table.reviewedAt),
  check("knowledge_reviews_decision_valid", sql`${table.decision} in ('approved', 'rejected')`),
]);
