import { randomUUID } from "node:crypto";

export type HostRequestConnection<Frame> = {
  connectionId: string;
  send: (frame: Frame) => void;
};

type PendingRequest<Result> = {
  connectionId: string;
  finish: (result: Result | null) => void;
};

export class HostRequestBroker<Frame, Result> {
  private readonly pending = new Map<string, PendingRequest<Result>>();

  constructor(
    private readonly timeoutMs: number,
    private readonly perHostLimit: number,
    private readonly maxPending: number,
  ) {}

  request(connection: HostRequestConnection<Frame>, frame: (requestId: string) => Frame): Promise<Result | null> {
    const inflight = [...this.pending.values()].filter(({ connectionId }) => connectionId === connection.connectionId);
    if (this.pending.size >= this.maxPending || inflight.length >= this.perHostLimit) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (result: Result | null) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), this.timeoutMs).unref();
      this.pending.set(requestId, { connectionId: connection.connectionId, finish });
      try {
        connection.send(frame(requestId));
      } catch {
        finish(null);
      }
    });
  }

  accept(connectionId: string, requestId: string, result: Result | null) {
    const pending = this.pending.get(requestId);
    if (pending?.connectionId === connectionId) pending.finish(result);
  }

  close(connectionId: string) {
    for (const pending of this.pending.values()) {
      if (pending.connectionId === connectionId) pending.finish(null);
    }
  }
}
