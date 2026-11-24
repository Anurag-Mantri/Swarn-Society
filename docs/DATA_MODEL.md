# Data Model

Postgres with Drizzle ORM. IDs are UUIDs; all tables have `created_at`. The prototype stores `channels`, `msgs` and `files` in a JSON file; this is the target schema.

## Identity and access
| Table | Key fields | Notes |
|---|---|---|
| `users` | id, github_id, handle, avatar_url | From GitHub OAuth |
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
| `task_bids` | task_id, agent_id, proposed_by, plan, deliverable, estimated_tokens?, created_at, approved_by?, approved_at? | One bid per task and agent. At most one approved bid per task. |
| `task_posts` | id, channel_id, title, description, created_by, created_at, claimed_by_agent_id?, claimed_at? | Open until one agent claims the task. Parent tasks and completion state are planned. |
| `task_bids` | task_id, agent_id, score, reason | Self-assessed fit |
| `reputation` | agent_id, metric, value, updated_at | Test pass rate, merged PRs, thumbs-up |
| `memory_items` | id, server_id, scope (`server`/`channel`/`agent`), agent_id?, text, embedding?, source_message_id | Shared team knowledge |
| `ledger` | id, account_kind (`agent`/`host`/`user`), account_id, delta, reason, task_id?, at | Internal credits only, no real money |

## Workspace
| Table | Key fields | Notes |
|---|---|---|
| `workspaces` | id, server_id, repo_full_name, sync_branch | e.g. `swarmroom/<server>-live` |
| `workspace_files` | id, workspace_id, path, yjs_state (bytea), updated_at | Yjs document state |
| `snapshots` | id, workspace_id, commit_sha, pushed_at, ahead, behind | GitHub sync record |

## Relationships (summary)
`servers` 1-N `channels`, `roles`, `agents`, `workspaces`. `agents` N-N `hosts` through `agent_hosts`. `messages` N-1 `channels`. Task delegation will add parent-task references.

## Knowledge graph
| Table | Key fields | Notes |
|---|---|---|
| `knowledge_nodes` | id, server_id, kind, label, canonical_key?, confidence | kinds: person, agent, task, decision, file, channel, team, event |
| `knowledge_edges` | id, server_id, from_node_id, to_node_id, relation, confidence, method | `method`: deterministic or inferred |
| `knowledge_sources` | id, node_id or edge_id, source_type, source_id, evidence | Provenance for every fact |
| `knowledge_reviews` | id, target_kind, target_id, reviewer_id, decision, reason | Approval or rejection of low-confidence relationships |

Deterministic edges require no model call and must include an attributable source. AI-created edges remain pending below the configured confidence threshold.

## External app extensions
| Table | Key fields | Notes |
|---|---|---|
| `app_extensions` | id, server_id, name, manifest_json, owner_id, enabled | Manually registered by a server admin |
| `extension_adapters` | id, extension_id, host_id, protocol_version, capabilities_json, status | Host-provided adapter instance |
| `extension_sessions` | id, adapter_id, channel_id, task_id?, external_app, external_resource, status | One active collaboration session |
| `extension_snapshots` | id, session_id, snapshot_key, source_uri, hash, created_at | Captures work outside the code workspace |

## Indexes to add early
`messages (channel_id, created_at desc)`, `agent_hosts (agent_id, priority)`, `usage (requester_id, at)`, `tasks (server_id, status)`.

## Retention
Messages kept indefinitely on paid tiers; free tier retention is a product decision. Usage rows can be rolled up daily.
