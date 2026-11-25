import { z } from "zod";

const id = z.string().uuid();
export const voiceTokenTtlSeconds = 120;

export const liveKitUrlSchema = z.string().max(500).url().refine((value) => {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "wss:" || (url.protocol === "ws:" && local));
  } catch {
    return false;
  }
});

export const voiceGrantSchema = z.object({
  url: liveKitUrlSchema,
  token: z.string().max(8192).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
}).strict();

export const voiceTokenRequestSchema = z.object({
  t: z.literal("voice.token.request"),
  requestId: id,
  serverId: id,
  channelId: id,
  userId: id,
  displayName: z.string().trim().min(1).max(100),
  canPublish: z.boolean(),
}).strict();

export const voiceTokenResponseSchema = z.object({
  t: z.literal("voice.token.response"),
  requestId: id,
  grant: voiceGrantSchema.nullable(),
}).strict();

export const voiceHostSelectionSchema = z.object({ hostId: id.nullable() }).strict();

export type VoiceTokenRequest = z.infer<typeof voiceTokenRequestSchema>;
export type VoiceTokenResponse = z.infer<typeof voiceTokenResponseSchema>;
export type VoiceGrant = z.infer<typeof voiceGrantSchema>;
export type VoiceJoin = VoiceGrant & { canPublish: boolean };
export type VoiceSettings = {
  hostId: string | null;
  hosts: Array<{ id: string; machineLabel: string; connected: boolean }>;
};
