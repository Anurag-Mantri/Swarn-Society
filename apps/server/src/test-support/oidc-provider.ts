import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { CustomFetch } from "openid-client";

type Grant = { nonce: string; challenge: string; redirectUri: string; group: string; invalidSignature: boolean };

export function createMockOidcProvider(issuer = "https://identity.example.test/organization") {
  const clientId = "swarmroom-public";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const grants = new Map<string, Grant>();
  let tokenRequests = 0;

  function authorize(input: URL, group = "engineering", invalidSignature = false) {
    const params = input.searchParams;
    const code = randomUUID();
    grants.set(code, {
      nonce: params.get("nonce") ?? "",
      challenge: params.get("code_challenge") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      group,
      invalidSignature,
    });
    return code;
  }

  function issue(grant: Grant) {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
    const payload = encode({
      iss: issuer, aud: clientId, sub: "enterprise-user",
      iat: now, exp: now + 600, nonce: grant.nonce, name: "Enterprise teammate",
      groups: [grant.group],
    });
    const data = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(data), key.privateKey);
    if (grant.invalidSignature) signature[0] = (signature[0]! + 1) % 256;
    return `${data}.${signature.toString("base64url")}`;
  }

  const fetch: CustomFetch = async (url, options) => {
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"],
        subject_types_supported: ["public"], code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" }] });
    }
    if (url === `${issuer}/token` && options.method === "POST") {
      tokenRequests += 1;
      const params = new URLSearchParams(String(options.body));
      const code = params.get("code") ?? "";
      const grant = grants.get(code);
      grants.delete(code);
      const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      if (!grant || grant.challenge !== challenge || grant.redirectUri !== params.get("redirect_uri") ||
          params.get("client_id") !== clientId || params.get("client_secret") !== null) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: "unused-test-token", token_type: "Bearer", id_token: issue(grant), expires_in: 600,
      });
    }
    return Response.json({}, { status: 404 });
  };

  return { issuer, clientId, authorize, fetch, requests: () => tokenRequests };
}
