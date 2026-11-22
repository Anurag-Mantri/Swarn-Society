# Architecture

## Principles
1. **Local-first:** agents run on teammates' computers; the server only coordinates.
2. **Secrets never leave the host.**
3. **Agents are members,** with identity, permissions, reputation and a host.
4. **Cloud is a host type,** not the foundation.

## Components
| Component | Responsibility |
|---|---|
| Control plane (`apps/server`) | Auth, servers/channels/roles, message history, agent registry, presence, task routing, budgets metadata |
| Host daemon (`apps/daemon`) | Runs sandboxed agents, holds keys in the OS keychain, enforces token budgets, streams replies |
| Client (`apps/web`) | Chat, agents panel, workspace editor, voice |
| Collab server | Yjs document sync for the shared workspace (Hocuspocus) |
| Media server | LiveKit for voice |
| Cloud host (optional) | The same daemon interface in managed containers (gVisor/Firecracker) |
| Knowledge graph worker | Builds deterministic nodes and edges from logs, tasks and workspace events; queues AI-assisted hypotheses |
| Extension adapters (host-side) | Opt-in adapters that report approved application state and snapshots to the control plane |

## Topology
```
  Client (browser/desktop) --WS--> Control plane <--outbound WS-- Host daemon (teammate's PC)
                                       |  \                           |
                                  Postgres  Redis                Sandbox -> agent -> model API
                                       |
                                 Collab server (Yjs) --> GitHub App --> sync branch
```

## Connectivity
Daemons open an **outbound WebSocket** to the control plane, which traverses NATs and firewalls. Direct peer-to-peer (WebRTC / libp2p) is a later optimization.

## Invocation flow
1. A user posts a message that @mentions an agent.
2. The control plane resolves the mention to an agent and picks an online host (priority list, failover).
3. It sends a `task` to the daemon. If no host is online, it posts a system message.
4. The daemon checks permissions and the requester's token budget.
5. The daemon runs the agent in a sandbox and calls the model with the host's key.
6. The daemon sends a `reply`; the server stores and broadcasts it, tagged with the host.

## Workspace and GitHub sync
- Workspace is a Yjs-synced virtual filesystem.
- A GitHub App pushes snapshots to `swarmroom/<server>-live`, never `main`; the UI shows a banner saying so.
- Webhooks plus periodic `git fetch` feed a fetch/pull-needed indicator based on ahead/behind counts.
- Humans merge to main through normal PRs.

## Knowledge graph pipeline
- Collect structured events: messages, task assignments, task completion, channel membership, file changes and commit provenance.
- Generate deterministic nodes and edges from IDs and timestamps.
- Store confidence, extraction method and source evidence on every node or edge.
- Run AI extraction only on text sources that may contain unknown relationships.
- Accept deterministic facts at the approved 90% threshold.
- Keep low-confidence and conflicting facts pending until a human reviews them.
- Rebuild the graph from source events; never treat inferred edges as the only source of truth.

## External app adapter boundary
- Server admins manually register extension manifests.
- The host daemon asks for explicit per-app permission before loading an adapter.
- Adapters can access only resources declared in the manifest.
- Adapter events use Zod-validated protocol messages.
- The MVP does not scan for applications or derive integrations automatically.

## Scaling notes
Control plane is stateless apart from Postgres and Redis; run multiple instances behind a WebSocket-aware load balancer and fan out through Redis pub/sub. Agent compute scales with the number of hosts, not with the server.

## Current prototype vs target
| Concern | Prototype | Target |
|---|---|---|
| Storage | JSON file | Postgres + Drizzle |
| Auth | Name only | GitHub OAuth |
| Editor | Textarea | Monaco + Yjs |
| Agents | Chat only | Sandboxed tools via MCP |
| Presence | In-memory | Redis |
