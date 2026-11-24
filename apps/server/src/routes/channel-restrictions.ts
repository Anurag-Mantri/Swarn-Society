import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { channelRoleRestrictions, channels, roles } from "../db/schema.js";
import { channelPermissions, permissions } from "../permissions.js";

const channelRestrictionParamsSchema = z.object({ channelId: z.string().uuid(), roleId: z.string().uuid() });
const channelRestrictionInputSchema = z.object({
  denied: z.number().int().min(0).max(channelPermissions),
}).strict();

export const channelRestrictionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/channels/:channelId/role-restrictions", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = channelRestrictionParamsSchema.pick({ channelId: true }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid channel ID." });
    const [channel] = await db.select().from(channels).where(eq(channels.id, params.data.channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    if (!await hasServerPermission(channel.serverId, user.id, permissions.manageRoles | permissions.manageChannels)) {
      return reply.code(403).send({ error: "Not allowed to manage channel restrictions" });
    }
    const restrictions = await db.select({
      roleId: channelRoleRestrictions.roleId, denied: channelRoleRestrictions.denied,
    }).from(channelRoleRestrictions).where(eq(channelRoleRestrictions.channelId, channel.id));
    return reply.send(restrictions);
  });

  app.put("/api/channels/:channelId/role-restrictions/:roleId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = channelRestrictionParamsSchema.safeParse(request.params);
    const body = channelRestrictionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide valid channel and role IDs and a denied permission mask from 0 to 7." });
    }
    const { channelId, roleId } = params.data;
    const { denied } = body.data;
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) return reply.code(404).send({ error: "Channel not found" });
    if (!await hasServerPermission(channel.serverId, user.id, permissions.manageRoles | permissions.manageChannels)) {
      return reply.code(403).send({ error: "Not allowed to manage channel restrictions" });
    }
    const [role] = await db.select({ id: roles.id }).from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.serverId, channel.serverId))).limit(1);
    if (!role) return reply.code(404).send({ error: "Role not found in this server" });
    if (denied === 0) {
      await db.delete(channelRoleRestrictions).where(and(
        eq(channelRoleRestrictions.channelId, channelId), eq(channelRoleRestrictions.roleId, roleId),
      ));
    } else {
      await db.insert(channelRoleRestrictions).values({ channelId, roleId, denied }).onConflictDoUpdate({
        target: [channelRoleRestrictions.channelId, channelRoleRestrictions.roleId],
        set: { denied },
      });
    }
    return reply.send({ roleId, denied });
  });
};
