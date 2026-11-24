import { eq, and, isNull, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db/index.js";
import { sessions, users } from "./db/schema.js";
import { hashSecret } from "./security.js";

export async function getSessionUser(request: FastifyRequest) {
  return getUserBySessionSecret(request.cookies.session);
}

export async function getUserBySessionSecret(secret: string | undefined) {
  if (!secret) return null;

  const rows = await db.select({
    user: users,
  }).from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.secretHash, hashSecret(secret)),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, new Date()),
    ))
    .limit(1);

  return rows[0]?.user ?? null;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getSessionUser(request);
  if (!user) {
    await reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}
