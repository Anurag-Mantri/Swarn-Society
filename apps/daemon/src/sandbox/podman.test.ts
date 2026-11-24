import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "../config.js";
import { createPodmanSandboxBackend, type PodmanSpawnFunction } from "./podman.js";
import type { ProviderEgressBroker } from "../provider-broker.js";

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

function fakeBroker(socketPath: string, close = vi.fn(async () => undefined)): ProviderEgressBroker {
  return { openForTask: async () => ({
    socketPath,
    budgetExceeded: () => false,
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    close,
  }) };
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
    const brokerDirectory = await workspace();
    const brokerSocket = join(brokerDirectory, "provider.sock");
    const closeBroker = vi.fn(async () => undefined);
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
    const backend = await createPodmanSandboxBackend(config, fakeBroker(brokerSocket, closeBroker), launch);
    const task = { t: "task" as const, channelId: "c1", from: "u1", agent: "scout", text: "$(touch /tmp/unsafe)" };
    await expect(backend.run(task, new AbortController().signal)).resolves.toEqual({
      text: "sandbox response",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("podman");
    expect(calls[1]?.args).toEqual(expect.arrayContaining([
      "--network=none", "--read-only", "--cap-drop=ALL", "--pids-limit=64", "--memory=512m",
      "--cpus=1", "--timeout=120", `--mount=type=bind,src=${cwd},dst=/workspace,rw`, image,
      `--mount=type=bind,src=${brokerSocket},dst=/run/swarmroom/provider.sock,rw`,
      "--env=SWARMROOM_PROVIDER_SOCKET=/run/swarmroom/provider.sock",
      "/usr/local/bin/swarmroom-agent",
    ]));
    expect(calls[1]?.args.join(" ")).not.toContain("touch");
    expect(calls[1]?.options.env).not.toHaveProperty("SWARMROOM_TEST_PROVIDER_SECRET");
    expect(calls[1]?.options.shell).toBe(false);
    expect(closeBroker).toHaveBeenCalledOnce();
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0] ?? "null")).toEqual(task);
  });

  it.each(["cancelled", "output limit exceeded"])("removes the task container when %s", async (failure) => {
    const cwd = await workspace();
    const controller = new AbortController();
    const closeBroker = vi.fn(async () => undefined);
    const calls: string[][] = [];
    let clientExited = false;
    const launch: PodmanSpawnFunction = (_command, args) => {
      calls.push(args);
      const child = fakeChild();
      if (args[0] === "run") {
        child.kill.mockImplementation(() => {
          queueMicrotask(() => {
            clientExited = true;
            child.emit("exit", null, "SIGKILL");
          });
          return true;
        });
        queueMicrotask(() => {
          if (failure === "cancelled") controller.abort();
          else child.stdout.write(Buffer.alloc(32_001));
        });
      } else {
        queueMicrotask(() => {
          if (args[0] === "info") {
            child.stdout.end(JSON.stringify({ host: { security: { rootless: true }, serviceIsRemote: false } }));
          }
          child.emit("close", 0);
        });
      }
      if (args[0] === "rm") {
        expect(clientExited).toBe(true);
        expect(closeBroker).not.toHaveBeenCalled();
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    };

    const backend = await createPodmanSandboxBackend(
      { image, workspaces: new Map([["scout", cwd]]) },
      fakeBroker("/tmp/provider.sock", closeBroker),
      launch,
    );
    await expect(backend.run({
      t: "task", channelId: "c1", from: "u1", agent: "scout", text: "hello",
    }, controller.signal)).rejects.toThrow("Sandbox execution failed.");

    const name = calls[1]?.find((arg) => arg.startsWith("--name="))?.slice("--name=".length);
    expect(name).toMatch(/^swarmroom-task-/);
    expect(calls[2]).toEqual(["rm", "--force", "--ignore", "--time", "0", name]);
    expect(closeBroker).toHaveBeenCalledOnce();
  });

  it("surfaces a broker budget denial as a host budget error", async () => {
    const cwd = await workspace();
    const broker: ProviderEgressBroker = {
      openForTask: async () => ({
        socketPath: "/tmp/provider.sock",
        budgetExceeded: () => true,
        usage: () => ({ inputTokens: 15, outputTokens: 7 }),
        close: async () => undefined,
      }),
    };
    const launch: PodmanSpawnFunction = (_command, args) => {
      const child = fakeChild();
      queueMicrotask(() => {
        if (args[0] === "info") child.stdout.end(JSON.stringify({
          host: { security: { rootless: true }, serviceIsRemote: false },
        }));
      else child.stdout.end("fabricated answer after budget denial");
      child.emit("close", 0);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const backend = await createPodmanSandboxBackend({ image, workspaces: new Map([["scout", cwd]]) }, broker, launch);
    await expect(backend.run({
      t: "task", channelId: "channel", from: "requester", agent: "scout", text: "hello",
    }, new AbortController().signal)).rejects.toMatchObject({ budgetExceeded: true, usage: { inputTokens: 15, outputTokens: 7 } });
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
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", cwd]]) }, fakeBroker(cwd), launch))
      .rejects.toThrow("local rootless Podman");
  });

  it("refuses to mount the user's home directory or a parent of it", async () => {
    const launch: PodmanSpawnFunction = () => {
      throw new Error("Podman should not be launched for an unsafe workspace.");
    };
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", homedir()]]) }, fakeBroker("/tmp/broker.sock"), launch))
      .rejects.toThrow("cannot be the home directory");
    await expect(createPodmanSandboxBackend({ image, workspaces: new Map([["scout", "/"]]) }, fakeBroker("/tmp/broker.sock"), launch))
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
    }, fakeBroker("/tmp/broker.sock"), launch)).rejects.toThrow("cannot overlap");
  });
});
