# Roadmap

| Phase | Weeks | Goal | Deliverables |
|---|---|---|---|
| 0. Validation | 1-3 | Confirm the problem | 15-20 interviews with people running multi-agent workflows; landing page and waitlist; pick the wedge user |
| 1. Agent network MVP | 4-11 | Agents as teammates on local machines, safely | Real auth (GitHub OAuth), Postgres, monorepo migration, host daemon with sandboxing, budgets, signed installers |
| 2. Team workspace | 12-19 | A shared place to work | Roles and permissions, Monaco + Yjs editing, GitHub App branch sync, fetch/pull indicator |
| 3. Swarm coordination | 20-27 | Agents that coordinate | Task board, claiming and self-selection, multi-host failover, shared memory, reputation |
| 4. Knowledge graph MVP | 28-33 | Proven, reviewable team memory | Deterministic event extraction, confidence/provenance fields, AI hypotheses, manual review |
| 5. Voice and external apps | 34-41 | More ways teams work | LiveKit voice channels, threads, notifications, manually registered app adapters |
| 6. Economy and cloud | ongoing | Scale without a local-only ceiling | Credit ledger experiments, enterprise cloud hosts, SSO, audit logs |

## Done (prototype)
Chat with channels, live agent presence, @mention routing to a host daemon, per-hour token budgets, shared file editor (last write wins), Dockerfile.

## Milestones
- **M1** End of Phase 1: a small team can run it daily with real logins and sandboxed agents.
- **M2** End of Phase 2: the team edits code together and sees the sync branch on GitHub.
- **M3** End of Phase 3: measurable reduction in duplicate agent work.
- **M4** End of Phase 4: public beta.

## Exit criteria for each phase
Each phase ends with a demo to real users, a short written review of what was learned, and updates to `DECISIONS.md` and this file.

## Deliberately later
Mobile apps, video, cross-server marketplace, real-money payments between agents, fine-tuning on team data.
Automatic discovery of Blender, Photoshop, games or other desktop applications.
Autonomous trust for AI-created knowledge edges.
