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
| `host` | host -> server | `token`, `machine`, `agents[]`, optional `version` | Register a host and its agent names |
| `host.heartbeat` | host -> server | optional `at` | Mark the host as active |
| `reply` | host -> server | `channelId`, `agent`, `text` | Store and broadcast an agent reply |
| `host.registered` | server -> host | `hostId` | Confirm host registration |

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
