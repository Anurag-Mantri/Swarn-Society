import { readFile, stat } from "node:fs/promises";
import { githubId, inspectGitHubInstallation, installationTarget, parseGitHubAppKey } from "./app.js";
import { createGitHubAppKeychain } from "./app-keychain.js";

async function main(): Promise<void> {
  const [action, appArg, secondArg, thirdArg, ...extra] = process.argv.slice(2);
  const appId = githubId.safeParse(appArg);
  if (!appId.success || extra.length) throw new Error("Provide a valid GitHub App ID.");
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
  if (action === "verify") {
    const target = installationTarget.safeParse({
      appId: appId.data,
      installationId: secondArg,
      repositoryId: thirdArg,
    });
    if (!target.success) throw new Error("Provide valid app, installation, and repository IDs.");
    const pem = keychain.getPassword();
    if (!pem) throw new Error("Import the GitHub App key on this host first.");
    const repository = await inspectGitHubInstallation(target.data, pem);
    process.stdout.write(`${JSON.stringify(repository)}\n`);
    return;
  }
  throw new Error("Use github-app key-import <app-id> <pem-file>, key-delete <app-id>, or verify <app-id> <installation-id> <repository-id>.");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Could not verify the GitHub App installation."}\n`);
  process.exitCode = 1;
});
