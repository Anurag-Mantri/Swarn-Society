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

### D-020: Initial agent runtime has no tools
Status: Accepted
Date: 2026-11-24
Context: The message protocol carries task text but not a validated agent definition or tool permission manifest.
Decision: The initial TypeScript runtime reads a fixed, image-baked config, sends one task to a configured model through the host broker, and returns text. It does not execute commands, access workspace tools, or load config paths from task content.
Consequences: Runtime images are agent-specific until the control plane delivers a validated agent definition. Add tool execution only after permissions, host approval and audit boundaries are implemented.

### D-021: Host budgets reserve before provider calls
Status: Accepted
Date: 2026-11-24
Context: Requester budgets must be enforced locally without trusting usage claims from the sandbox or storing prompts.
Decision: Configure owner IDs and per-task/hour/day token limits on the host. Before each provider request, reserve tokens using serialized request bytes, the output cap and a framing allowance. Settle with usage returned by the fixed provider API; if usage is missing or the request fails after dispatch, retain the full reservation. Persist only agent/requester IDs, timestamps, task IDs and token counts.
Consequences: Budget enforcement is opt-in per host configuration to preserve existing daemon setups. Missing policy means no requester-specific budget is applied; usage estimates can conservatively deny a call before dispatch.

### D-022: Server-reported usage is display-only
Status: Accepted
Date: 2026-11-24
Context: Teams need usage visibility, but host-side budgets must remain enforceable without server availability or trust in the control plane.
Decision: The daemon reports provider-reported input and output token counts after a task. The server validates the host's agent assignment, requester membership and invoke permission before persisting and broadcasting the report. Server usage never changes the host's budget decisions.
Consequences: Usage can be missing when a provider call fails or a sandbox exits before reporting. The server treats reports as host-provided display data, not billing records.

### D-023: Channel roles restrict inherited server permissions
Status: Accepted
Date: 2026-11-24
Context: Teams need private and read-only channels inside a server.
Decision: A channel can deny read, send, or invoke permissions for individual server roles. Combine grants and denials independently across assigned roles, then subtract the denials. The server owner keeps full access. Managing restrictions requires both server role and channel management permissions.
Consequences: Existing channels inherit server permissions. Reading is required to send or invoke in a channel. A daemon's host owner must be allowed to read the channel before the server sends it a task.

### D-024: A thread is identified by its root message
Status: Accepted
Date: 2026-11-24
Context: Human and agent replies need a shared thread identity and the same access rules as their channel.
Decision: Store a nullable thread ID on every message. Replies point to a top-level message in the same channel. Channel permissions apply to both roots and replies.
Consequences: Existing messages remain top-level. The daemon keeps the thread ID for routing replies while sending the existing task format to sandbox images.

### D-025: Workspace files use database-backed Yjs documents
Status: Accepted
Date: 2026-11-24
Context: Teams need shared text files and concurrent editing before GitHub snapshot sync.
Decision: Store metadata and Yjs state in PostgreSQL, and use a file UUID as the Hocuspocus document name. The control plane authenticates collaboration under the same origin as chat. Workspace read and send permissions control file reads and edits.
Consequences: Paths are logical repository paths. Presence stays in memory. Run one control-plane instance for live collaboration until cross-instance document and awareness synchronization is added.

### D-026: GitHub App credentials live on the host
Status: Accepted
Date: 2026-11-24
Context: GitHub workspace sync requires installation tokens while the daemon remains the credential boundary.
Decision: Import the App private key into the host OS keychain. The daemon signs the app JWT and requests short-lived installation tokens scoped to a single repository ID and the permissions needed for each operation.
Consequences: The control plane can exchange repository and sync metadata without receiving GitHub App private keys or installation tokens. Setup requires an App installed on the approved repository.

### D-027: Workspace owners export snapshots for host publication
Status: Accepted
Date: 2026-11-24
Context: Snapshot publication needs approval and repository credentials scoped to the host.
Decision: The workspace owner downloads the saved snapshot from the control plane. A host operator explicitly publishes it with the GitHub App CLI. Derive the target branch from the workspace UUID and reject default or protected branches and branches with active GitHub rules.
Consequences: This first sync workflow is manual and uses saved database state. Publication overlays workspace files onto a repository tree and uses non-forced ref updates. Remote head comparison and editor integration can consume the same stable branch name.

### D-028: Agent owners submit exclusive task claims
Status: Accepted
Date: 2026-11-24
Context: The first task board needs a human-controlled claim workflow and a single assignment even when teammates act at the same time.
Decision: Keep task posts inside task channels and apply channel permissions. An agent owner submits a claim for their own agent, and PostgreSQL changes the first unclaimed row atomically.
Consequences: The task board records ownership without starting agent execution. Contract bids, approval and task completion can extend this workflow.

### D-029: Task authors approve contract bids
Status: Accepted
Date: 2026-11-24
Context: A task author needs to choose which teammate's agent can claim work and review its proposed deliverable.
Decision: Require a bid with a work plan and deliverable for agents owned by other teammates. The human task author approves one bid. Record the approval and assignment atomically. Task authors may directly assign their own agents.
Consequences: Multiple agents can propose distinct approaches while each task has one winner. Submission and approval record coordination metadata without starting execution.

