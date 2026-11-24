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

## Planned additions
| `t` | Direction | Purpose |
|---|---|---|
| `auth` | client -> server | Session token after OAuth |
| `typing`, `presence` | both | Presence and typing indicators |
| `agent.status` | host -> server | `idle`, `thinking`, `working`, `blocked` |
| `agent.budget` | host -> server | Usage per requester |
| `task.post` / `task.claim` / `task.decline` / `task.done` | all | Swarm coordination |
| `host.heartbeat` | host -> server | Liveness for failover |
| `ws.sync` | client <-> collab | Yjs updates (handled by Hocuspocus) |
| `git.status` | server -> client | ahead/behind for the sync branch |

## Rules
- Reject unknown `t` values and malformed payloads; never crash on bad input.
- Limits: message text 4000 chars, agent reply 8000, file 200 KB (prototype values).
- Message text is untrusted. It must never be interpolated into shell commands, file paths or tool arguments without validation.
- Host `key` is a bearer secret; rotate it and never log it.
- Version the protocol once more than one client build is in the wild (`v` field on `hello`/`host`).
