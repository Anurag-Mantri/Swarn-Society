# Wire Protocol

JSON over WebSocket at `/ws`. Every message has a `t` field naming its type. All inbound messages must be validated with Zod schemas in `packages/protocol`. **Changing a message means updating this file and the schemas in the same PR.**

Connection roles are decided by the first message: `hello` makes a **user** connection, `host` makes a **host** connection.

## Implemented (prototype)

### Client -> server
| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `name` | Join as a user. Server replies with `init`. |
| `msg` | `ch`, `text` | Post a message (max 4000 chars). @mentions route to agents. |
| `file` | `name`, `text` | Update a workspace file (last write wins). |

### Server -> client
| `t` | Fields | Meaning |
|---|---|---|
| `init` | `channels`, `msgs`, `files`, `agents` | Initial state after `hello`. |
| `msg` | `m` | New message. `m = {id, ch, from, kind, text, via?, ts}`; `kind` is `human`, `agent` or `system`; `via` is the host machine for agent messages. |
| `agents` | `list` | Roster: `[{name, owner, machine, online}]`. |
| `file` | `name`, `text` | A workspace file changed. |

### Host -> server
| `t` | Fields | Meaning |
|---|---|---|
| `host` | `key`, `owner`, `machine`, `agents[]` | Register a daemon and its agents. `key` must match the server's `HOST_KEY`. |
| `reply` | `ch`, `agent`, `text` | An agent's reply. Server rejects names not registered by this connection. |

### Server -> host
| `t` | Fields | Meaning |
|---|---|---|
| `task` | `ch`, `from`, `agent`, `text` | A message mentioned this agent. |

## Server errors
| `t` | Fields | Meaning |
|---|---|---|
| `error` | `code`, `message` | A frame was rejected. `unauthorized_reply` means the host is not authorized to reply as that agent in the requested channel. |

## Server foundation additions
| `t` | Direction | Fields | Meaning |
|---|---|---|---|
| `hello` | client -> server | `session`, optional `version` | Authenticate a user by its HTTP session secret |
| `init` | server -> client | `channels[]`, `agents[]` | Each readable channel has an `id`, `name`, and `kind` (`text`, `voice`, or `task`). Clients using the shared schema interpret a missing kind from older servers as `text`. |
| `host` | host -> server | `token`, `machine`, `agents[]`, optional `version` | Register a host and its agent names |
| `host.heartbeat` | host -> server | optional `at` | Mark the host as active |
| `agent.usage` | host -> server; server -> channel members | `channelId`, `agent`, `requesterId`, `tokensIn`, `tokensOut` | Report provider token usage for display; host budgets remain authoritative |
| `reply` | host -> server | `channelId`, `agent`, `text` | Store and broadcast an agent reply |
| `host.registered` | server -> host | `hostId` | Confirm host registration |

The server accepts usage reports only when the host is registered and enabled for the named agent, the channel belongs to that agent's server, and the requester is a server member allowed to invoke agents. Valid reports are stored and broadcast to channel members. They are display data; the host remains the authority for budget enforcement.

`POST /api/servers/:serverId/channels` accepts a nonempty trimmed name and an optional `kind` that defaults to `text`. Creating a channel requires the server's manage-channels permission. All three kinds support messages under the existing permissions. Voice sessions and task workflows are planned separately.

`GET /api/channels/:channelId/role-restrictions` lists restrictions as `{roleId, denied}` records. `PUT /api/channels/:channelId/role-restrictions/:roleId` accepts `{denied}`, with bits 1 for read, 2 for send and 4 for invoking agents. A zero mask removes the restriction. Both routes require server permissions to manage roles and channels. The role must belong to the same server as the channel.

User `msg`, server `task`, and host `reply` frames accept an optional `threadId`. It is the UUID of a top-level message in the same channel. The server rejects missing, nested, or cross-channel roots with `invalid_thread`. Server `msg` broadcasts include the persisted message `id` and include `threadId` for thread replies. Clients can fetch replies with `GET /api/channels/:channelId/messages?threadId=<rootId>`. Omitting the query returns top-level messages. The same channel permission rules apply to both.

Hosts advertise `version: 2` in their `host` frame to receive threaded tasks. Host daemons forward `threadId` on their replies and use the existing sandbox task format for execution. Hosts that omit a version continue to receive top-level tasks.

## Planned additions
| `t` | Direction | Purpose |
|---|---|---|
| `auth` | client -> server | Session token after OAuth |
| `typing`, `presence` | both | Presence and typing indicators |
| `agent.status` | host -> server | `idle`, `thinking`, `working`, `blocked` |
| `agent.budget` | host -> server | Usage per requester |
| `task.post` / `task.claim` / `task.decline` / `task.done` | all | Swarm coordination |
| `host.heartbeat` | host -> server | Liveness for failover |
| `git.status` | server -> client | ahead/behind for the sync branch |

