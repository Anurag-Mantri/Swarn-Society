import { extensionApprovalSchema, extensionManifestSchema } from "@swarmroom/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { extensionManifests, hostExtensionApprovals, hosts } from "../db/schema.js";
import { permissions } from "../permissions.js";

const uuid = z.string().uuid();
const serverParams = z.object({ serverId: uuid });
const approvalParams = z.object({ hostId: uuid, manifestId: uuid });
const path = "/api/hosts/:hostId/extensions/:manifestId/approval";

async function ownedHost(hostId: string, userId: string) {
  const [host] = await db.select({ status: hosts.status }).from(hosts)
    .where(and(eq(hosts.id, hostId), eq(hosts.ownerId, userId))).limit(1);
  return host;
}

export const extensionManifestRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers/:serverId/extensions", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = serverParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    if (!await hasServerPermission(params.data.serverId, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot view this workspace's extensions." });
    }
    const manifests = await db.select().from(extensionManifests).where(eq(extensionManifests.serverId, params.data.serverId))
      .orderBy(extensionManifests.slug, extensionManifests.createdAt);
    return reply.send(manifests);
  });

  app.post("/api/servers/:serverId/extensions", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = serverParams.safeParse(request.params);
    const body = extensionManifestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Provide a valid workspace ID and versioned manifest." });
    const { serverId } = params.data;
    if (!await hasServerPermission(serverId, user.id, permissions.manageAgents)) {
      return reply.code(403).send({ error: "You cannot register extensions in this workspace." });
    }
    const manifest = body.data;
    const [registered] = await db.insert(extensionManifests).values({
      serverId, registeredBy: user.id, slug: manifest.slug, version: manifest.version, manifest,
    }).onConflictDoNothing({ target: [extensionManifests.serverId, extensionManifests.slug, extensionManifests.version] })
      .returning();
    if (!registered) return reply.code(409).send({ error: "This manifest version is already registered. Use a new version for changes." });
    return reply.code(201).send(registered);
  });

  app.get("/api/hosts/:hostId/extensions", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = approvalParams.pick({ hostId: true }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid host ID." });
    const { hostId } = params.data;
    if (!await ownedHost(hostId, user.id)) return reply.code(404).send({ error: "Host not found." });
    return reply.send(await db.select().from(hostExtensionApprovals).where(eq(hostExtensionApprovals.hostId, hostId)));
  });

  app.put(path, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = approvalParams.safeParse(request.params);
    const body = extensionApprovalSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Provide a host, manifest, and subset of requested capabilities." });
    const { hostId, manifestId } = params.data;
    const host = await ownedHost(hostId, user.id);
    if (!host || host.status === "revoked") return reply.code(404).send({ error: "Host not found or revoked." });
    const [extension] = await db.select().from(extensionManifests).where(eq(extensionManifests.id, manifestId)).limit(1);
    if (!extension || !await hasServerPermission(extension.serverId, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot approve extensions from this workspace." });
    }
    const { capabilities } = body.data;
    if (!capabilities.every((capability) => extension.manifest.capabilities.includes(capability))) {
      return reply.code(400).send({ error: "Approve only capabilities declared in this manifest version." });
    }

    const approval = { capabilities, approvedBy: user.id, approvedAt: new Date() };
    const [saved] = await db.insert(hostExtensionApprovals).values({ hostId, manifestId, ...approval }).onConflictDoUpdate({
      target: [hostExtensionApprovals.hostId, hostExtensionApprovals.manifestId],
      set: approval,
    }).returning();
    return reply.send(saved);
  });

  app.delete(path, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = approvalParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide valid host and manifest IDs." });
    const { hostId, manifestId } = params.data;
    if (!await ownedHost(hostId, user.id)) return reply.code(404).send({ error: "Host not found." });
    await db.delete(hostExtensionApprovals).where(and(
      eq(hostExtensionApprovals.hostId, hostId), eq(hostExtensionApprovals.manifestId, manifestId),
    ));
    return reply.code(204).send();
  });
};
