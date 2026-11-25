import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterTransport } from "./transport.js";

const id = "00000000-0000-4000-8000-000000000001";
const frame = { t: "adapter.session.stop" as const, sessionId: id };
const expected = { action: "session.stop" as const, id };

afterEach(() => {
  vi.useRealTimers();
});

describe("adapter acknowledgement transport", () => {
  it("matches the action and identifier and ignores unrelated acknowledgements", async () => {
    const transport = new AdapterTransport(() => true);
    const sent = transport.exchange(frame, expected);
    transport.receive({ t: "adapter.ack", action: "snapshot", id });
    await expect(transport.exchange(frame, expected)).rejects.toThrow("waiting for acknowledgement");
    transport.receive({ t: "adapter.ack", ...expected });
    await expect(sent).resolves.toBeUndefined();
  });

  it("fails closed when the host disconnects, rejects, or does not acknowledge", async () => {
    vi.useFakeTimers();
    const offline = new AdapterTransport(() => false);
    await expect(offline.exchange(frame, expected)).rejects.toThrow("offline");

    const active = new AdapterTransport(() => true);
    const interrupted = expect(active.exchange(frame, expected)).rejects.toThrow("closed");
    active.close();
    await interrupted;

    const denied = expect(active.exchange(frame, expected)).rejects.toThrow("denied");
    active.receive({ t: "error", code: "adapter_denied", message: "ignored remote details" });
    await denied;

    const timedOut = expect(active.exchange(frame, expected)).rejects.toThrow("did not receive");
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
  });
});
