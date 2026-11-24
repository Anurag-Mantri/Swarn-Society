import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Task } from "@swarmroom/protocol";

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 250_000;
const usageEventSchema = z.object({
  eventId: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: z.enum(["reserve", "settle"]),
  at: z.string().datetime(),
  agent: z.string().trim().min(1).max(100),
  requesterId: z.string().trim().min(1).max(100),
  tokens: z.number().int().min(-10_000_000).max(10_000_000),
}).strict().superRefine((event, context) => {
  if (event.kind === "reserve" && event.tokens < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Reservation tokens must be positive." });
  }
});

export interface AgentBudgetPolicy {
  ownerId: string;
  taskTokens: number;
  hourTokens: number;
  dayTokens: number;
}

export interface ProviderBudgetSession {
  runRequest<T>(reservedTokens: number, action: () => Promise<{ value: T; actualTokens?: number }>): Promise<T>;
}

export class BudgetExceededError extends Error {
  constructor() {
    super("Requester token budget exceeded.");
  }
}

function defaultBudgetPath(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Swarmroom", "budget-usage.jsonl");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Swarmroom", "budget-usage.jsonl");
  }
  const stateHome = process.env.XDG_STATE_HOME;
  const stateRoot = stateHome && stateHome.startsWith("/") ? stateHome : join(homedir(), ".local", "state");
  return join(stateRoot, "swarmroom", "budget-usage.jsonl");
}

function emptySession(): ProviderBudgetSession {
  return { runRequest: async (_reservedTokens, action) => (await action()).value };
}

export class LocalBudgetLedger {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly policies: ReadonlyMap<string, AgentBudgetPolicy>,
    private readonly path = defaultBudgetPath(),
    private readonly now: () => number = Date.now,
  ) {}

  forTask(task: Task): ProviderBudgetSession {
    const policy = this.policies.get(task.agent);
    if (!policy || task.from === policy.ownerId) return emptySession();
    const taskId = randomUUID();
    return {
      runRequest: async <T>(reservedTokens: number, action: () => Promise<{ value: T; actualTokens?: number }>) =>
        this.runRequest(task, taskId, policy, reservedTokens, action),
    };
  }

  private async runRequest<T>(
    task: Task,
    taskId: string,
    policy: AgentBudgetPolicy,
    reservedTokens: number,
    action: () => Promise<{ value: T; actualTokens?: number }>,
  ): Promise<T> {
    const release = await this.acquire();
    try {
      if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1 || reservedTokens > policy.taskTokens) {
        throw new BudgetExceededError();
      }
      const events = await this.readEvents();
      const now = this.now();
      const taskUsed = events.filter((event) => event.taskId === taskId)
        .reduce((total, event) => total + event.tokens, 0);
      const hourUsed = events.filter((event) => event.agent === task.agent && event.requesterId === task.from &&
        Date.parse(event.at) > now - 60 * 60 * 1000).reduce((total, event) => total + event.tokens, 0);
      const dayUsed = events.filter((event) => event.agent === task.agent && event.requesterId === task.from &&
        Date.parse(event.at) > now - 24 * 60 * 60 * 1000).reduce((total, event) => total + event.tokens, 0);
      if (taskUsed + reservedTokens > policy.taskTokens ||
          hourUsed + reservedTokens > policy.hourTokens || dayUsed + reservedTokens > policy.dayTokens) {
        throw new BudgetExceededError();
      }

      const eventId = randomUUID();
      await this.appendEvent({
        eventId, taskId, kind: "reserve", at: new Date(now).toISOString(),
        agent: task.agent, requesterId: task.from, tokens: reservedTokens,
      });

      let result: { value: T; actualTokens?: number };
      try {
        result = await action();
      } catch (error) {
        // If the provider call failed after sending, keep the full reservation charged.
        throw error;
      }
      const actualTokens = result.actualTokens;
      if (actualTokens !== undefined && Number.isSafeInteger(actualTokens) && actualTokens >= 0 && actualTokens !== reservedTokens) {
        await this.appendEvent({
          eventId, taskId, kind: "settle", at: new Date(this.now()).toISOString(),
          agent: task.agent, requesterId: task.from, tokens: actualTokens - reservedTokens,
        });
      }
      return result.value;
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }

  private async readEvents(): Promise<Array<z.infer<typeof usageEventSchema>>> {
    let text: string;
    try {
      const file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_LEDGER_BYTES) {
          throw new Error("Local token budget ledger is invalid or exceeds its size limit.");
        }
        await file.chmod(0o600);
        text = await file.readFile({ encoding: "utf8" });
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissingFile(error)) return [];
      if (error instanceof Error && error.message.includes("token budget ledger")) throw error;
      throw new Error("Cannot read the local token budget ledger.");
    }
    try {
      const lines = text.split("\n").filter(Boolean);
      if (lines.length > MAX_EVENTS) throw new Error("Local token budget ledger has too many records.");
      const events = lines.map((line) => usageEventSchema.parse(JSON.parse(line) as unknown));
      validateEventPairs(events);
      const cutoff = this.now() - 24 * 60 * 60 * 1000;
      const active = events.filter((event) => Date.parse(event.at) > cutoff);
      if (active.length !== events.length) await this.replaceEvents(active);
      return active;
    } catch {
      throw new Error("Local token budget ledger is corrupt or unreadable.");
    }
  }

  private async appendEvent(value: z.input<typeof usageEventSchema>): Promise<void> {
    const event = usageEventSchema.parse(value);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const file = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow, 0o600);
    try {
      const metadata = await file.stat();
      if (metadata.size + Buffer.byteLength(JSON.stringify(event)) + 1 > MAX_LEDGER_BYTES) {
        throw new Error("Local token budget ledger reached its size limit.");
      }
      await file.chmod(0o600);
      await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    } finally {
      await file.close();
    }
  }

  private async replaceEvents(events: Array<z.infer<typeof usageEventSchema>>): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const file = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
    } catch (error) {
      await file.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await file.close();
    await chmod(directory, 0o700);
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validateEventPairs(events: Array<z.infer<typeof usageEventSchema>>): void {
  const reservations = new Map<string, z.infer<typeof usageEventSchema>>();
  const settled = new Set<string>();
  for (const event of events) {
    if (event.kind === "reserve") {
      if (reservations.has(event.eventId)) throw new Error("Duplicate budget reservation.");
      reservations.set(event.eventId, event);
      continue;
    }
    const reservation = reservations.get(event.eventId);
    if (!reservation || settled.has(event.eventId) || reservation.taskId !== event.taskId ||
        reservation.agent !== event.agent || reservation.requesterId !== event.requesterId ||
        reservation.tokens + event.tokens < 0) {
      throw new Error("Invalid budget settlement.");
    }
    settled.add(event.eventId);
  }
}
