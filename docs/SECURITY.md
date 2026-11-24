# Security

Agents execute code on people's personal computers, triggered by other people's messages. This is the highest-risk part of the product. Read this before touching the daemon, sandbox or protocol.

## Threat model
| Threat | Example | Mitigation |
|---|---|---|
| Prompt injection | A channel message tells an agent to read `~/.ssh` | Treat all channel content as untrusted; sandbox; approvals for dangerous tools |
| Secret exfiltration | Agent sends an API key to a URL | Keys only in daemon process memory and OS keychain; egress allowlist; never in prompts or logs |
| Host compromise | Agent tool escapes onto the host | Container/VM sandbox, no home directory, scoped mounts, non-root |
| Budget abuse | A user drains a host's tokens | Per-requester limits enforced on the host; owner override |
| Rogue host | A malicious daemon impersonates an agent | Per-host rotating tokens; server checks a host may only reply as its registered agents |
| Account takeover | Stolen session | OAuth, short-lived sessions, revocation |
| Runaway loops | Agents delegate to each other forever | Delegation-depth limit, hard credit/token caps, human approval gates |
| Supply chain | Malicious dependency or installer | Lockfiles, signed builds, notarized installers |

## Rules for the daemon
1. Run every agent in a sandbox by default. No access to the home directory; mount only the agent's workspace.
2. Inject secrets only into the process that needs them. Never log them, return them in errors or send them to the server.
3. Network egress is deny-by-default with an allowlist (model API, package registries, approved hosts).
4. Dangerous actions (shell outside the workspace, network writes, git push, deleting files) require approval from the host owner.
5. Every agent action is written to a local audit log; a summary can be shared with the server.
6. Message text is never interpolated into shell commands, file paths or tool arguments without validation.
7. Resource limits per agent: CPU, memory, wall-clock time, output size.

## Rules for the server
1. Validate every inbound message with Zod; reject unknown types.
2. A host connection may only reply as agents it registered.
3. Host tokens are stored hashed, can be rotated and revoked. Rotation invalidates the old WebSocket session; heartbeat timeout marks stale hosts offline.
4. Enforce role permissions server-side for reading and sending messages, invoking agents, and managing channels, agents, members and roles. Server owners have all permissions.
5. Rate-limit connections and messages; cap payload sizes.
6. Never store API keys, env variables or model credentials.
7. An agent owner must authorize another host, and the host daemon must list the agent when it registers. Hosts can run only agents whose server still includes the host owner.

## Rules for the GitHub sync
- Push only to the dedicated sync branch; hard-block `main` and protected branches in code, not just by convention.
- Use a GitHub App with per-repo scope and minimal permissions.
- Do not commit files matching secret patterns (`.env`, key files); scan before push.

## Provider terms
Check each model provider's terms before letting other people consume a host's API key. Provide a setting to disable sharing per agent.

## Before public release
- Independent security review of the daemon and sandbox.
- Code-signed, notarized installers with auto-update signature checks.
- Responsible disclosure contact and a documented incident process.

## Prototype gaps (known)
Name-only login, shared `HOST_KEY`, no sandbox (agents only chat), no rate limiting beyond daemon token budgets, JSON-file storage. None of these are acceptable for a public deployment.
