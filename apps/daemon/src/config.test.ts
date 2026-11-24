import { describe, expect, it } from "vitest";
import { loadDaemonConfig } from "./config.js";

describe("daemon configuration", () => {
  it("parses a secure websocket URL and unique agent names", () => {
    const config = loadDaemonConfig({
      SWARMROOM_CONTROL_PLANE_URL: "wss://example.test/ws",
      SWARMROOM_MACHINE: "dev laptop",
      SWARMROOM_AGENTS: "scout,reviewer,scout",
    });
    expect(config.agents).toEqual(["scout", "reviewer"]);
  });

  it("rejects insecure or unexpected websocket endpoints", () => {
    expect(() => loadDaemonConfig({
      SWARMROOM_CONTROL_PLANE_URL: "https://example.test/ws",
      SWARMROOM_MACHINE: "laptop",
      SWARMROOM_AGENTS: "scout",
    })).toThrow();
    expect(loadDaemonConfig({
      SWARMROOM_CONTROL_PLANE_URL: "ws://localhost:3000/ws",
      SWARMROOM_MACHINE: "laptop",
      SWARMROOM_AGENTS: "scout",
    }).controlPlaneUrl.protocol).toBe("ws:");
  });

  it("ignores host tokens in environment variables", () => {
    const config = loadDaemonConfig({
      SWARMROOM_CONTROL_PLANE_URL: "wss://example.test/ws",
      SWARMROOM_MACHINE: "laptop",
      SWARMROOM_AGENTS: "scout",
      SWARMROOM_HOST_TOKEN: "secret",
    });
    expect(config).not.toHaveProperty("token");
  });
});
