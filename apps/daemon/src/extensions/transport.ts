import type { AdapterFrame, HostServerFrame } from "@swarmroom/protocol";

type Ack = Extract<HostServerFrame, { t: "adapter.ack" }>;
type Failure = Extract<HostServerFrame, { t: "error" }>;
type Expectation = Pick<Ack, "action" | "id">;

export type AdapterExchange = (frame: AdapterFrame, expected: Expectation) => Promise<void>;
export type AdapterReporter = (exchange: AdapterExchange, signal: AbortSignal) => Promise<void>;

export class AdapterTransport {
  private pending: {
    expected: Expectation;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | undefined;

  constructor(private readonly send: (frame: AdapterFrame) => boolean) {}

  exchange: AdapterExchange = (frame, expected) => {
    if (this.pending) return Promise.reject(new Error("An adapter frame is waiting for acknowledgement."));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("The host did not receive an adapter acknowledgement."), 5_000);
      this.pending = { expected, timer, resolve, reject };
      try {
        if (!this.send(frame)) this.fail("The adapter connection is offline.");
      } catch {
        this.fail("The adapter frame could not be sent.");
      }
    });
  };

  receive(frame: Ack | Failure): void {
    if (frame.t === "error") {
      this.fail("The control plane denied an adapter operation.");
      return;
    }
    if (this.pending?.expected.id !== frame.id || this.pending.expected.action !== frame.action) return;
    const pending = this.clear();
    pending?.resolve();
  }

  close(): void {
    this.fail("The adapter connection closed.");
  }

  private fail(message: string): void {
    this.clear()?.reject(new Error(message));
  }

  private clear() {
    const pending = this.pending;
    if (pending) clearTimeout(pending.timer);
    this.pending = undefined;
    return pending;
  }
}
