# Decisions

Architecture decision log. Check here before reopening a question. Add an entry when you decide something new. Status: Accepted, Proposed, Superseded.

## Template
```
### D-NNN: Title
Status: Accepted | Proposed | Superseded by D-NNN
Date: YYYY-MM-DD
Context: why the decision was needed
Decision: what we chose
Consequences: tradeoffs and follow-ups
```

### D-001: Agents run on users' own computers
Status: Accepted
Context: Avoid cloud compute cost and keep API keys private.
Decision: Agents run only on teammates' machines via a host daemon. Cloud hosts are an optional paid tier using the same interface.
Consequences: Agents are offline when a host is off; failover through multi-host agents; the security model centers on local sandboxing.

### D-002: Daemon connects outbound over WebSocket
Status: Accepted
Context: Home computers sit behind NAT.
Decision: Daemons open an outbound WebSocket to the control plane. Peer-to-peer is a later optimization.
Consequences: The server relays traffic; simple and reliable.

### D-003: No React
Status: Accepted
Context: The founder does not want React.
Decision: Use SvelteKit for the client. SolidJS, Vue and Lit remain acceptable alternatives.
Consequences: Smaller ecosystem than React; fewer ready-made components.

### D-004: TypeScript everywhere, Rust only for the desktop shell
Status: Accepted
Decision: One language across client, server and daemon, with a shared `packages/protocol`.
Consequences: Type-safe protocol; Rust is needed only for Tauri.

### D-005: Tauri over Electron for the desktop shell
Status: Proposed
Context: Daemon needs a small, always-running tray app.
Decision: Prefer Tauri 2 for size and memory. Electron is the fallback if Rust becomes a hiring or velocity problem.
Consequences: Requires Rust skills on the team.

### D-006: Postgres with Drizzle; Redis for presence
Status: Accepted
Decision: Postgres is the system of record; Redis handles presence and pub/sub.
Consequences: Prototype JSON file storage is replaced in Phase 1.

### D-007: Yjs + Monaco for the workspace
Status: Accepted
Decision: Monaco gives the VSCode look; Yjs provides conflict-free collaboration.
Consequences: Prototype textarea (last write wins) is temporary.

### D-008: Workspace mirrors to a non-main sync branch
Status: Accepted
Decision: Push snapshots to `swarmroom/<server>-live`, never `main`, enforced in code. The UI states it is a snapshot only.
Consequences: Humans merge via PRs.

### D-009: Per-requester token budgets enforced by the host
Status: Accepted
Decision: The daemon is the authority on budgets; the server only mirrors usage.
Consequences: Budgets work even if the server is compromised; usage display can lag.

### D-010: Swarm built in stages; "emergent learning" starts as retrieval
Status: Accepted
Decision: Task claiming, then self-selection, then reputation, then shared memory, then an internal credit ledger with no real money.
Consequences: Each stage is testable; claims about learning stay honest.

### D-011: Check provider terms before shared key use
Status: Proposed
Context: Letting others consume a host's API key may violate some providers' terms.
Decision: Review terms before shipping budget-limited sharing; allow per-agent opt-out.
Consequences: May restrict which providers support sharing.

### D-012: Voice via LiveKit
Status: Proposed
Decision: Use LiveKit rather than building WebRTC infrastructure.
Consequences: Dependency on a third party, or self-host.

### D-013: Deterministic knowledge graph before AI extraction
Status: Proposed
Context: The graph must explain relationships without relying on model output.
Decision: Build nodes and edges from structured events first. Use AI only for hypotheses on free-text sources.
Consequences: AI-created edges require provenance, confidence and manual review below 90%.

### D-014: Manual external app adapters
Status: Proposed
Context: Desktop applications use incompatible APIs and file formats.
Decision: Add only explicitly registered host adapters with manifests and separate permissions.
Consequences: No automatic discovery of Blender, Photoshop, video editors or games.

### D-015: Zero-budget MVP
Status: Accepted
Context: The project starts with no budget.
Decision: Core development and local operation use free or locally hosted tools only.
Consequences: Paid hosting, code signing, observability and billing can be launch gates instead of dependencies.

### D-016: Server roles use permission bits
Status: Accepted
Date: 2026-11-23
Context: Server membership alone is too broad for channel, agent and administration actions.
Decision: Server roles grant independent permission bits for reading and sending messages, invoking agents, and managing channels, agents, members and roles. Server owners always have all permissions; new members receive the default member role.
Consequences: Every server API and WebSocket action must check the relevant permission at the server boundary. Agent-specific tool permissions remain a later layer.

### D-017: Hosting a shared agent requires both owners' consent
Status: Accepted
Date: 2026-11-23
Context: The host controls local credentials and compute, while the agent owner controls who may run the agent definition.
Decision: Cross-user hosting requires an explicit server-side agent-to-host assignment and the host daemon must include that agent in its registration. The host owner must remain a member of the agent's server.
Consequences: The server routes only to enabled assignments. Host registrations cannot silently claim another user's agents.

### D-018: Sandboxed task execution starts with no network
Status: Accepted
Date: 2026-11-24
Context: Agent prompts and tools are untrusted, so they must not receive general network access.
Decision: The initial Linux sandbox uses local rootless Podman, a digest-pinned image, explicit per-agent workspace mounts, and no network. It applies CPU, memory, process, wall-time and output limits. Tasks remain unexecuted if no compatible sandbox is configured.
Consequences: Provider access can be added only through a host-side broker that enforces an explicit egress allowlist; do not enable general container networking.

### D-019: Provider egress uses a task-scoped host broker
Status: Accepted
Date: 2026-11-24
Context: Sandboxed agents need model API access without receiving host credentials or general network access.
Decision: Mount a unique Unix socket for each Podman task. The daemon accepts only fixed OpenAI Responses, OpenAI Chat Completions and Anthropic Messages routes, injects the agent's key from the OS keychain, and enforces request, response, concurrency, timeout and output-token limits. The broker does not accept arbitrary URLs, headers, redirects or streaming requests.
Consequences: Agent images need a small client for this socket contract. Provider and tool policy remains in the runtime; the broker only constrains egress and credential handling.
