import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Task } from "@swarmroom/protocol";
import { daemonStatePath } from "./state-paths.js";

const auditEventSchema = z.object({
  taskId: z.string().uuid(),
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

export class LocalAuditLog implements AuditLogger {
  private pending: Promise<void> = Promise.resolve();
  private readonly taskIds = new WeakMap<Task, string>();

  constructor(private readonly path = daemonStatePath("audit.jsonl")) {}

  recordTask(task: Task, state: TaskAuditState): Promise<void> {
    const taskId = state === "task.started" ? randomUUID() : this.taskIds.get(task) ?? randomUUID();
    if (state === "task.started") this.taskIds.set(task, taskId);
    else this.taskIds.delete(task);
    const parsed = auditEventSchema.parse({
      taskId,
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
