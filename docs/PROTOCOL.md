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
