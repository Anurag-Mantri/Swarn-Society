import { describe, expect, it } from "vitest";
import { loadAgentBudgetPolicies, loadAutoBidAgents, loadDaemonConfig, loadHostTokenPolicies, loadSandboxConfig } from "./config.js";

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

describe("agent budget configuration", () => {
  it("loads one ordered owner and token budget policy per configured agent", () => {
    const policies = loadAgentBudgetPolicies({
      SWARMROOM_AGENT_BUDGETS: JSON.stringify({
        scout: { ownerId: "owner-1", taskTokens: 10_000, hourTokens: 30_000, dayTokens: 100_000 },
      }),
    }, ["scout"]);
    expect(policies.get("scout")).toEqual({
      ownerId: "owner-1", taskTokens: 10_000, hourTokens: 30_000, dayTokens: 100_000,
    });
  });

  it("rejects missing agent policies, unknown agents, and inconsistent limits", () => {
    expect(() => loadAgentBudgetPolicies({
      SWARMROOM_AGENT_BUDGETS: JSON.stringify({
        scout: { ownerId: "owner-1", taskTokens: 10, hourTokens: 20, dayTokens: 30 },
      }),
    }, ["scout", "reviewer"])).toThrow();
    expect(() => loadAgentBudgetPolicies({
      SWARMROOM_AGENT_BUDGETS: JSON.stringify({
        scout: { ownerId: "owner-1", taskTokens: 30, hourTokens: 20, dayTokens: 40 },
      }),
    }, ["scout"])).toThrow();
  });
});


describe("host-wide token caps", () => {
  it("requires an ordered policy for every local agent when enabled", () => {
    expect(loadHostTokenPolicies({}, ["scout"]).size).toBe(0);
    const env = { SWARMROOM_HOST_TOKEN_CAPS: '{"scout":{"taskTokens":1000,"dayTokens":5000}}' };
    expect(loadHostTokenPolicies(env, ["scout"]).get("scout")).toEqual({ taskTokens: 1000, dayTokens: 5000 });
    expect(() => loadHostTokenPolicies(env, ["scout", "reviewer"])).toThrow("every configured agent");
    expect(() => loadHostTokenPolicies({
      SWARMROOM_HOST_TOKEN_CAPS: '{"scout":{"taskTokens":5000,"dayTokens":1000}}',
    }, ["scout"])).toThrow();
  });
});


describe("automatic bid opt-in", () => {
  it("requires the opted-in agent to have local host caps", () => {
    const limits = new Map([["scout", { taskTokens: 1000, dayTokens: 5000 }]]);
    expect(loadAutoBidAgents({}, ["scout"], limits)).toEqual([]);
    expect(loadAutoBidAgents({ SWARMROOM_AUTO_BID_AGENTS: "scout,scout" }, ["scout"], limits)).toEqual(["scout"]);
    expect(() => loadAutoBidAgents({ SWARMROOM_AUTO_BID_AGENTS: "scout" }, ["scout"], new Map())).toThrow("hard token caps");
    expect(() => loadAutoBidAgents({ SWARMROOM_AUTO_BID_AGENTS: "other" }, ["scout"], limits)).toThrow("configured");
  });
});
