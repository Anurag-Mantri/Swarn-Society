import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { messages } from "./db/schema.js";

export async function threadRootExists(channelId: string, threadId: string): Promise<boolean> {
  const [root] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.channelId, channelId),
    eq(messages.id, threadId),
    isNull(messages.threadId),
  )).limit(1);
  return Boolean(root);
}
