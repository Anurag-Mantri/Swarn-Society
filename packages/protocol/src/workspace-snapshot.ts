import { z } from "zod";
import { workspacePathSchema } from "./workspace-path.js";

export const maximumSnapshotBytes = 4 * 1024 * 1024;
export const maximumSnapshotFiles = 200;

const secretName = /^(?:\.env(?:rc$|\.|$)|id_(?:rsa|ed25519|ecdsa|dsa)(?:$|\.)|\.npmrc$|\.netrc$)|\.(?:pem|key|pfx|p12)$/i;
const secretValue = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/;

export const workspaceSnapshotSchema = z.object({
  serverId: z.string().uuid(),
  files: z.array(z.object({
    path: workspacePathSchema,
    content: z.string().max(maximumSnapshotBytes),
  }).strict()).min(1).max(maximumSnapshotFiles),
}).strict().superRefine(({ files }, context) => {
  const paths = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [index, file] of files.entries()) {
    bytes += encoder.encode(file.content).byteLength;
    const path = file.path.toLowerCase();
    if (paths.has(path) || path.split("/").some((segment) => secretName.test(segment)) ||
        (path === ".github" || path === ".github/workflows" || path.startsWith(".github/workflows/")) || secretValue.test(file.content)) {
      context.addIssue({ code: "custom", path: ["files", index], message: "A file is duplicated or matches a blocked snapshot pattern." });
    }
    paths.add(path);
  }
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length) {
      if (paths.has(segments.join("/"))) {
        context.addIssue({ code: "custom", path: ["files"], message: "A path cannot be both a file and a folder." });
        break;
      }
      segments.pop();
    }
  }
  if (bytes > maximumSnapshotBytes) {
    context.addIssue({ code: "custom", path: ["files"], message: "The snapshot exceeds the total size limit." });
  }
});

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export function workspaceSnapshotBranch(serverId: string): string {
  return `swarmroom/${z.string().uuid().parse(serverId).toLowerCase()}-live`;
}
