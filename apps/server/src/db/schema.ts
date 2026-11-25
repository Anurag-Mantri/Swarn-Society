import { boolean, check, customType, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { maximumTaskDelegationDepth, type ChannelKind, type ExtensionCapability, type ExtensionManifest, type TaskResolution } from "@swarmroom/protocol";
import { channelPermissions } from "../permissions.js";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: text("github_id").notNull().unique(),
  handle: text("handle").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});


const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const workspaceFiles = pgTable("workspace_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  document: bytea("document"),
}, (table) => [
  unique("workspace_files_server_path_unique").on(table.serverId, table.path),
]);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  permissions: integer("permissions").notNull(),
});

export const members = pgTable("members", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.serverId, table.userId] }),
]);

export const memberRoles = pgTable("member_roles", {
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.serverId, table.userId, table.roleId] }),
]);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").$type<ChannelKind>().notNull().default("text"),
  position: integer("position").notNull().default(0),
}, (table) => [
  unique("channels_server_id_id_unique").on(table.serverId, table.id),
  check("channels_kind_valid", sql`${table.kind} in ('text', 'voice', 'task')`),
]);

export const channelRoleRestrictions = pgTable("channel_role_restrictions", {
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  denied: integer("denied").notNull(),
}, (table) => [
  primaryKey({ columns: [table.channelId, table.roleId] }),
  check("channel_role_restrictions_denied_valid", sql`${table.denied} between 1 and ${sql.raw(String(channelPermissions))}`),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id"),
  authorKind: text("author_kind").notNull(),
  authorId: text("author_id").notNull(),
  hostId: uuid("host_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("messages_channel_created_idx").on(table.channelId, table.createdAt),
  index("messages_thread_created_idx").on(table.threadId, table.createdAt),
  unique("messages_channel_id_unique").on(table.channelId, table.id),
  foreignKey({
    name: "messages_same_channel_thread_fk",
    columns: [table.channelId, table.threadId],
    foreignColumns: [table.channelId, table.id],
  }).onDelete("cascade"),
]);

export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  machineLabel: text("machine_label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("offline"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceHosts = pgTable("voice_hosts", {
  serverId: uuid("server_id").primaryKey().references(() => servers.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
});

export const extensionManifests = pgTable("extension_manifests", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  registeredBy: uuid("registered_by").notNull().references(() => users.id),
  slug: text("slug").notNull(),
  version: text("version").notNull(),
  manifest: jsonb("manifest").$type<ExtensionManifest>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("extension_manifests_version_unique").on(table.serverId, table.slug, table.version),
]);

export const hostExtensionApprovals = pgTable("host_extension_approvals", {
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
  manifestId: uuid("manifest_id").notNull().references(() => extensionManifests.id, { onDelete: "cascade" }),
  approvedBy: uuid("approved_by").notNull().references(() => users.id),
  capabilities: jsonb("capabilities").$type<ExtensionCapability[]>().notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.hostId, table.manifestId] }),
  index("host_extension_approvals_manifest_idx").on(table.manifestId),
]);

export const extensionAdapters = pgTable("extension_adapters", {
  id: uuid("id").primaryKey(),
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
  manifestId: uuid("manifest_id").notNull().references(() => extensionManifests.id, { onDelete: "cascade" }),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const extensionSessions = pgTable("extension_sessions", {
  id: uuid("id").primaryKey(),
  adapterId: uuid("adapter_id").notNull().references(() => extensionAdapters.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
}, (table) => [
  index("extension_sessions_connection_idx").on(table.connectionId),
]);

export const extensionResources = pgTable("extension_resources", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => extensionSessions.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  extension: text("extension").notNull(),
  byteLength: integer("byte_length").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("extension_resources_session_id_unique").on(table.sessionId, table.id),
]);

export const extensionSnapshots = pgTable("extension_snapshots", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  resourceId: uuid("resource_id").notNull(),
  format: text("format").notNull(),
  sha256: text("sha256").notNull(),
  byteLength: integer("byte_length").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "extension_snapshots_resource_scope_fk", columns: [table.sessionId, table.resourceId],
    foreignColumns: [extensionResources.sessionId, extensionResources.id] }).onDelete("cascade"),
]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  tools: jsonb("tools").notNull().default([]),
  visibility: text("visibility").notNull().default("server"),
});

