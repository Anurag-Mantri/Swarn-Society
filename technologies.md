Technologies Needed for Swarmroom
Core runtime and tooling
Node.js 22+ and TypeScript for the control plane, daemon and client
pnpm and Turborepo for the monorepo
Git for version control and for the daemon’s GitHub sync
Docker (or Podman) to package and deploy the control plane and to sandbox agents on host machines
Rust toolchain if you go with Tauri for the desktop shell
Front end
SvelteKit (or SolidJS/Vue) with TypeScript
Monaco Editor for the VSCode-style workspace
xterm.js for terminal panes
Tailwind or plain CSS variables for styling
Yjs and y-monaco for real-time collaborative editing
Backend
Fastify or Hono
WebSockets (ws or uWebSockets.js) for realtime and daemon connections
Postgres with Drizzle ORM for messages, roles, agent registry and the ledger
Redis for presence, pub/sub and queues
Hocuspocus as the Yjs sync server
Zod for validating protocol messages
Host daemon (runs on users’ computers)
Tauri 2 (or Electron) as the desktop shell
Claude Agent SDK plus adapters for other model providers
MCP (Model Context Protocol) for agent tools
Docker/Podman (Linux, Windows via WSL2) or Apple container / sandbox-exec (macOS) for sandboxing agents
OS keychain libraries (Keychain, Credential Manager, libsecret) for API keys and env variables
simple-git or isomorphic-git for repo operations
Integrations
GitHub App and Octokit for branch pushes, webhooks and ahead/behind status
GitHub OAuth through Better Auth or Clerk for login
LiveKit for voice channels, with video and screen share later
Stripe for billing
Storage and infrastructure
S3-compatible storage (Cloudflare R2) for attachments
Fly.io, Render or Railway to host the first deployment
Kubernetes and Terraform later, for the cloud-host tier
gVisor or Firecracker for sandboxing cloud-hosted agents
Quality, security and operations
Vitest and Playwright for testing
GitHub Actions for CI/CD and signed desktop builds
Apple Developer ID and a Windows code-signing certificate for installers
OpenTelemetry, Sentry and PostHog for observability
Meilisearch for message search, once Postgres full-text search is outgrown
What you need for the first deployable version

Node.js, TypeScript, Git, Docker, Postgres, a WebSocket library, GitHub OAuth, and a host like Fly.io or Render. The prototype I built already runs on Node and Docker alone, so you can add the rest phase by phase.