import { loadDaemonConfig } from "../config.js";
import { createVoiceKeychain } from "./keychain.js";

try {
  const [action, ...extra] = process.argv.slice(2);
  if ((action !== "set" && action !== "delete") || extra.length) throw new Error("Invalid action");
  const { controlPlaneUrl } = loadDaemonConfig(process.env);
  const keychain = await createVoiceKeychain(controlPlaneUrl.host);
  if (action === "delete") {
    keychain.delete();
    process.stdout.write("Voice signing credential removed from the OS keychain.\n");
  } else {
    if (process.stdin.isTTY) throw new Error("Credential input must use a pipe");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const data of process.stdin) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      bytes += chunk.length;
      if (bytes > 2048) throw new Error("Input is too large");
      chunks.push(chunk);
    }
    keychain.store(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write("Voice signing credential saved in the OS keychain.\n");
  }
} catch {
  process.stderr.write("Pipe credential JSON to voice:key set, or voice:key delete. Check the daemon configuration and OS keychain.\n");
  process.exitCode = 1;
}
