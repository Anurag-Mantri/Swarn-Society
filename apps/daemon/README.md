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

Each invocation runs with general networking disabled, a read-only container filesystem, all Linux capabilities dropped, `no-new-privileges`, a 64 process limit, 512 MiB memory, one CPU, a 64 MiB temporary filesystem, and a 120 second wall-time limit. Only the configured workspace and a unique task-scoped provider socket are mounted. Standard output is capped at 32 KB and the reply is capped at 8,000 characters. The Podman CLI receives only a small allowlist of host environment variables; daemon credentials and provider keys are not passed into the container.

Podman enforces the wall-time limit at the container level. If the daemon cancels a task on disconnect or shutdown, or the Podman run fails, the daemon forcibly removes the named task container after the client exits.

The task-scoped Unix socket exposes only `POST /openai/responses`, `POST /openai/chat/completions`, and `POST /anthropic/messages`. Its JSON envelope is `{ "body": <provider JSON request> }`. Node agent images can call `requestProvider(route, body)` from `@swarmroom/daemon/provider-broker-client`; the task sets `SWARMROOM_PROVIDER_SOCKET` to the mounted socket path. The host chooses the fixed HTTPS endpoint and injects the matching agent-scoped key from the OS keychain; clients cannot set the URL or upstream headers. Redirects and streaming are rejected, each task is limited to 20 requests, request and response bodies are bounded, and requested output tokens are capped at 4,096. Provider error bodies are not returned to the agent. The socket is removed after the task exits.

The TypeScript package includes a minimal agent runtime. Its `swarmroom-agent` executable reads one protocol-validated task from stdin, loads a fixed image-baked config from `/etc/swarmroom/agent.json`, calls the selected provider through the broker, and writes the model reply to stdout. Start from `agent-runtime-config.example.json` when building a custom digest-pinned image. Tool execution, host-owner approvals, and macOS and Windows sandbox support remain future work. Without a sandbox configuration, the daemon connects but fails tasks closed.

Task start, success and failure records are appended to a local `audit.jsonl` file under the platform's Swarmroom state directory. The log contains timestamps, agent/requester/channel IDs and lifecycle state; it never contains message text, provider credentials or process output. The daemon does not start a task if it cannot write the start record. Per-tool action auditing and approvals remain future work.

## Requester token budgets

Set `SWARMROOM_AGENT_BUDGETS` to a JSON object with one policy for every configured agent to enable budgets. Each policy has an `ownerId`, `taskTokens`, `hourTokens`, and `dayTokens`; limits must be ordered from smallest to largest. The hour and day windows roll from the current time. The owner ID must match the user ID sent in the server task's `from` field. Owners are exempt. For example:

```sh
export SWARMROOM_AGENT_BUDGETS='{"scout":{"ownerId":"user-id","taskTokens":20000,"hourTokens":60000,"dayTokens":200000}}'
```

Before each upstream model call, the host reserves a conservative amount based on the serialized request size, output-token cap and provider framing allowance. It settles that reservation with provider-reported usage. If usage is absent or a request fails after dispatch, the full reservation stays charged. Usage metadata is persisted in a mode-0600 `budget-usage.jsonl` file; prompts and credentials are never stored. If no policy variable is set, existing agents run without requester-specific budgets.

The daemon sends provider-reported input and output counts to the control plane for display. The host ledger independently enforces requester budgets.

## GitHub App installation

Install a GitHub App on the approved repository with Contents read permission. On the host, import the downloaded App PEM into the OS keychain:

```sh
pnpm --filter @swarmroom/daemon github-app key-import <app-id> <pem-file>
pnpm --filter @swarmroom/daemon github-app verify <app-id> <installation-id> <repository-id>
```

Verification prints the repository's ID, full name, and default branch. The daemon signs app authentication locally, requests an installation token scoped to one repository with read access, and discards the token when the command exits. Delete the imported key with `github-app key-delete <app-id>`. Keep the downloaded PEM on the host and remove it after import.

### Publish a saved workspace snapshot

Download a saved snapshot in the workspace Files view. To publish, give the GitHub App Contents write permission on the approved repository and run this command on the host:

```sh
pnpm --filter @swarmroom/daemon github-app publish <app-id> <installation-id> <repository-id> <snapshot.json>
```

The command derives `swarmroom/<workspace-id>-live` from the snapshot. It verifies that the branch is neither the repository default nor protected and that no active ruleset applies. It uses non-forced updates and reports the branch and commit SHA. Provision the App without branch bypass privileges. Publishing overlays the saved workspace files onto the target tree and uses the default branch as the starting point if the snapshot branch does not exist.

### Compare a local checkout with GitHub

```sh
pnpm --filter @swarmroom/daemon github-app status <app-id> <installation-id> <repository-id> <workspace-id> <checkout>
```

The command verifies that the checkout's `origin` points to the approved repository. It compares the local and GitHub heads of the workspace snapshot branch, then reports their commit SHAs and the ahead/behind counts when the local Git graph can establish them. A `fetch-needed` result means the checkout lacks the remote commit or enough history to compare it. This operation reads from GitHub and the checkout. Fetching, pulling, merging, and publishing are separate actions.

## Manual file adapter

A Linux host can opt in to report one approved local file's snapshot metadata on connection. See [manual file adapter setup](../../docs/EXTENSIONS.md#manual-file-adapter) for the manifest, host approval, and `SWARMROOM_FILE_ADAPTER` configuration.

## Deploy the daemon to a remote Linux host

With Node.js 22 and the workspace's pnpm version, build a relocatable daemon package on Linux:

```sh
pnpm install --frozen-lockfile
bash apps/daemon/scripts/package-linux.sh /absolute/path/to/new-release-directory
```

Build on the same CPU architecture and libc family as the target so the package includes the matching native keychain binding. Copy the resulting directory as a unit, preserving symlinks. The target needs Node.js 22, a running Secret Service for the daemon account, and local rootless Podman for sandbox execution. It does not need the monorepo or pnpm.

As the unprivileged daemon account, configure the control-plane WebSocket URL, host name, agent names, and optional sandbox settings. Store the host token by running `node dist/token-cli.js set` inside the release directory, then start the daemon with `node dist/main.js`. Use the ordinary daemon configuration and audit log paths. Keep provider credentials in the target account's keychain and supply a digest-pinned image and explicit workspace mounts before running agents.
