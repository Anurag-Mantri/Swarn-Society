import { describe, expect, it } from "vitest";
import { inboundFrameSchema, hostSchema, messageSchema } from "./index.js";

describe("protocol", () => {
  it("accepts valid messages", () => {
    expect(messageSchema.parse({
      t: "msg",
      channelId: "channel-1",
      text: "hello",
    }).text).toBe("hello");
  });

  it("rejects unknown fields", () => {
    expect(() => hostSchema.parse({
      t: "host",
      token: "secret",
      machine: "laptop",
      agents: ["scout"],
      extra: true,
    })).toThrow();
  });

  it("rejects unknown frame types", () => {
    expect(() => inboundFrameSchema.parse({
      t: "unknown",
    })).toThrow();
  });
});
