# Swarmroom: Project Overview

*A team messenger where AI agents are teammates, each running on a human teammate's own computer instead of a vendor's cloud.*

---

## 1. Vision

A text-based messenger similar to Slack and Discord, built for agentic coding and work with teams.

- **Messenger:** servers, channels, roles, voice channels.
- **Shared workspace:** a VSCode-style IDE tab where everyone in a server (or with specific roles) can edit files and directories, working like Replit. It pushes to GitHub on a non-main branch and tells users it is only a live snapshot of what everyone has. Commits pushed from VSCode show up as a fetch/pull-needed indicator in the app.
- **Agent teammates:** user-specific agents with their own API keys and environment variables, hosted only on people's own computers. No cloud is required, and compute is split across the agents.

### Agent specifics

- Each person adds their own computer to create agents with their own credentials.
- Agents run only while the host computer is on, because they use local compute.
- The host can rate-limit how many tokens "others" can use.
- An agent can be added to other computers if their owners have the correct API info and want to host it too.

### Frontier idea

- **Swarm AI:** agents work together, or choose not to work because they know someone else can do it.
- **Emergent learning** across the team.
- **Economy of minds:** an agent society and market.

### Cloud

Cloud compute is optional (enterprise, big teams, always-on agents). The base product runs on local compute.

---

## 2. Product definition

**One-liner:** a team messenger where AI agents are teammates, hosted on teammates' own machines.

**Wedge user:** small dev teams (2-15 people) who already run Claude Code, Cursor or similar agents and have no good way to share them.

**Three layers, built in this order:**

1. **Agent network:** local hosts, agent identity, routing and budgets (the differentiator).
2. **Team messenger:** servers, channels, roles, threads, voice.
3. **Shared workspace:** VSCode-style editor with a GitHub mirror branch.

**Principles:** local-first; secrets never leave the host; agents are members with identity and reputation; cloud compute is a pluggable host type, not the foundation.

### Knowledge graph

The team knowledge graph combines activity logs, transcripts, tasks, decisions and repository changes.

- Deterministic extraction creates edges and nodes from structured, attributable facts.
- AI extraction is advisory and creates lower-confidence hypotheses only.
- Nodes and edges carry confidence, provenance, source IDs and an extraction method.
- Confidence of 90% or higher is automatically accepted for deterministic facts.
- Low-confidence or conflicting facts stay pending until a human approves or rejects them.
- Humans and agents can trace every inferred relationship back to source evidence.

See `docs/KNOWLEDGE_GRAPH.md`.

### External app extensions

Swarmroom can later mirror work from manually registered desktop applications such as Blender, Photoshop, video editors and games.

The MVP is not automatic application integration. Each extension has a manifest, explicit host permission, a workspace mapping and an adapter contract.
The host adapter reports files, tasks and snapshots; it never automatically discovers or controls unrelated applications.
See `docs/EXTENSIONS.md`.

### Zero-budget constraint

The free tier must require no paid service for development or local use. A developer can run Postgres and the prototype locally, use free GitHub Actions and GitHub OAuth, and avoid Stripe and paid observability.

Paid providers are feature gates or enterprise alternatives, never required dependencies for the core product.

---

## 3. System architecture

| Component | Role |
|---|---|
| **Control plane** | Auth, servers/channels/roles, message history, agent registry, presence, task routing, billing. Coordination only, no agent compute. |
| **Host daemon** | Desktop app on each teammate's machine. Runs sandboxed agents, holds API keys in the OS keychain, enforces token budgets, streams results. |
| **Web/desktop client** | Chat, agents panel, Monaco workspace, voice. |
| **Collab server** | Yjs document sync for the shared workspace. |
| **Media server** | LiveKit for voice (later video and screen share). |
| **Cloud host (optional)** | The same daemon interface running in managed containers for always-on agents and enterprise. |

**Connectivity:** the daemon opens an outbound WebSocket to the control plane, which works through home NATs and firewalls. Direct peer-to-peer (WebRTC data channels or libp2p) is a later optimization.

---

## 4. Tech stack (no React)

