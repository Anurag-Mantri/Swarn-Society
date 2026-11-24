import { describe, expect, it } from "vitest";
import { SandboxRunner } from "./runner.js";

describe("sandbox runner", () => {
  it("fails closed when no sandbox backend is configured", async () => {
    await expect(new SandboxRunner().run({
      t: "task", channelId: "c1", from: "u1", agent: "scout", text: "untrusted prompt",
    }, new AbortController().signal)).rejects.toThrow("task was not executed");
  });
});
