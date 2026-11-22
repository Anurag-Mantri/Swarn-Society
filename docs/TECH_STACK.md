# Tech Stack

TypeScript everywhere, Rust only for the desktop shell. Shared types live in `packages/protocol`.

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm + Turborepo | |
| Client | SvelteKit (SPA mode) + TypeScript | Alternatives considered: SolidJS, Vue, Lit |
| Styling | CSS variables, Tailwind optional | Light/dark tokens |
| Editor | Monaco | VSCode's editor |
| Terminal | xterm.js | |
| Collab | Yjs + Hocuspocus + y-monaco | |
| Desktop shell | Tauri 2 | Electron as fallback |
| Backend | Node 22, Fastify (or Hono) | |
| Realtime | `ws` / uWebSockets.js | Typed event protocol |
| Validation | Zod | All inbound messages |
| Database | Postgres + Drizzle ORM | |
| Cache/pubsub | Redis (NATS later) | |
| Search | Postgres FTS, Meilisearch later | |
| Storage | Cloudflare R2 (S3 API) | |
| Auth | GitHub OAuth via Better Auth (or Clerk) | |
| Voice | LiveKit | |
| GitHub | GitHub App + Octokit; simple-git on host | |
| Agent runtime | Claude Agent SDK + provider adapters; MCP for tools | |
| Sandboxing | Docker/Podman; macOS `sandbox-exec`/Apple container; gVisor/Firecracker in cloud | |
| Secrets | OS keychain | |
| Observability | OpenTelemetry, Sentry, PostHog | |
| Testing | Vitest, Playwright | |
| CI/CD | GitHub Actions | Signed desktop builds |
| Hosting | Fly.io / Render / Railway; Kubernetes + Terraform later | |
| Billing | Stripe | |

## Free development baseline
- Use no paid service for the MVP.
- Run Postgres, Redis and LiveKit locally in Docker if needed.
- Use GitHub OAuth and GitHub Actions for free development workflows.
- Use no analytics or error tracker until consent and budget are established.
- Self-host LiveKit before considering managed LiveKit.
- Model API credentials and usage stay on the host and are paid directly by its owner.
- Code-signing certificates, paid hosting, Sentry, PostHog and Stripe are launch or scale decisions, not MVP dependencies.

## Do not use
- **React** (and Next.js, React Native for the client). Decision recorded in `DECISIONS.md`.
- Storing API keys on the server in any form.
- Executing agent tools outside the sandbox module.
- ORMs or query builders other than Drizzle without a decision entry.

## Prototype note
`server.js`, `daemon.js` and `public/index.html` use plain Node and vanilla JS with the `ws` package. They are replaced during Phase 1.
