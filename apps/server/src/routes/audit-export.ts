import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission, readableChannelIds } from "../channel-access.js";
import { db } from "../db/index.js";
import { channels, creditEntries, extensionManifests, taskPosts } from "../db/schema.js";
import { permissions } from "../permissions.js";

const paramsSchema = z.object({ serverId: z.string().uuid() });
const cursorSchema = z.object({
  at: z.string().datetime(),
  id: z.string().regex(/^[a-z.]+:[a-f0-9-]{36}$/),
}).strict();
const querySchema = z.object({
  after: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
}).strict();
type AuditRow = {
  id: string;
  at: string;
  action: string;
  subjectId: string;
  actorId: string | null;
  channelId: string | null;
};

function decodeCursor(value: string) {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
  catch { return null; }
}

export const auditExportRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/servers/:serverId/audit/export", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Provide a valid workspace ID and export query." });
    const cursor = query.data.after ? decodeCursor(query.data.after) : undefined;
    if (cursor === null) return reply.code(400).send({ error: "Provide a valid audit export cursor." });
    const { serverId } = params.data;
    if (!await hasServerPermission(serverId, user.id, permissions.manageRoles | permissions.manageMembers)) {
      return reply.code(403).send({ error: "You cannot export audit records in this workspace." });
    }
    const visible = await readableChannelIds(serverId, user.id);
    const channelScope = visible.length
      ? sql`${taskPosts.channelId} in (${sql.join(visible.map((id) => sql`${id}`), sql`, `)})`
      : sql`false`;
    const tasks = and(eq(channels.serverId, serverId), channelScope);
    const before = cursor ? sql`where (at, id) < (${cursor.at}::timestamptz, ${cursor.id})` : sql``;
    const result = await db.execute<AuditRow>(sql`
      with events as (
        select 'task.posted:' || ${taskPosts.id} as id, ${taskPosts.createdAt} as at,
          'task.posted' as action, ${taskPosts.id} as "subjectId",
          ${taskPosts.createdBy} as "actorId", ${taskPosts.channelId} as "channelId"
        from ${taskPosts} join ${channels} on ${channels.id} = ${taskPosts.channelId} where ${tasks}
        union all
        select 'task.assigned:' || ${taskPosts.id}, ${taskPosts.claimedAt},
          'task.assigned', ${taskPosts.id}, null::uuid, ${taskPosts.channelId}
        from ${taskPosts} join ${channels} on ${channels.id} = ${taskPosts.channelId}
        where ${tasks} and ${taskPosts.claimedAt} is not null
        union all
        select 'task.resolved:' || ${taskPosts.id}, ${taskPosts.resolvedAt},
          'task.' || ${taskPosts.resolution}, ${taskPosts.id}, ${taskPosts.resolvedBy}, ${taskPosts.channelId}
        from ${taskPosts} join ${channels} on ${channels.id} = ${taskPosts.channelId}
        where ${tasks} and ${taskPosts.resolvedAt} is not null
        union all
        select 'extension.registered:' || ${extensionManifests.id}, ${extensionManifests.createdAt},
          'extension.registered', ${extensionManifests.id}, ${extensionManifests.registeredBy}, null::uuid
        from ${extensionManifests} where ${extensionManifests.serverId} = ${serverId}
        union all
        select 'credit.recorded:' || ${creditEntries.id}, ${creditEntries.createdAt},
          case when ${creditEntries.fromId} is null then 'credit.issued' else 'credit.transferred' end,
          ${creditEntries.id}, ${creditEntries.actorId}, null::uuid
        from ${creditEntries} where ${creditEntries.serverId} = ${serverId}
      )
      select id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
        action, "subjectId", "actorId", "channelId" from events ${before}
      order by events.at desc, id desc limit ${query.data.limit + 1}
    `);
    const events = result.rows.slice(0, query.data.limit);
    const last = events.at(-1);
    const nextCursor = result.rows.length > events.length && last
      ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null;
    return reply.header("Cache-Control", "no-store")
      .header("Content-Disposition", 'attachment; filename="swarmroom-audit.json"')
      .send({ serverId, events, nextCursor });
  });
};
