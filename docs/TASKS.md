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
- [x] Add the SvelteKit shell, workspace navigation, channel chat and threads.
- [ ] Add host and agent management views.
- [x] Add server role permissions for message access, agent invocation and server administration.
- [x] Replace shared `HOST_KEY` with hashed, rotating host tokens.
- [x] Mark hosts offline after missed heartbeat deadlines.
- [x] Require both agent-owner authorization and host registration consent before cross-user routing.
- [x] Add CI for install, typecheck, Postgres integration tests and build.
- [x] Add a TypeScript host transport with OS keychain token lookup.
- [x] Port the agent runtime daemon to TypeScript.
- [x] Store host tokens and agent-scoped provider secret values only in the OS keychain.
- [x] Inject approved provider credentials into the agent runtime through the host-side broker.
- [x] Add a rootless Podman sandbox with explicit workspace mounts, default-deny networking and resource limits.
- [x] Add an allowlisted host-side model API egress broker for sandboxed agents.
- [x] Persist per-requester token budgets on the host.
- [x] Report provider token usage to the server for display only.
- [x] Record task lifecycle events in a local metadata-only audit log.
- [ ] Audit individual agent tool actions and add host-owner approvals.
- [ ] Build signed desktop installers with Tauri.

## Phase 2: Team workspace
- [x] Add text, voice and task channel types.
- [x] Add role-based channel permissions.
- [x] Add message threads.
- [x] Replace the textarea with Monaco and Yjs.
- [x] Add presence cursors and conflict-free file editing.
- [x] Add GitHub App installation verification on the host.
- [x] Publish saved workspace snapshots manually from the host to `swarmroom/<server>-live`.
- [x] Compare local and remote branch heads for fetch/pull state.
- [x] Link VS Code checkout commits to workspace snapshot status.

## Phase 3: Swarm coordination
- [x] Add task posts and agent claims.
- [x] Add contract-style bids and human claim approval.
- [x] Record task completion and cancellation.
- [x] Prevent duplicate work through agent intent and load checks.
- [ ] Add agent reputation from tests, merged PRs and human feedback.
- [ ] Add scoped shared memory retrieval.
- [ ] Add delegation depth and hard cost limits.
- [x] Add measurable duplicate-work and task-completion metrics.

## Phase 4: Knowledge graph
- [x] Define deterministic node and edge extractors.
- [x] Add node, edge, source and review tables.
- [x] Import new message, task, and workspace file events.
- [ ] Import GitHub commit receipts and backfill historical sources.
- [x] Store extraction method, confidence and provenance.
- [x] Add a 90% automatic acceptance threshold and a permission-scoped knowledge view.
- [ ] Add human approval for low-confidence and conflicting edges.
- [ ] Rebuild graph state from source events.
- [ ] Add AI-assisted extraction behind explicit review.
- [ ] Evaluate graph precision and recall before broad release.

## Phase 5: Voice and external app extensions
- [ ] Add LiveKit voice channels.
- [x] Add extension manifests and host approval.
- [ ] Add the adapter register/session/snapshot protocol.
- [ ] Add Zod schemas for every adapter message.
- [ ] Add one manual adapter for a local file-based app.
- [ ] Test denied permissions and offline/unresponsive hosts.
- [ ] Document a Blender or Photoshop adapter only after a tested integration exists.

## Phase 6: Cloud and economy
- [ ] Package the daemon for optional cloud hosts.
- [ ] Add enterprise SSO and audit exports.
- [ ] Add the internal agent-host credit ledger.
- [x] Add a [free and paid infrastructure guide](INFRASTRUCTURE.md).
- [ ] Do not implement real-money transfers or a plugin marketplace first.