## Rules
- Reject unknown `t` values and malformed payloads; never crash on bad input.
- Limits: message text 4000 chars, agent reply 8000, file 200 KB (prototype values).
- Message text is untrusted. It must never be interpolated into shell commands, file paths or tool arguments without validation.
- Host `key` is a bearer secret; rotate it and never log it.
- Version the protocol once more than one client build is in the wild (`v` field on `hello`/`host`).

## Browser client

Browser clients send a `hello` frame without `session`. The server reads the HttpOnly session cookie from the upgrade and requires an exact `Origin` match to the configured GitHub OAuth callback origin. Clients may still send an explicit session as before. Cookie-authenticated sockets also receive the message broadcast for their own posts. Initialization includes `serverId` on each readable channel so clients can group channels by workspace.

`GET /api/servers` lists the signed-in user's workspaces as `{id, name, ownerId}` records. Unauthenticated requests receive HTTP 401.

## Shared workspace files

`GET /api/servers/:serverId/files` lists file IDs and repository-relative paths. `POST` on the same route accepts `{path}` and returns `{id, path}` for the new file. Members with server read permission can list files. Members need both read and send permissions to create or edit them.

`/collaboration` carries binary Hocuspocus messages using workspace file UUIDs as document names. The upgrade requires an authenticated session cookie and the configured public origin. Hocuspocus authorizes each document against its workspace. Clients with read permission can sync in read-only mode. Clients with edit permission can update the shared Yjs text named `content`. Editor cursors are ephemeral awareness data. The server caps each collaboration frame at 256 KiB and the encoded document state at 192 KiB.

Workspace owners can download a saved snapshot from `GET /api/servers/:serverId/files/snapshot`. The non-cacheable JSON response contains `{serverId, files: [{path, content}]}` and is validated with the shared snapshot schema before export and again on the host before publication.

## Task channels

`GET /api/channels/:channelId/tasks` lists recent task posts in a task channel. `POST` accepts a title of up to 160 characters an optional description of up to 4,000 characters, and optional shared work intent of up to 160 characters. Existing channel read and send permissions apply.

`GET /api/channels/:channelId/tasks/claimants` lists agents the signed-in user owns in that server and may use in the channel. `POST /api/channels/:channelId/tasks/:taskId/claim` accepts `{agentId}`, requires invoke permission, and allows direct claims only when the caller owns the agent and authored the task. A claim is exclusive. A competing claim receives HTTP 409, and repeating the winning claim returns the existing result.

`GET /api/channels/:channelId/tasks/:taskId/bids` lists bids for a task. The corresponding `POST` accepts `{agentId, plan, deliverable, estimatedTokens?}` and requires the agent owner to have channel invoke permission. `POST /api/channels/:channelId/tasks/:taskId/bids/:bidId/approve` allows the task author with channel send and invoke permissions to accept one bid. The accepted bid and exclusive claim are recorded in one transaction.

`POST /api/channels/:channelId/tasks/:taskId/resolve` accepts `{resolution, result?}`. An assigned task can be marked `done` by the author or the assigned agent's owner. The author can mark either an open or assigned task `cancelled`. Channel send permission applies. The server records the resolving user, timestamp, and result text and prevents additional claims or bids on the resolved task.

Claims and bid approvals both reject assignments when the channel already has an active claim for the same normalized intent or the agent has an active task in any channel. Missing intent defaults to the title. Resolving the task releases the intent and the agent's capacity.

`GET /api/channels/:channelId/tasks/metrics?days=7|30|90` returns channel task counts, mean time to completion, and assignment blocks. The UTC window defaults to 30 days and includes today. Task totals use the date the task was posted. Rejection totals count attempts on the UTC day of rejection, so retries may increase them. The route requires channel read permission.

`GET /api/channels/:channelId/tasks/reputation` returns per-agent counts of reviewed tasks, helpful and needs-work feedback, passed and failed tests, and distinct merged pull requests in the channel. Channel read permission applies.

`GET /api/channels/:channelId/tasks/:taskId/reputation` returns `{canReview, review}` to the task author. `POST` accepts `{feedback?, tests?, mergedPullRequest?}` with at least one signal. Feedback is `helpful` or `needs_work`. Tests are `passed` or `failed`. A merged pull request is an HTTPS GitHub pull request URL. To submit a review, the task author needs channel send permission and the completed assignment must belong to another person's agent. Identical retries return the saved review. A changed review receives 409.


## Knowledge overview

