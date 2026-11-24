# Host daemon

The TypeScript host transport connects to the control plane, validates server frames, sends heartbeats, and routes tasks through `SandboxRunner`. Until a sandbox backend is configured, tasks fail closed and are not executed.

Copy `.env.example` values into the daemon environment. Use `wss://` for remote control planes; plain `ws://` is accepted only for localhost development.

Store a rotated host token without placing it in shell history, environment variables, or logs:

```sh
pnpm --filter @swarmroom/daemon token set
```

Enter the token at the hidden prompt. It is stored in the OS keychain, scoped to the control plane host. Linux requires Secret Service to be available. Remove it with `pnpm --filter @swarmroom/daemon token delete`.

Store an agent provider credential with `pnpm --filter @swarmroom/daemon token secret set scout OPENAI_API_KEY`. The credential is entered at a hidden prompt and scoped in the OS keychain by control plane, agent and variable name. Remove it with `token secret delete scout OPENAI_API_KEY`. Credential values are never accepted as command arguments or environment variables.

Start the daemon with `pnpm --filter @swarmroom/daemon dev` after setting the non-secret configuration variables.

## Rootless Podman sandbox

On Linux, task execution can be enabled by setting both `SWARMROOM_SANDBOX_IMAGE` and `SWARMROOM_AGENT_WORKSPACES`. The image must use an immutable `@sha256:` digest and provide `/usr/local/bin/swarmroom-agent`; that executable reads one JSON task from stdin and writes the agent reply to stdout. The workspace variable is a JSON object mapping each configured agent name to its absolute workspace directory. The daemon checks that Podman is local and rootless, that each workspace exists, and that the workspace does not contain the user's entire home directory.

Each invocation runs with networking disabled, a read-only container filesystem, all Linux capabilities dropped, `no-new-privileges`, a 64 process limit, 512 MiB memory, one CPU, a 64 MiB temporary filesystem, and a 120 second wall-time limit. Only the configured workspace is mounted read/write. Standard output is capped at 32 KB and the reply is capped at 8,000 characters. The Podman CLI receives only a small allowlist of host environment variables; daemon credentials and provider keys are not passed into the container.

Networking is currently disabled entirely. Stored provider credentials are not loaded into containers; the agent image cannot call model providers until a separate egress broker and host-side credential integration are implemented. macOS and Windows sandbox support also remain open. Without a sandbox configuration, the daemon connects but fails tasks closed.
