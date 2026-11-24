import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "../config.js";
import { createPodmanSandboxBackend, type PodmanSpawnFunction } from "./podman.js";

const image = `registry.example/swarmroom-agent@sha256:${"a".repeat(64)}`;
const workspaces: string[] = [];
type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "swarmroom-sandbox-test-"));
  workspaces.push(path);
  return path;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rootless Podman sandbox", () => {
  it("passes task JSON through stdin with fixed, isolated container arguments", async () => {
    vi.stubEnv("SWARMROOM_TEST_PROVIDER_SECRET", "must-not-reach-runtime");
    const cwd = await workspace();
    const calls: Array<{ command: string; args: string[]; options: SpawnOptions; child: FakeChild }> = [];
    const inputs: string[] = [];
    const launch: PodmanSpawnFunction = (command, args, options) => {
      const child = fakeChild();
      calls.push({ command, args, options, child });
      if (args[0] === "info") {
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ host: { security: { rootless: true }, serviceIsRemote: false } }));
          child.emit("close", 0);
        });
      } else {
        child.stdin.on("data", (chunk: Buffer) => inputs.push(chunk.toString("utf8")));
        queueMicrotask(() => {
          child.stdout.end("sandbox response");
          child.emit("close", 0);
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const config: SandboxConfig = { image, workspaces: new Map([["scout", cwd]]) };
    const backend = await createPodmanSandboxBackend(config, launch);
    const task = { t: "task" as const, channelId: "c1", from: "u1", agent: "scout", text: "$(touch /tmp/unsafe)" };
    await expect(backend.run(task, new AbortController().signal)).resolves.toBe("sandbox response");

    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("podman");
    expect(calls[1]?.args).toEqual(expect.arrayContaining([
      "--network=none", "--read-only", "--cap-drop=ALL", "--pids-limit=64", "--memory=512m",
      "--cpus=1", `--mount=type=bind,src=${cwd},dst=/workspace,rw`, image,
      "/usr/local/bin/swarmroom-agent",
    ]));
    expect(calls[1]?.args.join(" ")).not.toContain("touch");
    expect(calls[1]?.options.env).not.toHaveProperty("SWARMROOM_TEST_PROVIDER_SECRET");
    expect(calls[1]?.options.shell).toBe(false);
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0] ?? "null")).toEqual(task);
  });

  it("rejects rootful or remote Podman runtimes", async () => {
    const cwd = await workspace();
    const launch: PodmanSpawnFunction = () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ host: { security: { rootless: false }, serviceIsRemote: false } }));
        child.emit("close", 0);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", cwd]]) }, launch))
      .rejects.toThrow("local rootless Podman");
  });

  it("refuses to mount the user's home directory or a parent of it", async () => {
    const launch: PodmanSpawnFunction = () => {
      throw new Error("Podman should not be launched for an unsafe workspace.");
    };
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", homedir()]]) }, launch))
      .rejects.toThrow("cannot be the home directory");
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", "/"]]) }, launch))
      .rejects.toThrow("cannot be the home directory");
  });

  it("prevents one agent workspace from exposing another agent's directory", async () => {
    const parent = await workspace();
    const childWorkspace = join(parent, "nested");
    await mkdir(childWorkspace);
    const launch: PodmanSpawnFunction = () => {
      throw new Error("Podman should not be launched for overlapping workspaces.");
    };
    await expect(createPodmanSandboxBackend({
      image,
      workspaces: new Map([["scout", parent], ["reviewer", childWorkspace]]),
    }, launch)).rejects.toThrow("cannot overlap");
  });
});