export const taskPosts = pgTable("task_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  parentTaskId: uuid("parent_task_id"),
  delegationDepth: integer("delegation_depth").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  intent: text("intent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByAgentId: uuid("claimed_by_agent_id").references(() => agents.id),
  resolution: text("resolution").$type<TaskResolution>(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  result: text("result"),
}, (table) => [
  unique("task_posts_channel_id_unique").on(table.channelId, table.id),
  foreignKey({
    name: "task_posts_parent_channel_fk", columns: [table.channelId, table.parentTaskId],
    foreignColumns: [table.channelId, table.id],
  }).onDelete("cascade"),
  index("task_posts_parent_idx").on(table.channelId, table.parentTaskId),
  check("task_posts_delegation_depth_valid", sql`${table.delegationDepth} between 0 and ${sql.raw(String(maximumTaskDelegationDepth))}`),
  check("task_posts_parent_required", sql`(${table.parentTaskId} is null) = (${table.delegationDepth} = 0)`),
  check("task_posts_parent_not_self", sql`${table.parentTaskId} <> ${table.id}`),
  index("task_posts_channel_created_idx").on(table.channelId, table.createdAt),
  index("task_posts_active_agent_idx").on(table.claimedByAgentId)
    .where(sql`${table.resolution} is null and ${table.claimedByAgentId} is not null`),
  index("task_posts_active_intent_idx").on(table.channelId, table.intent)
    .where(sql`${table.resolution} is null and ${table.claimedByAgentId} is not null`),
  check("task_posts_claim_fields_match", sql`(${table.claimedAt} is null) = (${table.claimedByAgentId} is null)`),
  check("task_posts_resolution_valid", sql`${table.resolution} in ('done', 'cancelled')`),
  check("task_posts_resolution_fields_match", sql`num_nonnulls(${table.resolution}, ${table.resolvedAt}, ${table.resolvedBy}, ${table.result}) in (0, 4)`),
  check("task_posts_completion_has_claim", sql`${table.resolution} != 'done' or ${table.claimedByAgentId} is not null`),
]);

export const taskReputationReviews = pgTable("task_reputation_reviews", {
  taskId: uuid("task_id").primaryKey().references(() => taskPosts.id, { onDelete: "cascade" }),
  reviewerId: uuid("reviewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  feedback: text("feedback").$type<"helpful" | "needs_work">(),
  tests: text("tests").$type<"passed" | "failed">(),
  mergedPullRequest: text("merged_pull_request"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("task_reputation_feedback_valid", sql`${table.feedback} in ('helpful', 'needs_work')`),
  check("task_reputation_tests_valid", sql`${table.tests} in ('passed', 'failed')`),
  check("task_reputation_has_evidence", sql`num_nonnulls(${table.feedback}, ${table.tests}, ${table.mergedPullRequest}) >= 1`),
]);

export const taskCoordinationDaily = pgTable("task_coordination_daily", {
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  duplicateIntentAttempts: integer("duplicate_intent_attempts").notNull().default(0),
  busyAgentAttempts: integer("busy_agent_attempts").notNull().default(0),
  competingClaimAttempts: integer("competing_claim_attempts").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.channelId, table.day] }),
]);

export const taskBids = pgTable("task_bids", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => taskPosts.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  proposedBy: uuid("proposed_by").notNull().references(() => users.id),
  plan: text("plan").notNull(),
  deliverable: text("deliverable").notNull(),
  estimatedTokens: integer("estimated_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by").references(() => users.id),
}, (table) => [
  unique("task_bids_task_agent_unique").on(table.taskId, table.agentId),
  uniqueIndex("task_bids_one_approval").on(table.taskId).where(sql`${table.approvedAt} is not null`),
  check("task_bids_approval_fields_match", sql`(${table.approvedAt} is null) = (${table.approvedBy} is null)`),
]);

export const agentHosts = pgTable("agent_hosts", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(100),
  enabled: boolean("enabled").notNull().default(true),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.hostId] }),
]);

export const agentUsage = pgTable("agent_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  requesterId: uuid("requester_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_usage_requester_at_idx").on(table.requesterId, table.reportedAt),
  index("agent_usage_agent_at_idx").on(table.agentId, table.reportedAt),
  check("agent_usage_token_counts_valid", sql`${table.tokensIn} BETWEEN 0 AND 10000000 AND ${table.tokensOut} BETWEEN 0 AND 10000000`),
]);

export const creditEntries = pgTable("credit_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  fromKind: text("from_kind").$type<"agent" | "host">(),
  fromId: uuid("from_id"),
  toKind: text("to_kind").$type<"agent" | "host">().notNull(),
  toId: uuid("to_id").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("credit_entries_request_unique").on(table.serverId, table.requestId),
  index("credit_entries_source_idx").on(table.serverId, table.fromKind, table.fromId),
  index("credit_entries_destination_idx").on(table.serverId, table.toKind, table.toId),
  check("credit_entries_amount_valid", sql`${table.amount} between 1 and 1000000`),
  check("credit_entries_source_valid", sql`(${table.fromKind} is null) = (${table.fromId} is null) and (${table.fromKind} in ('agent', 'host') or ${table.fromKind} is null)`),
  check("credit_entries_destination_valid", sql`${table.toKind} in ('agent', 'host')`),
  check("credit_entries_accounts_differ", sql`(${table.fromKind}, ${table.fromId}) is distinct from (${table.toKind}, ${table.toId})`),
]);

export const memoryNotes = pgTable("memory_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scope: text("scope").$type<"workspace" | "channel" | "agent">().notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("memory_notes_scope_idx").on(table.serverId, table.scope, table.createdAt),
  index("memory_notes_search_idx").using("gin", sql`to_tsvector('simple'::regconfig, ${table.body})`),
  check("memory_notes_target_valid", sql`
    (${table.scope} = 'workspace' and ${table.channelId} is null and ${table.agentId} is null) or
    (${table.scope} = 'channel' and ${table.channelId} is not null and ${table.agentId} is null) or
    (${table.scope} = 'agent' and ${table.channelId} is null and ${table.agentId} is not null)
  `),
]);