### D-030: Task claims check intent and agent capacity
Status: Accepted
Date: 2026-11-24
Context: An exclusive claim prevents duplicates on one post, while separate posts can still describe the same work or overload an agent.
Decision: Apply the same serialized PostgreSQL checks to direct claims and bid approval. One assigned unresolved task can use each normalized intent in its channel. An agent can hold one unresolved assignment across its channels.
Consequences: Resolution releases capacity. The default intent is the normalized title, and teams can supply a shared intent for differently worded posts. Existing assignments stay intact.

### D-031: Extension approval applies to an immutable version
Status: Accepted
Date: 2026-11-24
Context: A workspace needs to request adapter capabilities without granting access to a teammate's computer.
Decision: A workspace manager registers a structured manifest. The registered host owner approves a subset of its capabilities for that exact version. New versions require fresh approval.
Consequences: Approval is revocable metadata. An adapter session must validate the same manifest version and grants before it can operate.

### D-032: Internal credits are explicitly issued and transferred
Status: Accepted
Date: 2026-11-25
Context: Teams need a record of allocations between agents and hosts without turning reported token use into billing.
Decision: Authorized workspace administrators issue and transfer integer credits. Store one immutable entry per operation, serialize writes within a workspace, and derive balances from the entries.
Consequences: Repeated requests do not create duplicate entries. Transfers cannot overdraw an account. Credits carry no monetary value and do not affect host token budgets.

### D-033: Knowledge reviewers must be able to read the supporting evidence
Status: Accepted
Date: 2026-11-25
Context: Low-confidence, inferred, and conflicting relationships need human judgment. A workspace role can have administrative permissions while being denied access to a channel.
Decision: Allow people with workspace role-management and message-read permissions to review an edge when they can read provenance for both endpoints and all sources attached to the edge. Record a final decision for the relationship.
Consequences: A rejected edge stays hidden. An approved edge appears for a reader only when they can read all attached evidence and the selected view includes both endpoints.

### D-034: Workspace owners attest to imported GitHub receipts
Status: Accepted
Date: 2026-11-25
Context: The graph needs commit provenance from private repositories where GitHub access belongs to the host.
Decision: Have the host CLI read the dedicated snapshot branch with a repository-scoped read token. Import the resulting metadata through the workspace owner's authenticated session. Record the user as the reporter.
Consequences: The control plane can show commit provenance without requesting the installation token. It trusts the workspace owner's submission and attributes the receipt to that user.

### D-035: Model proposals use explicit, channel-scoped extraction
Status: Accepted
Date: 2026-11-25
Context: The graph needs hypotheses from chat while preserving host ownership over provider access and channel restrictions over message content.
Decision: Export one message excerpt and a bounded list of task titles from its channel. Run model extraction on demand in the host sandbox, then import only proposed task IDs and scores for human review.
Consequences: Model outputs cannot create tasks or invoke agents. High-scoring proposals follow the same review requirement as low-scoring proposals. The shared graph excludes pending proposals and their source metadata.

### D-036: Agent reputation is based on scoped task reviews
Status: Accepted
Date: 2026-11-25
Context: Agent outcomes need useful evidence without allowing self-rated assignments or publishing private task details across the workspace.
Decision: Let a task author record one review of another person's agent after completion. Record reported test outcomes, reviewed feedback, and merged GitHub pull request links as separate signals. Count duplicate pull request links once per agent in the channel.
Consequences: People with channel access can compare aggregate counts. The task author can see individual review details. Reviews do not change routing or assignment automatically.

### D-037: Task delegation stays within its task channel
Status: Accepted
Date: 2026-11-25
Context: A task author or an assigned agent's owner may break work into subtasks without creating an unbounded chain or crossing channel permissions.
Decision: Store the immutable parent reference and derive a depth of up to three from the locked parent record. Require an open parent, channel send permission, and authorization as its author or the assigned agent's owner.
Consequences: Delegation creates a task post and follows the normal claim workflow. Closing a parent prevents new direct subtasks. Existing children keep their own lifecycle.

### D-038: Hosts reserve tokens before capped provider requests
Status: Accepted
Date: 2026-11-25
Context: Requester quotas exempt an agent's owner and do not bound the aggregate work sent to one agent from different users.
Decision: Support host-configured task and rolling per-agent token caps. Reserve the conservative request bound in a private SQLite transaction before calling the provider. Limit capped requests to the existing text routes and a bounded input shape.
Consequences: The host caps also cover the owner and local extraction. They persist across restarts and share accounting with other daemon processes in the same state directory. Provider usage reports remain display-only at the control plane.

### D-039: LiveKit join tokens are signed on an authorized host
Status: Accepted
Date: 2026-11-25
Context: Voice requires LiveKit join credentials while the control plane needs to enforce channel access.
Decision: Let the workspace owner select one of their connected, consented voice hosts. Check channel read and send permissions on new joins. Ask the selected host to sign one short-lived room token with its OS-keychain credential.
Consequences: The control plane stores the host association. New joins require the selected host to be online. Media flows between browsers and LiveKit, which manages established sessions.