TypeScript everywhere (client, control plane, daemon agent runtime), with Rust only for the desktop shell. A shared `protocol` package gives type safety across all three.

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm + Turborepo | Shared protocol types |
| Web front end | SvelteKit (SPA mode) + TypeScript | Alternatives: SolidJS, Vue, Lit |
| Styling | CSS variables + Tailwind or CSS modules | Light/dark design tokens |
| Code editor | Monaco | VSCode's own editor |
| Terminal | xterm.js | Agent/shell output panes |
| Collab editing | Yjs + Hocuspocus + y-monaco | CRDT, presence cursors |
| Desktop shell | Tauri 2 (Rust) | Electron is the one-language fallback |
| Backend API | Fastify or Hono on Node 22 | Typed, WebSocket-friendly |
| Realtime | `ws` / uWebSockets.js, typed event protocol | |
| Database | Postgres + Drizzle ORM | Messages, roles, registry, ledger |
| Cache / pubsub | Redis (NATS at scale) | Presence, fan-out |
| Search | Postgres full-text, Meilisearch later | |
| File storage | S3-compatible (Cloudflare R2) | Attachments |
| Auth | GitHub OAuth via Better Auth or Clerk | GitHub tokens needed anyway |
| Voice | LiveKit | Hosted or self-hosted |
| GitHub | GitHub App + Octokit; simple-git / isomorphic-git on the host | Per-repo scoping, webhooks |
| Agent runtime | Claude Agent SDK (+ adapters for other providers), MCP for tools | Provider-agnostic |
| Sandboxing | Docker/Podman (Linux, Windows via WSL2); Apple container or `sandbox-exec` (macOS) | Cloud tier: gVisor or Firecracker |
| Secrets | OS keychain (Keychain / Credential Manager / libsecret) | Keys never go to the server |
| Observability | OpenTelemetry, Sentry, PostHog | |
| Testing | Vitest, Playwright | |
| CI/CD | GitHub Actions | Signed desktop builds, Tauri auto-update |
| Hosting (start) | Fly.io / Render / Railway | Docker + WebSockets |
| Hosting (scale) | Kubernetes + Terraform | When the cloud tier needs it |
| Billing | Stripe | |

---

## 5. Core data model

- **User**, **Server** (workspace), **Member** (user + roles), **Role** (permission bitset)
- **Channel** (text / voice / task), **Message** (human | agent | system), **Thread**
- **Host** (machine, owner, status, capabilities)
- **Agent** (identity, owner, system prompt, tools, permissions, allowed hosts)
- **AgentRuntime** (which host currently runs which agent)
- **Budget** (agent x requester x window, token limits)
- **Task** (posted work, claimant, status, result, parent task)
- **Ledger entry** (credits earned and spent)
- **Memory item** (shared team knowledge, scoped by server / channel / agent)
- **Workspace / File / Snapshot** (Yjs state plus the git sync record)

---

## 6. Agent system design

- **Identity vs runtime:** an agent is a definition (name, role, prompt, memory, permissions) separate from the host that runs it. Any host with valid keys can run it, enabling multi-host and failover.
- **Invocation flow:** message -> control plane resolves mentions -> picks an online host -> daemon checks permission and budget -> runs the agent in a sandbox -> streams the reply back, tagged with the host.
- **Budgets:** per-requester token limits (hour / day / task) enforced locally by the daemon, with owner override and clear "out of budget" replies.
- **Multi-host failover:** the control plane keeps a priority list of hosts per agent and reroutes when a host drops. Shared agent memory is stored encrypted on the control plane so it follows the agent.
- **Provider terms:** verify each provider's terms before letting other people consume a host's API key.

---

## 7. Swarm and economy layer

Built as testable mechanisms, in this order:

1. **Task board and claiming:** work is posted and agents claim it (contract-net style: announce, bid, award).
2. **Self-selection and dedup:** each agent scores its own fit (skills, load, context, cost) and declines if someone is better placed. Agents announce intent so others skip duplicate work.
3. **Reputation:** per-agent success signals (tests passing, PRs merged, human thumbs-up) feed routing.
4. **Shared memory:** retrieval over accumulated team decisions, conventions and mistakes. "Emergent learning" starts as retrieval, not weight updates.
5. **Internal credit ledger:** agents spend credits to delegate, hosts earn credits for contributed compute. Accounting only, no real money at first.
6. **Cross-server marketplace** (later): specialist agents offered between teams.

**Guardrails from day one:** hard budget caps, delegation-depth limits, and human approval gates for destructive actions.

---

## 8. Security model

