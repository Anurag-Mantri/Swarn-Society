import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@swarmroom/protocol";
import { LocalAuditLog } from "./audit-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local audit log", () => {
  it("stores task lifecycle metadata without message or credential contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarmroom-audit-test-"));
    directories.push(directory);
    const path = join(directory, "nested", "audit.jsonl");
    const log = new LocalAuditLog(path);
    const task: Task = {
      t: "task", channelId: "channel-1", from: "user-1", agent: "scout",
      text: "sensitive prompt that must not appear in the audit log",
    };

    await log.recordTask(task, "task.started");
    await log.recordTask(task, "task.succeeded");

    const contents = await readFile(path, "utf8");
    const records = contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ t: "task.started", agent: "scout", requesterId: "user-1", channelId: "channel-1" });
    expect(records[1]?.t).toBe("task.succeeded");
    expect(records[1]?.taskId).toBe(records[0]?.taskId);
    expect(contents).not.toContain(task.text);
    expect(Object.keys(records[0] ?? {})).not.toContain("text");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
