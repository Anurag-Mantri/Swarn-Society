import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { channelRoleRestrictions, memberRoles, members, roles, servers } from "./db/schema.js";
import { includesPermission, permissions } from "./permissions.js";

async function hasPermission(
  serverId: string, userId: string, permission: number, channelId?: string,
): Promise<boolean> {
  const serverRows = await db.select({ ownerId: servers.ownerId }).from(servers)
    .where(eq(servers.id, serverId)).limit(1);
  const server = serverRows[0];
  if (!server) return false;
  if (server.ownerId === userId) return true;

  const assignments = await db.select({ granted: roles.permissions, denied: channelRoleRestrictions.denied })
    .from(memberRoles)
    .innerJoin(members, and(
      eq(members.serverId, memberRoles.serverId),
      eq(members.userId, memberRoles.userId),
    ))
    .innerJoin(roles, eq(memberRoles.roleId, roles.id))
    .leftJoin(channelRoleRestrictions, channelId
      ? and(eq(channelRoleRestrictions.roleId, roles.id), eq(channelRoleRestrictions.channelId, channelId))
      : sql`false`)
    .where(and(
      eq(memberRoles.serverId, serverId),
      eq(memberRoles.userId, userId),
      eq(roles.serverId, serverId),
    ));
  const grants = assignments.reduce((combined, assignment) => combined | assignment.granted, 0);
  const denials = assignments.reduce((combined, assignment) => combined | (assignment.denied ?? 0), 0);
  return includesPermission(grants & ~denials, permission);
}

export function hasServerPermission(serverId: string, userId: string, permission: number): Promise<boolean> {
  return hasPermission(serverId, userId, permission);
}

export function hasChannelPermission(
  channel: { id: string; serverId: string }, userId: string, permission: number,
): Promise<boolean> {
  return hasPermission(channel.serverId, userId, permissions.readMessages | permission, channel.id);
}