Highest-risk area: agents execute code on personal machines, triggered by other people's messages.

- Sandbox every agent by default: no home-directory access, scoped mounts only, egress allowlists.
- Inject secrets only into the process that needs them; never log them or send them to the server.
- Treat all channel content as untrusted (prompt injection). Dangerous tools require owner approval.
- Signed daemon builds, rotating host tokens, and an audit log of every agent action.
- Per-role permissions for who can invoke which agent, with which tools.

---

## 9. GitHub and workspace sync

- The shared workspace is a Yjs-synced virtual filesystem.
- A GitHub App pushes snapshots to a branch like `swarmroom/<server>-live`, never to main, with a persistent banner saying so.
- Fetch/pull-needed indicator: GitHub webhooks plus periodic `git fetch`, comparing ahead/behind counts against commits made from VSCode.
- Conflict policy: the live branch is overwritten from the workspace; humans merge into main through normal PRs.

---

## 10. Roadmap

| Phase | Timeline | Deliverables |
|---|---|---|
| 0. Validation | Weeks 1-3 | 15-20 interviews with people running multi-agent workflows, landing page, waitlist |
| 1. Agent network MVP | Weeks 4-11 | Real auth, Postgres, host daemon with sandboxing, budgets, signed installers |
| 2. Team workspace | Weeks 12-19 | Roles/permissions, Monaco + Yjs editing, GitHub App branch sync, fetch/pull indicator |
| 3. Swarm coordination | Weeks 20-27 | Task board, claiming/self-selection, multi-host failover, shared memory |
| 4. Voice and polish | Weeks 28-33 | LiveKit voice, threads, notifications, onboarding, public beta |
| 5. Economy and cloud tier | Ongoing | Credit ledger, reputation, marketplace experiments, enterprise cloud hosts, SSO, audit |

---

## 11. Monetization

- **Free:** small servers, local hosts only.
- **Team (per seat):** larger history, advanced roles, shared memory, GitHub integration.
- **Enterprise:** cloud hosts (always-on agents), SSO/SAML, audit logs, compliance, self-hosted control plane.
- A ledger/marketplace take-rate is possible later; don't plan revenue around it yet.

---

## 12. Team and cost

- **Minimum viable team:** 1 full-stack TypeScript engineer, 1 systems engineer (daemon, sandboxing, Rust/Tauri), 1 designer/front-end specialist. A strong solo founder can reach Phase 2 alone, but slowly.
- **Early infrastructure is cheap** (roughly tens to low hundreds of dollars a month for control plane, Postgres, Redis, LiveKit) because agent compute and API costs sit on users' machines.
- **Larger early costs:** code signing and notarization for desktop builds, a security review before launch, and legal review of provider terms.

---

## 13. Key risks

1. **Local-agent security:** could destroy trust if mishandled.
2. **Laptop availability:** teams will ask for always-on agents quickly, making the cloud tier more urgent than planned.
3. **Scope creep:** Slack, Discord, Replit and swarm AI are four products; prove the agent network first.
4. **Provider terms** on sharing API access.
5. **Competition:** Slack, Discord, Cursor, Replit and GitHub are all moving into agent collaboration. The moat is local-first plus swarm behavior.
6. **Swarm value proof:** coordination features need measurable wins (less duplicate work, faster task completion) or they read as a gimmick.

---

## 14. Current prototype

A working first version exists (`swarmroom.zip`):

- `server.js`: Node WebSocket backend that serves the front end, stores channels and messages in a JSON file, keeps the agent registry, and routes `@mentions` to online hosts.
- `daemon.js`: host daemon that registers agents, calls the Anthropic API with a locally held key, and enforces per-hour token limits on non-owners.
- `public/index.html`: vanilla JS front end with channels, an agents panel with live online/offline status, and a shared-file Workspace tab.
- `Dockerfile` for deployment.

**Not built yet:** real accounts, roles, voice, Monaco/Yjs editor, GitHub sync, agent sandboxing and tools, swarm behavior, Postgres persistence.

---

## 15. Open decisions

- Tauri (lighter, needs Rust) vs Electron (one language, heavier)?
- Svelte vs Solid vs Vue for the client?
- Shared workspace as a synced virtual filesystem, or a real checkout on a designated host?
- Hosted or self-hosted LiveKit?
- First target user: solo builders with many agents, or small teams?
