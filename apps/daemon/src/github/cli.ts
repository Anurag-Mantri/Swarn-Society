import { maximumSnapshotBytes, workspaceSnapshotSchema } from "@swarmroom/protocol";
import { readFile, stat } from "node:fs/promises";
import { githubId, inspectGitHubInstallation, installationTarget, parseGitHubAppKey } from "./app.js";
import { readWorkspaceCommitReceipt } from "./receipt.js";
import { getWorkspaceSyncStatus } from "./status.js";
import { publishWorkspaceSnapshot } from "./snapshot.js";
import { createGitHubAppKeychain } from "./app-keychain.js";

async function main(): Promise<void> {
  const [action, appArg, secondArg, thirdArg, fileOrWorkspace, checkout, ...extra] = process.argv.slice(2);
  const appId = githubId.safeParse(appArg);
  if (!appId.success || extra.length || (checkout && action !== "status") ||
      (fileOrWorkspace && action !== "publish" && action !== "status" && action !== "receipt")) throw new Error("Provide a valid GitHub App ID.");
  const keychain = await createGitHubAppKeychain(appId.data);

  if (action === "key-import" && secondArg && !thirdArg) {
    const info = await stat(secondArg).catch(() => null);
    if (!info?.isFile() || info.size > 32_768) throw new Error("Choose a GitHub App PEM file on this host.");
    const pem = await readFile(secondArg, "utf8").catch(() => {
      throw new Error("Could not read the GitHub App key file.");
    });
    parseGitHubAppKey(pem);
    keychain.setPassword(pem);
    process.stdout.write("GitHub App key saved in the OS keychain.\n");
    return;
  }
  if (action === "key-delete" && !secondArg && !thirdArg) {
    keychain.deletePassword();
    process.stdout.write("GitHub App key removed from the OS keychain.\n");
    return;
  }
  if (action === "verify" || action === "publish" || action === "status" || action === "receipt") {
    const target = installationTarget.safeParse({
      appId: appId.data,
      installationId: secondArg,
      repositoryId: thirdArg,
    });
    if (!target.success) throw new Error("Provide valid app, installation, and repository IDs.");
    const pem = keychain.getPassword();
    if (!pem) throw new Error("Import the GitHub App key on this host first.");
    if (action === "verify") {
      const repository = await inspectGitHubInstallation(target.data, pem);
      process.stdout.write(`${JSON.stringify(repository)}\n`);
    } else if (action === "receipt") {
      if (!fileOrWorkspace) throw new Error("Provide the workspace ID.");
      const receipt = await readWorkspaceCommitReceipt(target.data, pem, fileOrWorkspace);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else if (action === "status") {
      if (!fileOrWorkspace || !checkout) throw new Error("Provide the workspace ID and the local Git checkout.");
      const status = await getWorkspaceSyncStatus(target.data, pem, fileOrWorkspace, checkout);
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      const snapshotPath = fileOrWorkspace;
      const info = snapshotPath ? await stat(snapshotPath).catch(() => null) : null;
      if (!snapshotPath || !info?.isFile() || info.size > 7 * maximumSnapshotBytes) {
        throw new Error("Choose a valid Swarmroom snapshot JSON file on this host.");
      }
      const value: unknown = await readFile(snapshotPath, "utf8").then(JSON.parse).catch(() => null);
      const snapshot = workspaceSnapshotSchema.safeParse(value);
      if (!snapshot.success) throw new Error("The workspace snapshot has invalid, blocked, or oversized files.");
      const published = await publishWorkspaceSnapshot(target.data, pem, snapshot.data);
      process.stdout.write(`${JSON.stringify(published)}\n`);
    }
    return;
  }
  throw new Error("Use github-app key-import <app-id> <pem-file>, key-delete <app-id>, or verify <app-id> <installation-id> <repository-id>, publish <app-id> <installation-id> <repository-id> <snapshot.json>, receipt <app-id> <installation-id> <repository-id> <workspace-id>, or status <app-id> <installation-id> <repository-id> <workspace-id> <checkout>.");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Could not verify the GitHub App installation."}\n`);
  process.exitCode = 1;
});
