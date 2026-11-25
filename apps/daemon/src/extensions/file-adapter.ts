import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { workspacePathSchema } from "@swarmroom/protocol";
import { z } from "zod";
import type { AdapterReporter } from "./transport.js";

const maxBytes = 32 * 1024 * 1024;
const fileConfigSchema = z.object({
  adapterId: z.string().uuid().transform((value) => value.toLowerCase()),
  manifestId: z.string().uuid().transform((value) => value.toLowerCase()),
  channelId: z.string().uuid().transform((value) => value.toLowerCase()),
  root: z.string().min(1).refine(isAbsolute),
  file: workspacePathSchema,
  resourceType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
}).strict();

export type FileAdapterConfig = z.infer<typeof fileConfigSchema>;

export function loadFileAdapterConfig(value: string | undefined): FileAdapterConfig | undefined {
  if (value === undefined) return undefined;
  try {
    return fileConfigSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new Error("Configure SWARMROOM_FILE_ADAPTER with the approved adapter IDs, root, and file.");
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function createFileAdapter(config: FileAdapterConfig): AdapterReporter {
  const extension = extname(config.file).toLowerCase();
  if (!/^\.[a-z0-9]{1,12}$/.test(extension)) throw new Error("The file adapter needs a declared file extension.");

  return async (exchange, signal) => {
    if (process.platform !== "linux") throw new Error("The file adapter requires Linux.");
    const sessionId = randomUUID();
    const resourceId = randomUUID();
    const snapshotId = randomUUID();
    await exchange({
      t: "adapter.register", adapterId: config.adapterId, manifestId: config.manifestId, protocolVersion: 1,
    }, { action: "register", id: config.adapterId });
    signal.throwIfAborted();
    await exchange({
      t: "adapter.session.start", adapterId: config.adapterId, sessionId, channelId: config.channelId,
    }, { action: "session.start", id: sessionId });

    try {
      signal.throwIfAborted();
      const root = await realpath(config.root);
      const home = await realpath(homedir());
      if (root === home || inside(root, home) || !(await stat(root)).isDirectory()) {
        throw new Error("Choose a specific adapter root below the host's home or in another workspace directory.");
      }
      const selected = await realpath(resolve(root, config.file));
      if (!inside(root, selected)) throw new Error("The adapter file is outside its approved root.");

      const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const openedPath = await realpath(`/proc/self/fd/${file.fd}`);
        if (!inside(root, openedPath)) throw new Error("The opened adapter file is outside its approved root.");
        const before = await file.stat();
        if (!before.isFile() || before.size > maxBytes) throw new Error("Choose a regular file within the adapter size limit.");
        await exchange({
          t: "adapter.resource", sessionId, resourceId, resourceType: config.resourceType,
          extension, byteLength: before.size,
        }, { action: "resource", id: resourceId });

        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let byteLength = 0;
        while (true) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          byteLength += bytesRead;
          if (byteLength > maxBytes) throw new Error("The file grew beyond the adapter size limit.");
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (byteLength !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error("The file changed during the snapshot.");
        }
        signal.throwIfAborted();
        await exchange({
          t: "adapter.snapshot", sessionId, resourceId, snapshotId, format: "metadata-json",
          sha256: hash.digest("hex"), byteLength,
        }, { action: "snapshot", id: snapshotId });
      } finally {
        await file.close();
      }
    } finally {
      if (!signal.aborted) {
        await exchange({ t: "adapter.session.stop", sessionId }, { action: "session.stop", id: sessionId }).catch(() => undefined);
      }
    }
  };
}
