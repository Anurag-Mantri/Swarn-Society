import { describe, expect, it } from "vitest";
import { hostClientFrameSchema, hostSchema, hostServerFrameSchema, inboundFrameSchema, initSchema, messageSchema } from "./index.js";

describe("protocol", () => {
  it("reads older channel listings as text and preserves explicit kinds", () => {
    const init = initSchema.parse({
      t: "init",
      channels: [{ id: "old", name: "General" }, { id: "new", name: "Tasks", kind: "task" }],
      agents: [],
    });
    expect(init.channels.map(({ kind }) => kind)).toEqual(["text", "task"]);
  });

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

  it("validates host-only frames in both directions", () => {
    expect(hostClientFrameSchema.parse({
      t: "host.heartbeat",
    })).toEqual({ t: "host.heartbeat" });
    expect(hostServerFrameSchema.parse({
      t: "task",
      channelId: "channel-1",
      from: "user-1",
      agent: "scout",
      text: "inspect this",
    }).t).toBe("task");
    expect(() => hostClientFrameSchema.parse({ t: "msg", channelId: "channel-1", text: "hello" })).toThrow();
  });

  it("validates bounded host-reported token usage", () => {
    expect(hostClientFrameSchema.parse({
      t: "agent.usage",
      channelId: "channel-1",
      agent: "scout",
      requesterId: "00000000-0000-4000-8000-000000000001",
      tokensIn: 400,
      tokensOut: 120,
    })).toMatchObject({ t: "agent.usage", tokensIn: 400, tokensOut: 120 });
    expect(() => hostClientFrameSchema.parse({
      t: "agent.usage",
      channelId: "channel-1",
      agent: "scout",
      requesterId: "user-1",
      tokensIn: -1,
      tokensOut: 0,
    })).toThrow();
  });
});
