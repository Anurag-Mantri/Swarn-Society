import { describe, expect, it } from "vitest";
import { loadOidcWorkspaces } from "./oidc-settings.js";

const workspace = "aaaaaaaa-0000-4000-8000-000000000001";
const env = (issuer: string, NODE_ENV = "production") => ({
  NODE_ENV,
  SWARMROOM_OIDC_WORKSPACES: JSON.stringify({
    [workspace.toUpperCase()]: { issuer, clientId: "swarmroom-enterprise", requiredGroup: "engineering" },
  }),
});

describe("enterprise identity provider configuration", () => {
  it("normalizes workspace IDs and supports public OIDC clients", () => {
    expect(loadOidcWorkspaces({}).size).toBe(0);
    expect(loadOidcWorkspaces(env("https://login.example.org/organizations/engineering")).get(workspace))
      .toMatchObject({ clientId: "swarmroom-enterprise", requiredGroup: "engineering", signingAlgorithm: "RS256" });
  });

  it("requires HTTPS in production and permits plain HTTP only on loopback in development", () => {
    expect(loadOidcWorkspaces(env("http://localhost:9550", "test")).size).toBe(1);
    for (const url of ["http://localhost:9550", "http://login.example.org", "https://user@login.example.org", "https://login.example.org?token=test"]) {
      expect(() => loadOidcWorkspaces(env(url))).toThrow("trusted OIDC issuers");
    }
    expect(() => loadOidcWorkspaces(env("http://login.example.org", "test"))).toThrow();
  });
});
