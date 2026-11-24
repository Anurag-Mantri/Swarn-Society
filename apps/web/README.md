# Swarmroom web

The SvelteKit client uses Fastify for sign-in, workspace and channel management, and live chat. Workspace and message data are stored by the control plane in PostgreSQL.

## Development

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Start PostgreSQL and apply the migrations with `pnpm --filter @swarmroom/server db:migrate`.
3. Register a GitHub OAuth app with the callback `http://localhost:5173/auth/github/callback` and set the server's OAuth configuration to match.
4. Start the server on port 3000 with `pnpm --filter @swarmroom/server dev`.
5. Run `pnpm --filter @swarmroom/protocol build`, then `pnpm --filter @swarmroom/web dev`. Open `http://localhost:5173`.

Vite proxies `/api`, `/auth`, `/ws`, and `/collaboration` to Fastify. The browser uses its HttpOnly cookie to authenticate the WebSocket.

## Build

Run `pnpm build`. Serve `apps/web/dist` and route `/api`, `/auth`, `/ws`, and `/collaboration` to Fastify under the same public origin. Configure `GITHUB_CALLBACK_URL` with that public origin and enable WebSocket upgrades for `/ws` and `/collaboration`.
