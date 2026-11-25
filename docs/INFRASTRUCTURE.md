# Infrastructure guide

Swarmroom needs a Fastify control plane, PostgreSQL, the static SvelteKit client, and a host daemon for each machine that runs agents. A single control-plane instance handles live chat and collaborative editing. Agent compute runs on the host that owns the sandbox.

## Local development

Run Node.js 22, the pnpm version from the root package manifest, and PostgreSQL 16, which matches CI. Start PostgreSQL and create an application database and role. Point the server and migration command at that database using `DATABASE_URL`. Keep the separate integration-test database disposable and give it a name ending in `_test`.

From the repository root, install the workspace and apply migrations:

```sh
pnpm install --frozen-lockfile
pnpm --filter @swarmroom/server db:migrate
pnpm --filter @swarmroom/protocol build
```

For browser sign-in, configure a GitHub OAuth app with the callback `http://localhost:5173/auth/github/callback` and set the server's `GITHUB_CALLBACK_URL` to that exact URL. Start the server and client in separate terminals:

```sh
pnpm --filter @swarmroom/server dev
pnpm --filter @swarmroom/web dev
```

Open the client at `http://localhost:5173`. The dev proxy forwards API calls, OAuth callbacks, chat WebSockets, and collaboration WebSockets to Fastify. Check the control plane with `curl --fail http://127.0.0.1:3000/health`.

## Self-hosting on existing machines

| Component | Where to run it |
|---|---|
| Client and Fastify | An always-on machine you manage, behind a TLS reverse proxy |
| PostgreSQL | The control-plane machine or a private database machine on the same network |
| Agent daemon | A teammate's Linux machine under a dedicated non-root account |
| Agent provider access | The daemon's allowlisted broker, with credentials in that host's OS keychain |

Build the release from a reviewed commit with `pnpm install --frozen-lockfile` and `pnpm build`. Apply migrations before starting `pnpm --filter @swarmroom/server start`. Serve `apps/web/dist` and route the application paths under one HTTPS origin. Restrict direct access to Fastify and PostgreSQL through the network firewall. Set `NODE_ENV=production` for secure session cookies and make the OAuth callback use the public HTTPS origin.

This Caddy example assumes Fastify listens on port 3000 on the proxy machine. Set the hostname and static build path for your release:

```caddyfile
swarmroom.example.com {
	@backend path /api/* /auth/* /ws /collaboration /health
	handle @backend {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		root * /srv/swarmroom/web
		try_files {path} /index.html
		file_server
	}
}
```

Caddy handles the WebSocket upgrade on both routes. Keep the incoming paths intact so they match the Fastify endpoints. [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

For agent hosts, check `podman info` under the same unprivileged account that runs the daemon. Confirm the account has subordinate UID and GID mappings and that its keychain service is available. Follow the daemon setup for digest-pinned images, per-agent workspace mounts, provider keys, and budgets. The daemon connects outbound to the control plane using `wss://`. [Host daemon setup](../apps/daemon/README.md) · [Rootless Podman setup](https://docs.podman.io/en/stable/markdown/podman.1.html#rootless-mode)

The default stack uses software you can run without a paid hosting account. Existing machines still carry storage, power, and network costs. Model API charges depend on each host owner's provider account and usage. GitHub snapshot publishing requires an App installation approved for the selected repository.

## Paid hosting options

| Upgrade | What to account for |
|---|---|
| Linux VM for the control plane | CPU, RAM, persistent disk, and transfer. Keep chat and collaborative editing on one instance until shared live state is implemented. |
| Managed PostgreSQL | Storage, backups, restore support, private connectivity, and connection limits. Keep the application database outside the public network. |
| Optional remote Linux agent hosts | Compute, persistent workspace volumes, and model API use. Verify rootless Podman, a persistent keychain, and outbound WebSocket access before onboarding an agent. |
| Managed DNS or a domain | Domain renewal and DNS management. Use the same public origin for the browser, OAuth callback, and control-plane proxy. |

A paid control plane does not move agent execution off a teammate's machine. Optional cloud agent hosts use the same daemon and sandbox boundary. The [remote Linux daemon package](../apps/daemon/README.md#deploy-the-daemon-to-a-remote-linux-host) runs under a dedicated account on the host.

## Backup and verification

1. Back up PostgreSQL before migrations and on a schedule that matches the team's recovery requirements. A custom-format dump from `pg_dump` can be restored with `pg_restore`. Keep backups private because they contain workspace files, chat, and task records. Test restoration into a separate database before relying on the backups. [PostgreSQL backup](https://www.postgresql.org/docs/16/app-pgdump.html) · [PostgreSQL restore](https://www.postgresql.org/docs/16/app-pgrestore.html)
2. Check `/health`, sign in from the public origin, and verify a message and thread reply survive a page reload.
3. Open a file in two signed-in browser sessions and verify both editors see a change. Restart the control plane during a maintenance window and confirm the saved state is restored.
4. Connect a test daemon and confirm it reports online, accepts an authorized task, and returns a sandboxed reply. Verify requester budget enforcement with a test policy before exposing the host to teammates.
