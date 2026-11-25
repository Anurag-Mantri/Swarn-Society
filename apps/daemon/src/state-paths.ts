import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function daemonStatePath(filename: string): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Swarmroom", filename);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Swarmroom", filename);
  }
  const stateHome = process.env.XDG_STATE_HOME;
  const stateRoot = stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local", "state");
  return join(stateRoot, "swarmroom", filename);
}
