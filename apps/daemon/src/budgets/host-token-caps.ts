import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { BudgetExceededError } from "../budget-ledger.js";
import { daemonStatePath } from "../state-paths.js";

const dayMs = 24 * 60 * 60 * 1000;

export type HostTokenPolicy = { taskTokens: number; dayTokens: number };
export type HostTokenReservation = (tokens: number) => Promise<void>;

export class HostTokenCaps {
  constructor(
    private readonly policies: ReadonlyMap<string, HostTokenPolicy>,
    private readonly path = daemonStatePath("host-token-caps.sqlite"),
    private readonly now = Date.now,
  ) {}

  forTask(agent: string): HostTokenReservation | undefined {
    if (!this.policies.size) return undefined;
    const taskId = randomUUID();
    return (tokens) => this.reserve(agent, taskId, tokens);
  }

  private async reserve(agent: string, taskId: string, tokens: number) {
    const policy = this.policies.get(agent);
    if (!policy || !Number.isSafeInteger(tokens) || tokens <= 0 || tokens > policy.taskTokens) {
      throw new BudgetExceededError("Host token cap exceeded.");
    }

    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = await open(this.path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Host token cap ledger is not a regular file.");
      await file.chmod(0o600);
    } finally {
      await file.close();
    }

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(this.path);
    try {
      database.exec(`
        PRAGMA busy_timeout = 500;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS reservations (
          agent TEXT NOT NULL,
          task_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          tokens INTEGER NOT NULL CHECK (tokens > 0)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS reservations_agent_time ON reservations(agent, at);
        CREATE INDEX IF NOT EXISTS reservations_time ON reservations(at);
        BEGIN IMMEDIATE;
      `);
      try {
        const now = this.now();
        database.prepare("DELETE FROM reservations WHERE at <= ?").run(now - dayMs);
        const totals = database.prepare(`
          SELECT coalesce(sum(tokens), 0) AS agent_total,
                 coalesce(sum(tokens) FILTER (WHERE task_id = ?), 0) AS task_total
          FROM reservations WHERE agent = ?
        `).get(taskId, agent);
        if (typeof totals?.agent_total !== "number" || typeof totals.task_total !== "number") {
          throw new Error("Could not read host token caps.");
        }
        if (totals.agent_total + tokens > policy.dayTokens || totals.task_total + tokens > policy.taskTokens) {
          throw new BudgetExceededError("Host token cap exceeded.");
        }
        database.prepare("INSERT INTO reservations (agent, task_id, at, tokens) VALUES (?, ?, ?, ?)")
          .run(agent, taskId, now, tokens);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }
}
