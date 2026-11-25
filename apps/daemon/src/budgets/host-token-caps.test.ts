import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostTokenCaps } from "./host-token-caps.js";

const policies = new Map([
  ["scout", { taskTokens: 100, dayTokens: 150 }],
  ["reviewer", { taskTokens: 100, dayTokens: 150 }],
]);

describe("persistent host token caps", () => {
  it("enforces task and agent limits over multiple ledger instances and rolls the day window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-host-token-test-"));
    const path = join(directory, "caps.sqlite");
    let now = Date.now();
    const ledger = () => new HostTokenCaps(policies, path, () => now);
    try {
      const runningTask = ledger().forTask("scout")!;
      await runningTask(60);
      await expect(runningTask(41)).rejects.toThrow("Host token cap exceeded");
      await runningTask(40);
      const concurrent = await Promise.allSettled([ledger().forTask("scout")!(50), ledger().forTask("scout")!(50)]);
      expect(concurrent.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      await expect(ledger().forTask("scout")!(1)).rejects.toThrow("Host token cap exceeded");
      await expect(ledger().forTask("reviewer")!(100)).resolves.toBeUndefined();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      now += 24 * 60 * 60 * 1000;
      await expect(ledger().forTask("scout")!(100)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on an invalid ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-host-token-corrupt-"));
    const path = join(directory, "caps.sqlite");
    try {
      await writeFile(path, "invalid database");
      await expect(new HostTokenCaps(policies, path).forTask("scout")!(10)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
