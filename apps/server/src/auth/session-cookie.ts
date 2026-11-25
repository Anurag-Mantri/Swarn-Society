import type { FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { createSecret, hashSecret } from "../security.js";

export async function setSessionCookie(reply: FastifyReply, userId: string, seconds: number): Promise<void> {
  const secret = createSecret();
  await db.insert(sessions).values({
    userId, secretHash: hashSecret(secret), expiresAt: new Date(Date.now() + seconds * 1000),
  });
  reply.setCookie("session", secret, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: seconds,
  });
}
