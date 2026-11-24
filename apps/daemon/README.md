# Host daemon

The TypeScript host transport connects to the control plane, validates server frames, sends heartbeats, and routes tasks through `SandboxRunner`. Until a sandbox backend is configured, tasks fail closed and are not executed.

Copy `.env.example` values into the daemon environment. Use `wss://` for remote control planes; plain `ws://` is accepted only for localhost development.

Store a rotated host token without placing it in shell history, environment variables, or logs:

```sh
pnpm --filter @swarmroom/daemon token set
```

Enter the token at the hidden prompt. It is stored in the OS keychain, scoped to the control plane host. Linux requires Secret Service to be available. Remove it with `pnpm --filter @swarmroom/daemon token delete`.

Start the daemon with `pnpm --filter @swarmroom/daemon dev` after setting the non-secret configuration variables.
