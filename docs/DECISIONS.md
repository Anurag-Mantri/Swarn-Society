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
