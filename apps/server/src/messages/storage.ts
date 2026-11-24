import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { recordKnowledgeEvent } from "../knowledge/storage.js";

export function storeMessage(
  input: typeof messages.$inferInsert,
  serverId: string,
  author: { kind: "person" | "agent"; id: string },
) {
  return db.transaction(async (transaction) => {
    const [message] = await transaction.insert(messages).values(input).returning({
      id: messages.id, createdAt: messages.createdAt,
    });
    if (!message) throw new Error("Message insert did not return an ID");
    await recordKnowledgeEvent(transaction, {
      type: "message.posted", sourceId: message.id, occurredAt: message.createdAt.toISOString(),
      serverId, channelId: input.channelId, messageId: message.id, author,
    });
    return message;
  });
}
