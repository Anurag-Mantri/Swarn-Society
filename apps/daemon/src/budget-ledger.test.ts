import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "@swarmroom/protocol";
import { LocalBudgetLedger } from "./budget-ledger.js";

const policy = { ownerId: "owner", taskTokens: 250, hourTokens: 250, dayTokens: 500 };
const task = (from = "requester"): Task => ({
  t: "task", channelId: "general", from, agent: "scout", text: "hello",
});

describe("local requester token budgets", () => {
  it("persists actual usage and enforces hourly and daily limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-budget-test-"));
    const path = join(directory, "state", "budget-usage.jsonl");
    try {
      const ledger = new LocalBudgetLedger(new Map([["scout", policy]]), path);
      await ledger.forTask(task()).runRequest(100, async () => ({ value: "ok", actualTokens: 50 }));
      await ledger.forTask(task()).runRequest(200, async () => ({ value: "ok", actualTokens: 100 }));
      await expect(ledger.forTask(task()).runRequest(101, async () => ({ value: "should not run" })))
        .rejects.toThrow("Requester token budget exceeded");
      const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tokens: number });
      expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(150);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces one task total across multiple provider calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-budget-task-test-"));
    try {
      const ledger = new LocalBudgetLedger(new Map([["scout", { ...policy, taskTokens: 100 }]]), join(directory, "usage.jsonl"));
      const session = ledger.forTask(task());
      await session.runRequest(60, async () => ({ value: undefined, actualTokens: 60 }));
      await expect(session.runRequest(41, async () => ({ value: undefined, actualTokens: 41 })))
        .rejects.toThrow("Requester token budget exceeded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces rolling day limits and expires old records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-budget-window-test-"));
    const path = join(directory, "usage.jsonl");
    let clock = Date.now();
    try {
      const ledger = new LocalBudgetLedger(new Map([[
        "scout", { ownerId: "owner", taskTokens: 200, hourTokens: 120, dayTokens: 120 },
      ]]), path, () => clock);
      await ledger.forTask(task()).runRequest(100, async () => ({ value: "ok", actualTokens: 40 }));
      clock += 60 * 60 * 1000 + 1;
      await expect(ledger.forTask(task()).runRequest(100, async () => ({ value: "blocked" })))
        .rejects.toThrow("Requester token budget exceeded");
      clock += 23 * 60 * 60 * 1000 + 1;
      await expect(ledger.forTask(task()).runRequest(100, async () => ({ value: "ok", actualTokens: 40 })))
        .resolves.toBe("ok");
      const rows = (await readFile(path, "utf8")).trim().split("\n");
      expect(rows).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exempts the owner and charges the full reservation after an interrupted provider call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-budget-owner-test-"));
    const path = join(directory, "usage.jsonl");
    try {
      const ledger = new LocalBudgetLedger(new Map([["scout", { ...policy, taskTokens: 50, hourTokens: 50, dayTokens: 50 }]]), path);
      await expect(ledger.forTask(task("owner")).runRequest(5_000, async () => ({ value: "owner" })))
        .resolves.toBe("owner");
      await expect(ledger.forTask(task()).runRequest(40, async () => { throw new Error("upstream timed out"); }))
        .rejects.toThrow("upstream timed out");
      await expect(ledger.forTask(task()).runRequest(20, async () => ({ value: "must not run" })))
        .rejects.toThrow("Requester token budget exceeded");
      const contents = await readFile(path, "utf8");
      expect(contents).not.toContain('"requesterId":"owner"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupt persisted usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-budget-corrupt-test-"));
    const path = join(directory, "usage.jsonl");
    try {
      await writeFile(path, "not-json\n");
      await expect(new LocalBudgetLedger(new Map([["scout", policy]]), path)
        .forTask(task()).runRequest(10, async () => ({ value: "must not run" })))
        .rejects.toThrow("ledger is corrupt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
