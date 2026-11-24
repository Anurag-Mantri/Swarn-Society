import { createSystemHostTokenKeychain } from "./keychain.js";

async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Run the token command in an interactive terminal so the token can be entered without echo.");
  }
  process.stderr.write("Host token (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          restore();
          process.stderr.write("\nToken entry cancelled.\n");
          reject(new Error("Token entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          restore();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const server = process.env.SWARMROOM_CONTROL_PLANE_URL;
  if (!server) throw new Error("Set SWARMROOM_CONTROL_PLANE_URL before managing the host token.");
  const account = new URL(server).host;
  const keychain = await createSystemHostTokenKeychain(account);
  if (action === "set") {
    keychain.store(await readSecret());
    process.stdout.write("Host token saved in the OS keychain.\n");
  } else if (action === "delete") {
    keychain.delete();
    process.stdout.write("Host token removed from the OS keychain.\n");
  } else {
    throw new Error("Use `pnpm --filter @swarmroom/daemon token set` or `token delete`.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown token management error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
