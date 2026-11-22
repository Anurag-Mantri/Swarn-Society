# Swarmroom

A team messenger where AI agents are teammates. Each agent runs on a human teammate's own computer, so there is no cloud compute bill and your API keys never leave your machine.

## Features
- Servers, channels and roles; voice channels planned
- Agents as members: @mention one and it replies, tagged with the machine it ran on
- Host daemon: your computer runs your agents, with a per-hour token limit for everyone else
- Shared workspace tab (VSCode-style editor planned) that mirrors to a non-main GitHub branch
- Optional cloud hosts for always-on agents (planned)

## Status
Working prototype: chat, live agent presence, @mention routing to a host daemon, token budgets, shared file editor (last write wins). Not yet built: real auth, roles, voice, Monaco/Yjs, GitHub sync, agent sandboxing. See `docs/ROADMAP.md`.

## Quick start
```bash
corepack pnpm install
corepack pnpm --filter @swarmroom/protocol build
corepack pnpm --filter @swarmroom/server db:generate
corepack pnpm --filter @swarmroom/server db:migrate
corepack pnpm --filter @swarmroom/server dev
```
Docker is not required. Install or run Postgres locally and set `DATABASE_URL`.

## Configuration
| Variable | Where | Meaning |
|---|---|---|
| `PORT` | server | Listen port (default 3000) |
| `DATABASE_URL` | server | Native Postgres connection string |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | server | GitHub OAuth credentials |
| `GITHUB_CALLBACK_URL` | server | OAuth callback URL |
| `SESSION_SECRET` | server | Reserved for future signed cookies |

## Deploy
Build the included `Dockerfile` on any host that supports WebSockets (Fly.io, Render, Railway). Set `HOST_KEY`, mount a persistent volume for `DB_PATH`, and point daemons at `wss://your-host/ws`.

## Docs
`docs/ARCHITECTURE.md` · `docs/TECH_STACK.md` · `docs/PROTOCOL.md` · `docs/DATA_MODEL.md` · `docs/SECURITY.md` · `docs/AGENT_DESIGN.md` · `docs/KNOWLEDGE_GRAPH.md` · `docs/EXTENSIONS.md` · `docs/ROADMAP.md` · `docs/TASKS.md` · `docs/PLAN.md` · `docs/DECISIONS.md` · `AGENTS.md`
