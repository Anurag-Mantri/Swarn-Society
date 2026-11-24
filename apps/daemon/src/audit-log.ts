import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Task } from "@swarmroom/protocol";

const auditEventSchema = z.object({
  t: z.enum(["task.started", "task.succeeded", "task.failed"]),
  at: z.string().datetime(),
  agent: z.string().trim().min(1).max(100),
  requesterId: z.string().trim().min(1).max(100),
  channelId: z.string().trim().min(1).max(100),
}).strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type TaskAuditState = Extract<AuditEvent["t"], "task.started" | "task.succeeded" | "task.failed">;

export interface AuditLogger {
  recordTask(task: Task, state: TaskAuditState): Promise<void>;
}

function defaultAuditPath(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Swarmroom", "audit.jsonl");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Swarmroom", "audit.jsonl");
  }
  const stateHome = process.env.XDG_STATE_HOME;
  const stateRoot = stateHome && stateHome.startsWith("/") ? stateHome : join(homedir(), ".local", "state");
  return join(stateRoot, "swarmroom", "audit.jsonl");
}

export class LocalAuditLog implements AuditLogger {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly path = defaultAuditPath()) {}

  recordTask(task: Task, state: TaskAuditState): Promise<void> {
    const parsed = auditEventSchema.parse({
      t: state,
      at: new Date().toISOString(),
      agent: task.agent,
      requesterId: task.from,
      channelId: task.channelId,
    });
    this.pending = this.pending.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const file = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow, 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
      } finally {
        await file.close();
      }
    });
    return this.pending;
  }
}
