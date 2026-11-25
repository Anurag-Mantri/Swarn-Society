# Workspace single sign-on

Workspace SSO uses an administrator-configured OpenID Connect identity provider. Configure a public authorization-code client that supports S256 PKCE and signs ID tokens. The provider controls who may sign in to that client. A workspace can also require a group claim.

## Configure a workspace

1. Create the workspace with an existing account and copy its UUID from the workspace directory API or database.
2. Register this workspace's exact callback URL with the identity provider. Use the same public origin as the control plane's configured GitHub callback.

   ```text
   https://swarmroom.example.com/auth/sso/<workspace-uuid>/callback
   ```

3. Set `SWARMROOM_OIDC_WORKSPACES` on the server. The JSON object maps workspace UUIDs to public OIDC settings.

   ```json
   {
     "3c0115de-cac6-4a0c-877c-9f3384a54c43": {
       "issuer": "https://identity.example.com/realms/development",
       "clientId": "swarmroom-development",
       "requiredGroup": "engineering",
       "signingAlgorithm": "RS256"
     }
   }
   ```

   `requiredGroup` is optional. When present, the signed ID token's `groups` array must include it. `signingAlgorithm` defaults to `RS256`. Production uses HTTPS and needs an explicitly configured app session signing secret.

4. Apply the server database migrations, restart the server, and share `https://swarmroom.example.com/?sso=<workspace-uuid>` with members.

On successful first sign-in, Swarmroom provisions the identity into that workspace with its default Member role. Subsequent sign-ins preserve existing role assignments. The issuer and subject identify the account. GitHub identities and existing accounts remain separate even when profiles share a display name. Sessions expire after eight hours. Changing provider access blocks future sign-ins. Signing out revokes the active Swarmroom session.

The exchange configures discovery, PKCE, nonce checks, and ID token signature validation through OpenID Connect. The server stores the issuer, subject, and local user ID. Provider tokens are discarded after the exchange. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) · [OpenID client signature validation](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md)
