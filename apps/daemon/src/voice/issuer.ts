import { liveKitUrlSchema, voiceTokenTtlSeconds, type VoiceGrant, type VoiceTokenRequest } from "@swarmroom/protocol";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { z } from "zod";

export const liveKitCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1).max(256),
  apiSecret: z.string().min(6).max(512),
}).strict();

export type VoiceTokenIssuer = (request: VoiceTokenRequest) => Promise<VoiceGrant | null>;

export function loadVoiceConfig(env: NodeJS.ProcessEnv) {
  const url = env.SWARMROOM_LIVEKIT_URL?.trim();
  const ids = env.SWARMROOM_LIVEKIT_WORKSPACES?.split(",").map((id) => id.trim().toLowerCase());
  if (!url && !ids) return undefined;
  const parsedUrl = liveKitUrlSchema.safeParse(url);
  const spaces = z.array(z.string().uuid()).min(1).max(100).safeParse(ids);
  if (!parsedUrl.success || !spaces.success) {
    throw new Error("Voice requires a secure LiveKit WebSocket URL and an explicit list of workspace IDs.");
  }
  return { url: parsedUrl.data, workspaces: new Set(spaces.data) };
}

export function createVoiceIssuer(
  config: NonNullable<ReturnType<typeof loadVoiceConfig>>,
  credentials: z.infer<typeof liveKitCredentialsSchema>,
): VoiceTokenIssuer {
  const { apiKey, apiSecret } = liveKitCredentialsSchema.parse(credentials);
  return async ({ userId, serverId, channelId, displayName, canPublish }) => {
    if (!config.workspaces.has(serverId)) return null;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: userId, name: displayName, ttl: voiceTokenTtlSeconds,
    });
    token.addGrant({
      roomJoin: true, room: `swarmroom-${serverId}-${channelId}`, canPublish, canSubscribe: true,
      canPublishData: false, ...(canPublish && { canPublishSources: [TrackSource.MICROPHONE] }),
    });
    return { url: config.url, token: await token.toJwt() };
  };
}
