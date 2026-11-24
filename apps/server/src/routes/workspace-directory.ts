import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { requireUser } from "../auth.js";
import { db } from "../db/index.js";
import { members, servers } from "../db/schema.js";

export const workspaceDirectoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const workspaces = await db.select({ id: servers.id, name: servers.name, ownerId: servers.ownerId })
      .from(members)
      .innerJoin(servers, eq(servers.id, members.serverId))
      .where(eq(members.userId, user.id))
      .orderBy(servers.name, servers.id);
    return reply.send(workspaces);
  });
};
