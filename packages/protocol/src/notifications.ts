import { z } from "zod";

export const markChannelReadSchema = z.object({ messageId: z.string().uuid() }).strict();

export type ChannelUnread = { channelId: string; count: number };
