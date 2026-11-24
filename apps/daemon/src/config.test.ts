import { describe, expect, it } from "vitest";
import { loadDaemonConfig, loadSandboxConfig } from "./config.js";

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

  it("rejects credentials and query parameters embedded in the server URL", () => {
    expect(() => loadDaemonConfig({
      SWARMROOM_CONTROL_PLANE_URL: "wss://example.test/ws?token=secret",
      SWARMROOM_MACHINE: "laptop",
      SWARMROOM_AGENTS: "scout",
    })).toThrow();
  });
});

describe("sandbox configuration", () => {
  it("requires a digest-pinned image and one absolute workspace per agent", () => {
    const image = `registry.example/agent@sha256:${"a".repeat(64)}`;
    expect(loadSandboxConfig({
      SWARMROOM_SANDBOX_IMAGE: image,
      SWARMROOM_AGENT_WORKSPACES: JSON.stringify({ scout: "/tmp/scout-workspace" }),
    }, ["scout"])).toEqual({ image, workspaces: new Map([["scout", "/tmp/scout-workspace"]]) });
  });

  it("rejects unpinned images and missing workspaces", () => {
    expect(() => loadSandboxConfig({
      SWARMROOM_SANDBOX_IMAGE: "registry.example/agent:latest",
      SWARMROOM_AGENT_WORKSPACES: JSON.stringify({ scout: "/tmp/scout-workspace" }),
    }, ["scout"])).toThrow();
    expect(() => loadSandboxConfig({
      SWARMROOM_SANDBOX_IMAGE: `registry.example/agent@sha256:${"a".repeat(64)}`,
      SWARMROOM_AGENT_WORKSPACES: JSON.stringify({ scout: "/tmp/scout-workspace", other: "/tmp/other" }),
    }, ["scout"])).toThrow();
  });
});
