import { createWorkspaceFileSchema } from "@swarmroom/protocol";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { servers, workspaceFiles } from "../db/schema.js";
import { permissions } from "../permissions.js";

const pathParams = z.object({ serverId: z.string().uuid() });
const fileMetadata = { id: workspaceFiles.id, path: workspaceFiles.path };

export const workspaceFileRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers/:serverId/files", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = pathParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    const { serverId } = params.data;
    if (!await hasServerPermission(serverId, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot view files in this workspace." });
    }
    return reply.send(await db.select(fileMetadata).from(workspaceFiles)
      .where(eq(workspaceFiles.serverId, serverId)).orderBy(workspaceFiles.path));
  });

  app.post("/api/servers/:serverId/files", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = pathParams.safeParse(request.params);
    const body = createWorkspaceFileSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Provide a valid workspace ID and repository-relative file path." });
    }
    const { serverId } = params.data;
    const { path } = body.data;
    if (!await hasServerPermission(serverId, user.id, permissions.readMessages | permissions.sendMessages)) {
      return reply.code(403).send({ error: "You cannot create files in this workspace." });
    }
    const file = await db.transaction(async (transaction) => {
      // Serialize file creation per workspace so a path cannot become both a file and a directory.
      const [server] = await transaction.select({ id: servers.id }).from(servers)
        .where(eq(servers.id, serverId)).for("update");
      if (!server) return undefined;
      const existing = await transaction.select({ path: workspaceFiles.path }).from(workspaceFiles)
        .where(eq(workspaceFiles.serverId, serverId));
      const normalized = path.toLowerCase();
      if (existing.some(({ path: other }) => {
        const current = other.toLowerCase();
        return current === normalized || current.startsWith(`${normalized}/`) || normalized.startsWith(`${current}/`);
      })) return undefined;
      const [inserted] = await transaction.insert(workspaceFiles).values({ serverId, path }).returning(fileMetadata);
      return inserted;
    });
    if (!file) return reply.code(409).send({ error: "That path conflicts with an existing workspace file." });
    return reply.code(201).send(file);
  });
};
