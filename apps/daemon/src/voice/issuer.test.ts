import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { createVoiceIssuer, loadVoiceConfig } from "./issuer.js";

const id = (last: number) => `00000000-0000-4000-8000-00000000000${last}`;
const request = {
  t: "voice.token.request" as const, requestId: id(1), serverId: id(2), channelId: id(3),
  userId: id(4), displayName: "Speaker", canPublish: true,
};
const credentials = { apiKey: "test-signing-key", apiSecret: "test-signing-secret-at-least-32-bytes" };

describe("voice signing on the host", () => {
  it("grants access to one room with a short expiry and limits publishing to microphone audio", async () => {
    const settings = loadVoiceConfig({
      SWARMROOM_LIVEKIT_URL: "wss://voice.example.test", SWARMROOM_LIVEKIT_WORKSPACES: id(2),
    })!;
    const signer = createVoiceIssuer(settings, credentials);
    const output = await signer(request);
    expect(output?.url).toBe(settings.url);
    const verifier = new TokenVerifier(credentials.apiKey, credentials.apiSecret);
    const claims = await verifier.verify(output!.token);
    expect(claims.sub).toBe(request.userId);
    expect(claims.name).toBe(request.displayName);
    expect(claims.exp! - claims.nbf!).toBe(120);
    expect(claims.video).toMatchObject({
      room: `swarmroom-${id(2)}-${id(3)}`, roomJoin: true, canPublish: true, canSubscribe: true,
      canPublishData: false, canPublishSources: ["microphone"],
    });
    const readOnly = await verifier.verify((await signer({ ...request, canPublish: false }))!.token);
    expect(readOnly.video).toMatchObject({ canPublish: false, canSubscribe: true, canPublishData: false });
    expect(readOnly.video?.canPublishSources).toBeUndefined();
    await expect(signer({ ...request, serverId: id(5) })).resolves.toBeNull();
  });

  it("allows unsecured LiveKit only on loopback and requires workspace consent", () => {
    expect(loadVoiceConfig({})).toBeUndefined();
    expect(() => loadVoiceConfig({ SWARMROOM_LIVEKIT_URL: "wss://voice.example.test" })).toThrow();
    for (const url of ["not-a-url", "ws://voice.example.test", "wss://secret@voice.example.test", "wss://voice.example.test?token=example"]) {
      expect(() => loadVoiceConfig({ SWARMROOM_LIVEKIT_URL: url, SWARMROOM_LIVEKIT_WORKSPACES: id(2) }))
        .toThrow("secure LiveKit");
    }
    expect(loadVoiceConfig({
      SWARMROOM_LIVEKIT_URL: "ws://127.0.0.1:7880", SWARMROOM_LIVEKIT_WORKSPACES: id(2),
    })?.url).toBe("ws://127.0.0.1:7880");
  });
});
