import {
  allowInsecureRequests, customFetch, discovery, enableNonRepudiationChecks, None, type Configuration, type CustomFetch,
} from "openid-client";
import type { OidcProvider } from "./oidc-settings.js";

export async function openOidcProvider(provider: OidcProvider, fetch?: CustomFetch): Promise<Configuration> {
  const issuer = new URL(provider.issuer);
  const execute = [enableNonRepudiationChecks];
  if (issuer.protocol === "http:") execute.push(allowInsecureRequests);
  const client = await discovery(issuer, provider.clientId, {
    id_token_signed_response_alg: provider.signingAlgorithm,
    token_endpoint_auth_method: "none",
  }, None(), { execute, timeout: 8, ...(fetch && { [customFetch]: fetch }) });
  if (!client.serverMetadata().supportsPKCE("S256")) throw new Error("The OIDC provider must support S256 PKCE.");
  return client;
}
