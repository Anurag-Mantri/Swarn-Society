import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { hasChannelPermission } from "./channel-access.js";
import { db } from "./db/index.js";
import { channels } from "./db/schema.js";

export const taskChannelParams = z.object({ channelId: z.string().uuid() });
export const taskPostParams = taskChannelParams.extend({ taskId: z.string().uuid() });

export async function taskChannel(request: FastifyRequest, reply: FastifyReply, requiredPermission: number) {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = taskChannelParams.safeParse(request.params);
  if (!params.success) {
    await reply.code(400).send({ error: "Provide a valid task channel ID." });
    return;
  }
  const [channel] = await db.select().from(channels)
    .where(and(eq(channels.id, params.data.channelId), eq(channels.kind, "task"))).limit(1);
  if (!channel) {
    await reply.code(404).send({ error: "Task channel not found." });
    return;
  }
  if (!await hasChannelPermission(channel, user.id, requiredPermission)) {
    await reply.code(403).send({ error: "You do not have permission for this action in the task channel." });
    return;
  }
  return { channel, user };
}
