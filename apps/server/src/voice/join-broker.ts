import { randomUUID } from "node:crypto";
import type { VoiceGrant, VoiceTokenRequest, VoiceTokenResponse } from "@swarmroom/protocol";

const maxPending = 256;
const perHostLimit = 32;
const timeoutMs = 4_000;

export type VoiceConnection = {
  connectionId: string;
  send: (frame: VoiceTokenRequest) => void;
};

type PendingJoin = {
  connectionId: string;
  finish: (grant: VoiceGrant | null) => void;
};

export class VoiceJoinBroker {
  private readonly pending = new Map<string, PendingJoin>();

  request(connection: VoiceConnection, params: Omit<VoiceTokenRequest, "t" | "requestId">): Promise<VoiceGrant | null> {
    const inflight = [...this.pending.values()].filter(({ connectionId }) => connectionId === connection.connectionId);
    if (this.pending.size >= maxPending || inflight.length >= perHostLimit) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (grant: VoiceGrant | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(grant);
      };
      const timer = setTimeout(() => finish(null), timeoutMs).unref();
      this.pending.set(requestId, { connectionId: connection.connectionId, finish });
      try {
        connection.send({ ...params, requestId, t: "voice.token.request" });
      } catch {
        finish(null);
      }
    });
  }

  accept(connectionId: string, response: VoiceTokenResponse) {
    const pending = this.pending.get(response.requestId);
    if (pending?.connectionId === connectionId) pending.finish(response.grant);
  }

  close(connectionId: string) {
    for (const pending of this.pending.values()) {
      if (pending.connectionId === connectionId) pending.finish(null);
    }
  }
}
