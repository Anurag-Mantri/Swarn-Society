import { memorySearchSchema, memoryWriteSchema, type MemoryScope } from "@swarmroom/protocol";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission, hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, channels, memoryNotes } from "../db/schema.js";
import { permissions } from "../permissions.js";

const path = "/api/servers/:serverId/memory";
const params = z.object({ serverId: z.string().uuid() });
const { serverId: _serverId, ...noteFields } = getTableColumns(memoryNotes);

async function workspace(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply);
  if (!user) return;
  const parsed = params.safeParse(request.params);
  if (!parsed.success) {
    await reply.code(400).send({ error: "Provide a valid workspace ID." });
    return;
  }
  return { serverId: parsed.data.serverId, userId: user.id };
}

async function memoryAccess(
  serverId: string, userId: string, scope: MemoryScope, targetId: string | undefined, write: boolean,
): Promise<boolean> {
  const required = permissions.readMessages | (write ? permissions.sendMessages : 0);
  if (scope === "workspace") return hasServerPermission(serverId, userId, required);
  if (!targetId) return false;
  if (scope === "channel") {
    const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels)
      .where(and(eq(channels.id, targetId), eq(channels.serverId, serverId))).limit(1);
    return Boolean(channel && await hasChannelPermission(channel, userId, required));
  }
  if (!await hasServerPermission(serverId, userId, required)) return false;
  const [agent] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.serverId, serverId), eq(agents.id, targetId), eq(agents.ownerId, userId))).limit(1);
  return Boolean(agent);
}

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(path, async (request, reply) => {
    const access = await workspace(request, reply);
    if (!access) return;
    const input = memorySearchSchema.safeParse(request.query);
    if (!input.success) return reply.code(400).send({ error: "Choose a valid memory scope and search query." });
    const { serverId, userId } = access;
    const { scope, targetId, q } = input.data;
    if (!await memoryAccess(serverId, userId, scope, targetId, false)) {
      return reply.code(403).send({ error: "You cannot read memory in this scope." });
    }
    const target = scope === "channel" && targetId ? eq(memoryNotes.channelId, targetId)
      : scope === "agent" && targetId ? eq(memoryNotes.agentId, targetId) : undefined;
    const match = q ? sql`to_tsvector('simple'::regconfig, ${memoryNotes.body}) @@ websearch_to_tsquery('simple'::regconfig, ${q})` : undefined;
    const notes = await db.select(noteFields).from(memoryNotes).where(and(
      eq(memoryNotes.serverId, serverId), eq(memoryNotes.scope, scope), target, match,
    )).orderBy(desc(memoryNotes.createdAt), desc(memoryNotes.id)).limit(100);
    return reply.header("Cache-Control", "no-store").send(notes);
  });

  app.get(`${path}/agents`, async (request, reply) => {
    const access = await workspace(request, reply);
    if (!access) return;
    if (!await hasServerPermission(access.serverId, access.userId, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot access agent memory in this workspace." });
    }
    return reply.send(await db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(and(eq(agents.serverId, access.serverId), eq(agents.ownerId, access.userId))).orderBy(agents.name, agents.id));
  });

  app.post(path, async (request, reply) => {
    const access = await workspace(request, reply);
    if (!access) return;
    const input = memoryWriteSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Choose a valid memory scope and enter a note." });
    const { serverId, userId } = access;
    const { scope, targetId, body } = input.data;
    if (!await memoryAccess(serverId, userId, scope, targetId, true)) {
      return reply.code(403).send({ error: "You cannot add memory in this scope." });
    }
    const [note] = await db.insert(memoryNotes).values({
      serverId, authorId: userId, scope, body,
      channelId: scope === "channel" ? targetId : undefined,
      agentId: scope === "agent" ? targetId : undefined,
    }).returning(noteFields);
    return reply.code(201).send(note);
  });

  app.delete(`${path}/:noteId`, async (request, reply) => {
    const access = await workspace(request, reply);
    if (!access) return;
    const parsed = params.extend({ noteId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Provide a valid note ID." });
    const [removed] = await db.delete(memoryNotes).where(and(
      eq(memoryNotes.serverId, access.serverId), eq(memoryNotes.id, parsed.data.noteId), eq(memoryNotes.authorId, access.userId),
    )).returning({ id: memoryNotes.id });
    return removed ? reply.code(204).send() : reply.code(404).send({ error: "Note not found." });
  });
};
