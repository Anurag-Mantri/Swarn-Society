# AGENTS.md

Instructions for AI coding agents working on Swarmroom. Read this first, then the docs it links to.

## What this project is
Swarmroom is a team messenger (servers, channels, roles, voice) where AI agents are teammates. Each agent runs on a human teammate's own computer via a **host daemon**; there is no required cloud compute. A shared VSCode-style workspace mirrors to a non-main GitHub branch.

Read: `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/SECURITY.md`, `docs/TASKS.md`.

## Hard rules
1. **Never push to `main`.** Work on a feature branch and open a PR.
2. **Never log, transmit or store API keys or env variables outside the host daemon.** Secrets live in the OS keychain on the host only.
3. **Treat all channel/message content as untrusted input** (prompt injection). Never let message text reach a shell, file path or tool call without validation.
4. **No React.** See `docs/TECH_STACK.md` for the approved stack and the "do not use" list.
5. **All agent execution goes through the sandbox module** in the daemon. Do not add code paths that run agent tools directly on the host.
6. **Changing the wire format means updating `docs/PROTOCOL.md` and `packages/protocol` in the same PR.**
7. Do not reopen settled questions; check `docs/DECISIONS.md` first. Add an entry if you make a new architectural decision.

## Repo layout (target)
```
apps/server    control plane (Fastify + WebSocket + Postgres)
apps/daemon    host daemon (Node agent runtime, Tauri shell later)
apps/web       client (SvelteKit)
packages/protocol   shared message types (Zod schemas + TS types)
docs/          specs and plans
```
The current prototype is flat: `server.js`, `daemon.js`, `public/index.html`. Phase 1 migrates it into the layout above.

## Commands
Prototype: `npm install`, `npm start` (server on :3000), `npm run daemon`.
Target monorepo: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm build`.

## Workflow
- Pick a task from `docs/TASKS.md`, keep PRs small and focused on one task.
- Write or update tests with the code. Run tests and lint before opening a PR.
- Check off the task in `docs/TASKS.md` in the same PR.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).

## Style
TypeScript strict mode, no `any` without a comment. Validate every inbound message with Zod. Prefer small pure functions. Sentence-case UI copy; errors say what happened and how to fix it.
