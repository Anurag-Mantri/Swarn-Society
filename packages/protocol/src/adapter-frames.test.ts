import { describe, expect, it } from "vitest";
import { adapterAckSchema, adapterFrameSchema } from "./adapter-frames.js";

const id = "00000000-0000-4000-8000-000000000001";
const resource = { t: "adapter.resource", sessionId: id, resourceId: id, resourceType: "document", extension: ".txt", byteLength: 12 };

describe("adapter protocol", () => {
  it.each([
    { t: "adapter.register", adapterId: id, manifestId: id, protocolVersion: 1 },
    { t: "adapter.session.start", adapterId: id, sessionId: id, channelId: id },
    resource,
    { t: "adapter.snapshot", sessionId: id, resourceId: id, snapshotId: id, format: "file-copy", sha256: "a".repeat(64), byteLength: 12 },
    { t: "adapter.session.stop", sessionId: id },
  ])("accepts a structured adapter frame", (frame) => {
    expect(adapterFrameSchema.parse(frame)).toEqual(frame);
  });

  it("rejects paths, shell arguments, file content, and unsafe values", () => {
    for (const extra of [{ path: "/tmp/document.txt" }, { command: "untrusted command" }, { content: "untrusted content" }]) {
      expect(adapterFrameSchema.safeParse({ ...resource, ...extra }).success).toBe(false);
    }
    expect(adapterFrameSchema.safeParse({ ...resource, byteLength: 33 * 1024 * 1024 }).success).toBe(false);
    expect(adapterFrameSchema.safeParse({ ...resource, extension: "../txt" }).success).toBe(false);
    expect(adapterFrameSchema.safeParse({ t: "adapter.register", adapterId: id, manifestId: id, protocolVersion: 2 }).success)
      .toBe(false);
  });

  it("validates an acknowledgement against the known actions", () => {
    expect(adapterAckSchema.parse({ t: "adapter.ack", action: "session.stop", id }).action).toBe("session.stop");
    expect(adapterAckSchema.safeParse({ t: "adapter.ack", action: "execute", id }).success).toBe(false);
  });
});
