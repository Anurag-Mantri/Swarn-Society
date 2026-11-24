import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { z } from "zod";

const run = promisify(execFile);
const command = "swarmroom.snapshotStatus";
const id = z.string().regex(/^[1-9]\d*$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/i);
const settingsSchema = z.object({
  daemonCli: z.string().refine((path) => isAbsolute(path) && /[/\\]github[/\\]cli\.js$/i.test(path)),
  appId: id,
  installationId: id,
  repositoryId: id,
  workspaceId: z.string().uuid(),
});
const statusSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string(),
  localHead: commit.nullable(),
  remoteHead: commit.nullable(),
  checkoutHead: commit.nullable(),
  checkoutIncluded: z.boolean().nullable(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  state: z.enum(["unpublished", "fetch-needed", "local-branch-missing", "up-to-date", "pull-needed", "local-ahead", "diverged"]),
});
type SyncStatus = z.infer<typeof statusSchema>;
const labels: Record<SyncStatus["state"], string> = {
  unpublished: "Unpublished",
  "fetch-needed": "Fetch needed",
  "local-branch-missing": "Local branch missing",
  "up-to-date": "Up to date",
  "pull-needed": "Pull needed",
  "local-ahead": "Local branch ahead",
  diverged: "Branches diverged",
};

async function selectFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders?.filter(({ uri }) => uri.scheme === "file") ?? [];
  if (folders.length === 0) {
    await vscode.window.showWarningMessage("Open a local Git folder to check its snapshot status.");
    return;
  }
  if (folders.length === 1) return folders[0];
  return (await vscode.window.showQuickPick(
    folders.map((folder) => ({ folder, label: folder.name, description: folder.uri.fsPath })),
    { placeHolder: "Choose the Git checkout to compare" },
  ))?.folder;
}

async function readStatus(checkout: string): Promise<SyncStatus> {
  const config = vscode.workspace.getConfiguration("swarmroom.snapshotStatus");
  const settings = settingsSchema.safeParse({
    daemonCli: config.get("daemonCli"),
    appId: config.get("appId"),
    installationId: config.get("installationId"),
    repositoryId: config.get("repositoryId"),
    workspaceId: config.get("workspaceId"),
  });
  if (!settings.success) {
    throw new Error("Set the daemon CLI path and GitHub and workspace IDs in the Swarmroom user settings.");
  }
  const { daemonCli, appId, installationId, repositoryId, workspaceId } = settings.data;
  const cli = await stat(daemonCli).catch(() => null);
  if (!cli?.isFile()) throw new Error("Build the host daemon and verify the configured CLI path.");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  try {
    const result = await run("node", [
      daemonCli, "status", appId, installationId, repositoryId, workspaceId, checkout,
    ], { cwd: dirname(daemonCli), env, timeout: 60_000, maxBuffer: 16_384 });
    return statusSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error("Could not check the snapshot. Verify Node.js, the local checkout, and the GitHub App setup.");
  }
}

function describe(status: SyncStatus): string {
  const inclusion = status.checkoutIncluded === null
    ? "Commit inclusion unknown"
    : status.checkoutIncluded ? "Commit is included" : "Commit is outside the snapshot";
  const counts = status.ahead === null || status.behind === null ? "" : ` (${status.ahead} ahead, ${status.behind} behind)`;
  return `${labels[status.state]}${counts}. ${inclusion}.`;
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = command;
  let busy = false;
  context.subscriptions.push(statusBar, vscode.commands.registerCommand(command, async () => {
    if (busy || !vscode.workspace.isTrusted) return;
    busy = true;
    try {
      const folder = await selectFolder();
      if (!folder) return;
      const status = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Checking Swarmroom snapshot" },
        () => readStatus(folder.uri.fsPath),
      );
      statusBar.text = `$(git-commit) Snapshot: ${labels[status.state]}`;
      statusBar.tooltip = `${status.repository}/${status.branch}\n${describe(status)}\nCheckout: ${status.checkoutHead ?? "No commit"}\nSnapshot: ${status.remoteHead ?? "Unpublished"}`;
      statusBar.show();

      const message = `Checkout ${status.checkoutHead?.slice(0, 8) ?? "has no commit"}. ${describe(status)}`;
      if (status.remoteHead) {
        const selected = await vscode.window.showInformationMessage(message, "Open snapshot commit");
        if (selected) {
          const repository = status.repository.split("/").map(encodeURIComponent).join("/");
          await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repository}/commit/${status.remoteHead}`));
        }
      } else {
        await vscode.window.showInformationMessage(message);
      }
    } catch (error: unknown) {
      statusBar.hide();
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not check the snapshot.");
    } finally {
      busy = false;
    }
  }));
}