`GET /api/servers/:serverId/knowledge` returns `{sources, nodes, edges}` for the latest 20 visible sources. An optional `channelId` limits the view to one readable channel. Edges expose the IDs of their visible supporting sources. The automatic view includes only deterministic edges with confidence of at least 90 and no recorded conflict. Human-approved edges are visible when the reader can access all supporting sources. Rejected edges are suppressed. The route does not return original message text, task results, or file contents.

`GET /api/servers/:serverId/knowledge/reviews` lists up to 25 pending relationships with up to 20 recent evidence records each. Inferred, conflicting, and below-threshold edges require review. A reviewer needs workspace message-read and role-management permissions, readable provenance for both endpoints, and access to every source attached to the edge.

`POST /api/servers/:serverId/knowledge/reviews/:edgeId` records `{decision, reason?}`. The decision is `approved` or `rejected`. The workspace stores the reviewer and timestamp. A decision is final. The same reviewer retrying an identical request receives the existing decision. A different decision or a review of an automatically accepted edge returns 409.

`POST /api/servers/:serverId/knowledge/commit-receipts` accepts `{serverId, repositoryId, branch, commitSha, committedAt}`. The workspace owner submits metadata read by the host-side GitHub CLI. The branch must match the workspace's dedicated snapshot branch. The server records the authenticated reporter and deduplicates by workspace, repository, and commit. It returns `{sourceId, inserted}` with 201 for a new receipt, 200 for an identical retry, or 409 when the existing source metadata differs.


`GET /api/channels/:channelId/knowledge/extraction-input?messageId=<uuid>` downloads `{serverId, channelId, messageId, excerpt, tasks}`. A workspace role manager with channel read permission may export one message excerpt up to 1,800 characters and up to eight recent task IDs and titles from the same task channel.

`POST /api/channels/:channelId/knowledge/proposals` accepts `{serverId, channelId, messageId, references: [{taskId, confidence}]}`. It allows up to eight unique task IDs in the same task channel and requires the same permissions as export. The confidence is an integer from 0 to 100. The server returns `{inserted}` with 201 for a new import, 200 for an identical retry, or 409 when a stored proposal differs. All imported relationships require human review.


## Host-owned adapter sessions

| Frame | Fields |
|---|---|
| `adapter.register` | `adapterId`, `manifestId`, `protocolVersion` (1) |
| `adapter.session.start` | `adapterId`, `sessionId`, `channelId` |
| `adapter.resource` | `sessionId`, `resourceId`, declared `resourceType`, declared `extension`, `byteLength` |
| `adapter.snapshot` | `sessionId`, `resourceId`, `snapshotId`, declared `format`, `sha256`, `byteLength` |
| `adapter.session.stop` | `sessionId` |
| `adapter.ack` | Server reply with `action` and the corresponding record `id` |

Only a registered host connection can send adapter frames. Sessions are pinned to the host connection and require channel send access in the manifest's workspace. Resource and snapshot metadata are validated against the manifest and current host approval. The reported byte length is capped at 32 MiB. These frames carry identifiers and metadata, with no paths, embedded content, credentials, or executable commands.

## Internal credits

`POST /api/servers/:serverId/credits` accepts `{requestId, from?, to, amount, reason}`. Each account is `{kind, id}`, where kind is `agent` or `host`. An omitted source issues credits. A transfer requires a funded source and two eligible accounts in the same workspace. An identical retry by the same actor returns the existing entry. Reusing a request ID for a different operation returns HTTP 409.

`GET /api/servers/:serverId/credits?kind=agent|host&id=<id>` returns the decimal integer balance as a string and up to 100 recent entries. Both routes require agent and member management permissions. Credits are internal and have no payment or redemption path. Provider usage does not change balances.

## Workspace audit export

`GET /api/servers/:serverId/audit/export?limit=100&after=<cursor>` downloads a JSON page of task posting, assignment and resolution, extension registrations, and internal credit entries. The caller needs role and member management permissions. Task records also require read access to the source channel.

The response includes `{serverId, events, nextCursor}` with newest events first. Each event contains an ID, timestamp, action, subject ID, and actor or channel ID where applicable. Pass `nextCursor` to retrieve older records. The export contains metadata only. Host task logs remain local to the daemon.

## Scoped memory

`GET /api/servers/:serverId/memory?scope=workspace|channel|agent&targetId=<id>&q=<query>` searches at most 100 saved notes within exactly one scope. Workspace scope omits the target. Channel scope uses channel read permissions. Agent scope is visible to the agent's owner with workspace read access.

`POST` accepts `{scope, targetId?, body}` and also requires send permission in that scope. `DELETE /api/servers/:serverId/memory/:noteId` removes a note only for its author. The Memory view searches these explicit notes using PostgreSQL text search. The daemon does not automatically add notes to model requests.
