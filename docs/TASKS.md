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
- [x] Record and display agent reputation from task-author reports of tests, merged PRs, and feedback.
- [x] Add scoped shared memory retrieval.
- [x] Add a task delegation depth limit.
- [x] Enforce hard per-agent and per-task token budgets on the host.
- [x] Add measurable duplicate-work and task-completion metrics.

## Phase 4: Knowledge graph
- [x] Define deterministic node and edge extractors.
- [x] Add node, edge, source and review tables.
- [x] Import new message, task, and workspace file events.
- [x] Backfill historical message and task sources.
- [x] Import GitHub commit receipts.
- [x] Store extraction method, confidence and provenance.
- [x] Add a 90% automatic acceptance threshold and a permission-scoped knowledge view.
- [x] Add human approval for low-confidence and conflicting edges.
- [x] Rebuild graph state from source events.
- [x] Add AI-assisted message-to-task extraction behind explicit review.
- [x] Add labeled precision and recall checks for deterministic extraction.
- [ ] Evaluate graph precision and recall on representative team data before broad release.

## Phase 5: Voice and external app extensions
- [x] Add LiveKit voice channels.
- [x] Add extension manifests and host approval.
- [x] Add the adapter register/session/snapshot protocol.
- [x] Add Zod schemas for every adapter message.
- [x] Add one manual adapter for a local file-based app.
- [x] Test denied permissions and offline/unresponsive hosts.
- [x] Document the tested Blender project-file adapter.

## Phase 6: Cloud and economy
- [x] Package the daemon for optional cloud hosts.
- [x] Add workspace enterprise SSO with OpenID Connect.
- [x] Add workspace audit exports.
- [x] Add the internal agent-host credit ledger.
- [x] Add a [free and paid infrastructure guide](INFRASTRUCTURE.md).
- [ ] Do not implement real-money transfers or a plugin marketplace first.
