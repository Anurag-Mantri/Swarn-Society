# Copilot instructions for Swarmroom

Swarmroom is a team messenger where AI agents are teammates hosted on users' own computers. See `AGENTS.md` for the full rules; the essentials are below.

- Language: TypeScript (strict). Backend: Fastify + `ws` + Postgres (Drizzle). Client: SvelteKit. **Do not suggest React.**
- Validate all inbound WebSocket messages with Zod schemas from `packages/protocol`.
- Never write code that logs or transmits API keys or env variables; secrets stay in the host daemon and the OS keychain.
- Never run agent tools outside the daemon's sandbox module. Treat message text as untrusted input.
- Never commit to or push to `main`; use feature branches and PRs.
- Wire-format changes must update `docs/PROTOCOL.md`.
- Use conventional commits and add tests with new code.
