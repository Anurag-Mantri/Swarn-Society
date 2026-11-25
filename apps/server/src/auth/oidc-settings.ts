import { workspaceSsoIdSchema } from "@swarmroom/protocol";
import { z } from "zod";

const provider = z.object({
  issuer: z.string().url().max(500),
  clientId: z.string().trim().min(1).max(250),
  requiredGroup: z.string().trim().min(1).max(250).optional(),
  signingAlgorithm: z.enum(["RS256", "RS384", "RS512", "ES256", "ES384", "EdDSA"]).default("RS256"),
}).strict();

export type OidcProvider = z.infer<typeof provider>;

function allowedIssuer(value: string, allowLocal: boolean): boolean {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || (allowLocal && loopback && url.protocol === "http:"));
}

export function loadOidcWorkspaces(env: NodeJS.ProcessEnv): ReadonlyMap<string, OidcProvider> {
  const value = env.SWARMROOM_OIDC_WORKSPACES?.trim();
  if (!value) return new Map();
  const message = "Configure workspace UUIDs and trusted OIDC issuers in SWARMROOM_OIDC_WORKSPACES.";
  try {
    const definitions = Object.entries(z.record(workspaceSsoIdSchema, provider).parse(JSON.parse(value)));
    if (definitions.length > 100 || definitions.some(([, definition]) => !allowedIssuer(definition.issuer, env.NODE_ENV !== "production"))) {
      throw new Error(message);
    }
    return new Map(definitions);
  } catch {
    throw new Error(message);
  }
}
