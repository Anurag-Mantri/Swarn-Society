# Swarmroom Snapshot Status for VS Code

The extension compares a local checkout's current commit with the published or unpublished Swarmroom snapshot. It shows the current SHA, the remote snapshot SHA, and whether the checkout commit is included in the snapshot history when enough Git history is available.

1. Set up the approved GitHub App installation in the daemon's OS keychain.
2. Run `pnpm build` from the Swarmroom repository.
3. Open a development window over a trusted Git checkout:

   ```sh
   code --extensionDevelopmentPath=/path/to/Swarmroom/apps/vscode /path/to/approved-checkout
   ```

4. Set the following in VS Code User Settings:

   - `swarmroom.snapshotStatus.daemonCli` points to the absolute path of `apps/daemon/dist/github/cli.js`.
   - `swarmroom.snapshotStatus.appId`, `installationId`, and `repositoryId` identify the GitHub App target.
   - `swarmroom.snapshotStatus.workspaceId` is the workspace UUID shown in the snapshot branch name.

5. From the Command Palette, run **Swarmroom: Check Workspace Snapshot Status**. The status bar keeps the result and runs the same check when clicked.

The extension delegates the check to the local host daemon CLI. The GitHub key and installation token stay within the host and the command only reads the Git graph. The extension is disabled in Restricted Mode.
