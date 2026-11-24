# Tasks

Check off tasks in this file in the same pull request that completes them.
Keep each pull request on one task or a tightly related task group.

## Phase 0: Validate
- [ ] Interview 15-20 small teams that run agents.
- [ ] Confirm the first user group: 2-15 developers.
- [ ] Publish a landing page and waitlist.
- [ ] Record the top five security objections to local agent hosting.

## Phase 1: Agent network MVP
- [x] Add a pnpm and Turborepo monorepo.
- [x] Add `packages/protocol` with Zod schemas.
- [x] Replace prototype JSON storage with Postgres and Drizzle, covered by disposable-database integration tests.
- [x] Add the GitHub OAuth flow with mocked provider tests.
- [ ] Verify OAuth against a registered GitHub app.
- [x] Add server role permissions for message access, agent invocation and server administration.
- [x] Replace shared `HOST_KEY` with hashed, rotating host tokens.
- [x] Mark hosts offline after missed heartbeat deadlines.
- [x] Require both agent-owner authorization and host registration consent before cross-user routing.
- [x] Add CI for install, typecheck, Postgres integration tests and build.
- [x] Add a TypeScript host transport with OS keychain token lookup.
- [ ] Port the agent runtime daemon to TypeScript.
- [x] Store host tokens and agent-scoped provider secret values only in the OS keychain.
- [ ] Inject approved provider credentials into the agent runtime through the host-side broker.
- [x] Add a rootless Podman sandbox with explicit workspace mounts, default-deny networking and resource limits.
- [ ] Add an allowlisted host-side model API egress broker for sandboxed agents.
- [ ] Persist per-requester token budgets on the host.
- [ ] Add action approvals and a local audit log.
- [ ] Build signed desktop installers with Tauri.

## Phase 2: Team workspace
- [ ] Add text, voice and task channel types.
- [ ] Add threads and role-based channel permissions.
- [ ] Replace the textarea with Monaco and Yjs.
- [ ] Add presence cursors and conflict-free file editing.
- [ ] Add GitHub App integration.
- [ ] Push workspace snapshots only to `swarmroom/<server>-live`.
- [ ] Compare local and remote branch heads for fetch/pull state.
- [ ] Link VSCode commits to workspace snapshot status.

## Phase 3: Swarm coordination
- [ ] Add task posts and agent claims.
- [ ] Add contract-style bids and human claim approval.
- [ ] Prevent duplicate work through agent intent and load checks.
- [ ] Add agent reputation from tests, merged PRs and human feedback.
- [ ] Add scoped shared memory retrieval.
- [ ] Add delegation depth and hard cost limits.
- [ ] Add measurable duplicate-work and task-completion metrics.

## Phase 4: Knowledge graph
- [ ] Define deterministic node and edge extractors.
- [ ] Add node, edge, source and review tables.
- [ ] Import message, task, file and commit events.
- [ ] Store extraction method, confidence and provenance.
- [ ] Add a 90% automatic acceptance threshold.
- [ ] Add human approval for low-confidence and conflicting edges.
- [ ] Rebuild graph state from source events.
- [ ] Add AI-assisted extraction behind explicit review.
- [ ] Evaluate graph precision and recall before broad release.

## Phase 5: Voice and external app extensions
- [ ] Add LiveKit voice channels.
- [ ] Add extension manifests and host approval.
- [ ] Add the adapter register/session/snapshot protocol.
- [ ] Add Zod schemas for every adapter message.
- [ ] Add one manual adapter for a local file-based app.
- [ ] Test denied permissions and offline/unresponsive hosts.
- [ ] Document a Blender or Photoshop adapter only after a tested integration exists.

## Phase 6: Cloud and economy
- [ ] Package the daemon for optional cloud hosts.
- [ ] Add enterprise SSO and audit exports.
- [ ] Add the internal agent-host credit ledger.
- [ ] Add a free and paid infrastructure guide.
- [ ] Do not implement real-money transfers or a plugin marketplace first.
