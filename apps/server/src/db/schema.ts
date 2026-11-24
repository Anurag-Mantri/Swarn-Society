import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  kind: text("kind").notNull().default("text"),
  position: integer("position").notNull().default(0),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  authorKind: text("author_kind").notNull(),
  authorId: text("author_id").notNull(),
  hostId: uuid("host_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("messages_channel_created_idx").on(table.channelId, table.createdAt),
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

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  role: text("role").notNull(),
  tools: jsonb("tools").notNull().default([]),
  visibility: text("visibility").notNull().default("server"),
});

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
