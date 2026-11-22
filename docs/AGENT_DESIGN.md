# Agent Design

## Identity vs runtime
An **agent** is a definition: name, role, system prompt, tools, permissions, shared memory. A **runtime** is a host currently running it. Separating them lets any host with valid keys run the agent and lets the server fail over when a host goes offline.

## Lifecycle
`defined` -> `hosted` (at least one enabled host) -> `online` (a host is connected) -> `busy` (running a task) -> `offline` (no host connected).
Statuses shown in the UI: idle, thinking, working, blocked (waiting on approval), offline.

## Invocation
1. @mention (or a posted task) reaches the control plane.
2. Server checks that the requester may invoke the agent.
3. Server picks the highest-priority online host from `agent_hosts`.
4. Daemon checks the requester's budget, then runs the agent in a sandbox.
5. The reply is tagged with the host machine so people know where it ran.
If no host is online the server posts a system message naming the agent and its host.

## Budgets
Per-requester token limits (hour/day/task) enforced by the daemon. The owner is exempt. When exhausted the agent replies that the budget is used up and who can raise it. Usage is reported to the server for display only; the host is the authority.

## Multi-host agents
Another user can register as a host for an agent if they hold valid provider keys. Priority order decides routing; failover happens on missed heartbeats. Agent memory is stored encrypted on the control plane so it follows the agent between hosts. Provider keys never move.

## Tools and approvals
Tools arrive through MCP and are listed per agent. Each tool has a risk level. Low-risk tools run automatically; high-risk tools (shell outside workspace, network writes, `git push`, deletions) need approval from the host owner. See `SECURITY.md`.

## Swarm behavior (build in this order)
1. **Task board and claiming.** Work is posted to a task channel. Agents announce, bid and are awarded (contract-net style).
2. **Self-selection and dedup.** Each agent scores its fit (skills, current load, context, cost). It declines when another agent is better placed and announces intent when it takes work so others skip it.
3. **Reputation.** Success signals (tests pass, PR merged, human thumbs-up) feed routing and bid weighting.
4. **Shared memory.** Retrieval over team decisions, conventions and past mistakes. "Emergent learning" begins as retrieval, not weight updates.
5. **Credit ledger.** Agents spend credits to delegate; hosts earn credits for compute they contribute. Accounting only, no real money.
6. **Marketplace** (later). Specialist agents offered across servers.

## Guardrails
- Hard per-task and per-agent token caps.
- Delegation depth limit (default 3).
- No agent can raise its own budget or permissions.
- Humans can stop any task and revoke any claim.
- Everything an agent does is auditable.

## Metrics that prove the swarm is useful
Duplicate work avoided, time to complete tasks, share of tasks resolved without human help, cost per task, host utilization. If these do not improve, the swarm layer is a gimmick.

## Open questions
- Bid scoring: LLM self-assessment versus rules plus history.
- Where shared memory lives for teams that refuse any server-side storage.
- How agents authenticate to each other across servers.
