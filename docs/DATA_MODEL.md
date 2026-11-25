# Data Model

Postgres with Drizzle ORM. IDs are UUIDs; all tables have `created_at`. The prototype stores `channels`, `msgs` and `files` in a JSON file; this is the target schema.

## Identity and access
| Table | Key fields | Notes |
|---|---|---|
| `users` | id, github_id, handle, avatar_url | From GitHub OAuth |
| `oidc_identities` | issuer, subject (composite primary key), user_id | Stores enterprise sign-in identity mappings. GitHub ID is nullable for users provisioned by OIDC. |
| `servers` | id, name, owner_id | A workspace/team |
| `roles` | id, server_id, name, permissions (bitset) | Bits cover reading/sending messages, invoking agents, and managing channels, agents, members and roles. Server owners have all permissions. |
| `members` | server_id, user_id | PK (server_id, user_id) |
| `member_roles` | server_id, user_id, role_id | |

## Workspace files

| Table | Key fields | Notes |
|---|---|---|
| `workspace_files` | id, server_id, path, document | Repository-relative path and nullable binary Yjs state. Document IDs are independent of paths. |

## Messaging
| Table | Key fields | Notes |
|---|---|---|
| `channels` | id, server_id, name, kind (`text`/`voice`/`task`), position | |
| `voice_hosts` | server_id (primary key), host_id | The workspace owner's selected LiveKit token issuer. |
| `channel_role_restrictions` | channel_id, role_id, denied (bitset) | Removes read, send, or invoke permissions for a role in one channel. |
| `messages` | id, channel_id, thread_id?, author_kind (`user`/`agent`/`system`), author_id, host_id?, body, created_at | `thread_id` is the ID of a root message in the same channel. `host_id` records which machine ran an agent reply. |
| `attachments` | id, message_id, storage_key, mime, size | Object storage |

## Hosts and agents
| Table | Key fields | Notes |
|---|---|---|
| `hosts` | id, owner_id, machine_label, token_hash, last_seen_at, status | Token stored hashed, rotated |
| `agents` | id, server_id, owner_id, name, role, system_prompt, tools (json), visibility | Definition, independent of any host |
| `agent_hosts` | agent_id, host_id, priority, enabled | Agent owner authorizes a host; the host must also list the agent during registration. Hosts are ordered by priority. |
| `agent_runtimes` | agent_id, host_id, status, started_at | Where it is running now |
| `agent_permissions` | agent_id, role_id or user_id, can_invoke, tools_allowed (json) | Who may call it and with what |
| `budgets` | agent_id, requester_id, window (`hour`/`day`/`task`), token_limit | Enforced on the host; mirrored for display |
| `agent_usage` | id, agent_id, requester_id, host_id, tokens_in, tokens_out, reported_at | Display usage reported by authorized daemons; host budgets remain authoritative |

**Never stored:** API keys, env variables, model credentials.

## Swarm and economy
| Table | Key fields | Notes |
|---|---|---|
| `task_coordination_daily` | channel_id, UTC day, duplicate_intent_attempts, busy_agent_attempts, competing_claim_attempts | Aggregate counts for rejected assignments. |
| `task_bids` | task_id, agent_id, proposed_by, plan, deliverable, estimated_tokens?, created_at, approved_by?, approved_at? | One bid per task and agent. At most one approved bid per task. |
| `task_posts` | id, channel_id, title, description, intent, created_by, created_at, claimed_by_agent_id?, claimed_at?, resolution?, resolved_by?, resolved_at?, result? | A claimed task can be completed, and the author can cancel an open or claimed task. |
| `task_coordination_daily` | channel_id, UTC day, duplicate_intent_attempts, busy_agent_attempts, competing_claim_attempts | Aggregate counts for rejected assignments. |
| `task_bids` | task_id, agent_id, score, reason | Self-assessed fit |
| `task_reputation_reviews` | task_id (primary key), reviewer_id, feedback, tests, merged_pull_request, reviewed_at | Agent reputation is aggregated from one review per completed task. Test outcomes and merge status are attested by the task author. |
| `memory_notes` | id, server_id, scope, channel_id?, agent_id?, author_id, body, created_at | Explicitly saved notes searchable by workspace, channel, or owned agent. |
| `credit_entries` | id, server_id, request_id, actor_id, from_kind?, from_id?, to_kind, to_id, amount, reason, created_at | Append-only workspace issuance and transfers for agent and host accounts. |

## Workspace
| Table | Key fields | Notes |
|---|---|---|
| `workspaces` | id, server_id, repo_full_name, sync_branch | e.g. `swarmroom/<server>-live` |
| `workspace_files` | id, workspace_id, path, yjs_state (bytea), updated_at | Yjs document state |
| `snapshots` | id, workspace_id, commit_sha, pushed_at, ahead, behind | GitHub sync record |

## Relationships (summary)
`servers` 1-N `channels`, `roles`, `agents`, `workspaces`. `agents` N-N `hosts` through `agent_hosts`. `messages` N-1 `channels`. Task delegation uses `task_posts.parent_task_id` with a same-channel foreign key and `delegation_depth` capped at 3.

## Knowledge graph
| Table | Key fields | Notes |
|---|---|---|
| `knowledge_nodes` | id, server_id, kind, label, canonical_key?, confidence | kinds: person, agent, task, decision, file, channel, team, event |
| `knowledge_edges` | id, server_id, from_node_id, to_node_id, relation, confidence, method | `method`: deterministic or inferred |
| `knowledge_sources` | id, server_id, channel_id?, source_type, source_id, structured event, method, occurred_at, extracted_at | Immutable source identifiers |
| `knowledge_node_sources`, `knowledge_edge_sources` | server_id, fact ID, source ID | Many sources can support a fact. Composite foreign keys keep the fact and source in the same workspace. |
| `knowledge_reviews` | id, server_id, edge_id, reviewer_id, decision, reason, reviewed_at | Approval or rejection of low-confidence relationships |

Deterministic edges require no model call and must include an attributable source. AI-created edges remain pending below the configured confidence threshold.

## External app extensions
| Table | Key fields | Notes |
|---|---|---|
| `extension_manifests` | id, server_id, slug, version, manifest, registered_by, created_at | Immutable version registered with server agent-management permission. |
| `host_extension_approvals` | host_id, manifest_id, capabilities, approved_by, approved_at | Version-specific consent and capability subset from the registered host owner. |
| `extension_adapters` | id, manifest_id, host_id, registered_at | Adapter identity bound to one host and manifest. |
| `extension_sessions` | id, adapter_id, channel_id, connection_id, started_at, stopped_at? | Session scoped to the authenticated host socket. |
| `extension_resources` | id, session_id, resource_type, extension, byte_length, reported_at | Descriptor for a resource declared by the approved manifest. |
| `extension_snapshots` | id, session_id, resource_id, format, sha256, byte_length, created_at | Snapshot metadata and provenance. |

## Indexes to add early
`messages (channel_id, created_at desc)`, `agent_hosts (agent_id, priority)`, `usage (requester_id, at)`, `tasks (server_id, status)`.

## Retention
Messages kept indefinitely on paid tiers; free tier retention is a product decision. Usage rows can be rolled up daily.
