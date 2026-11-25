import { githubCommitReceiptSchema } from "@swarmroom/protocol";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { db } from "../db/index.js";
import { servers } from "../db/schema.js";
import { KnowledgeSourceConflictError, storeKnowledgeEvent } from "../knowledge/storage.js";

const paramsSchema = z.object({ serverId: z.string().uuid().transform((id) => id.toLowerCase()) });

export const knowledgeCommitRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/servers/:serverId/knowledge/commit-receipts", { bodyLimit: 4096 }, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = paramsSchema.safeParse(request.params);
    const body = githubCommitReceiptSchema.safeParse(request.body);
    if (!params.success || !body.success || body.data.serverId !== params.data.serverId) {
      return reply.code(400).send({ error: "Provide a commit receipt for this workspace's snapshot branch." });
    }
    const { serverId, repositoryId, commitSha, committedAt } = body.data;
    const [workspace] = await db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId));
    if (workspace?.ownerId !== user.id) {
      return reply.code(403).send({ error: "Only the workspace owner can import a commit receipt." });
    }

    try {
      const result = await storeKnowledgeEvent({
        type: "commit.receipt.imported", sourceId: `${repositoryId}:${commitSha}`,
        serverId, repositoryId, commitSha, occurredAt: committedAt, reportedBy: user.id,
      });
      return reply.code(result.inserted ? 201 : 200).header("Cache-Control", "no-store").send(result);
    } catch (problem) {
      if (problem instanceof KnowledgeSourceConflictError) {
        return reply.code(409).send({ error: "A receipt for this commit already exists with different metadata." });
      }
      throw problem;
    }
  });
};
