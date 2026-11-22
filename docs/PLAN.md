# Plan

The working plan for the next stretch of work. `ROADMAP.md` is the long view; `TASKS.md` is the checklist. This file says what we are doing now and why.

## Current focus: Phase 1, agent network MVP
**Goal:** a small team (3-5 people) uses Swarmroom daily with real logins, each running their own agents on their own computers, safely.

## Sequence
1. **Week 1: foundation.** Monorepo, CI, `packages/protocol` with Zod schemas, native or containerized Postgres.
2. **Weeks 2-3: server.** Port to Fastify/TypeScript, Postgres schema, GitHub OAuth, host tokens.
3. **Weeks 3-5: daemon.** TypeScript port, keychain storage, sandbox module, egress allowlist, approvals, audit log.
4. **Weeks 4-6: client.** SvelteKit shell, chat, hosts and agents pages.
5. **Weeks 7-8: release.** Tauri shell, signed installers, deploy, onboard first team.

## Why this order
The sandbox and secret handling are the riskiest, least reversible parts, so they come before polish or features. The protocol package comes first because server, daemon and client all depend on it.

## Validation in parallel
Run the Phase 0 interviews while building. Ask: how do you share agents today, what breaks, would you host agents for teammates, and what would stop you from letting others use your API key?

## Definition of done for Phase 1
- Real accounts and per-server roles
- Agents run only inside the sandbox
- Per-requester budgets survive restarts
- Host tokens are hashed and revocable
- A team has used it for a week without data loss or a security incident

## Risks to watch
Sandbox complexity across macOS, Windows and Linux; provider terms on key sharing; scope creep into voice or the IDE before the agent loop is solid.

## Free-tier boundary
The core agent network, chat, workspace and knowledge graph MVP must run locally or on free infrastructure.
Paid observability, hosting, analytics and billing are optional add-ons, not required libraries or runtime dependencies.
Docker is optional for local development. Docker Compose may provide Postgres, but native Postgres is sufficient.

## Review cadence
Weekly: update `TASKS.md` and note surprises. At the end of each phase: demo to users and record decisions in `DECISIONS.md`.
