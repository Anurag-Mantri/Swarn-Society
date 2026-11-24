import { homedir, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { Task } from "@swarmroom/protocol";
import type { SandboxConfig } from "../config.js";
import { SandboxExecutionError, type SandboxBackend, type SandboxResult } from "./runner.js";
import type { ProviderEgressBroker, ProviderBrokerLease } from "../provider-broker.js";

const CONTAINER_COMMAND = ["/usr/local/bin/swarmroom-agent"] as const;
const MAX_WALL_TIME_MS = 120_000;
const MAX_OUTPUT_BYTES = 32_000;
const MAX_INFO_BYTES = 256_000;
const PODMAN_COMMAND_TIMEOUT_MS = 5_000;
const RUN_OPTIONS = [
  "run", "--rm", "--interactive", "--pull=never", "--network=none", "--read-only",
  "--read-only-tmpfs=false", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--pids-limit=64", "--memory=512m", "--cpus=1", "--ulimit=nofile=1024:1024",
  "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m", "--userns=keep-id",
  "--log-driver=none", "--workdir=/workspace",
  `--timeout=${MAX_WALL_TIME_MS / 1_000}`,
] as const;

export type PodmanSpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

function childEnvironment(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
  };
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (value) safe[key] = value;
  }
  return safe;
}

function spawnOptions(): SpawnOptions {
  return { env: childEnvironment(), shell: false, windowsHide: true, stdio: "pipe" };
}

function collectProcessOutput(
  child: ChildProcessWithoutNullStreams,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let exited = false;
    let stopError: Error | undefined;
    const abort = () => stop(new Error("Sandbox task was cancelled."));
    const finish = (error: Error | undefined, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) rejectOutput(error);
      else resolveOutput(output ?? Buffer.alloc(0));
    };
    const timeout = setTimeout(() => {
      stop(new Error("Sandbox process timed out."));
    }, timeoutMs);
    function stop(error: Error): void {
      if (stopError) return;
      stopError = error;
      if (exited) finish(error);
      else child.kill("SIGKILL");
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stopError) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        stop(new Error("Sandbox process output exceeded its limit."));
        return;
      }
      chunks.push(buffer);
    });
    child.stderr.on("data", () => undefined);
    child.once("error", () => finish(new Error("Sandbox process could not be started.")));
    child.once("exit", () => {
      exited = true;
      if (stopError) finish(stopError);
    });
    child.once("close", (code) => {
      if (stopError) {
        finish(stopError);
        return;
      }
      if (code !== 0) {
        finish(new Error("Sandbox process failed."));
        return;
      }
      finish(undefined, Buffer.concat(chunks));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function assertRootlessPodmanInfo(infoText: string): void {
  let info: unknown;
  try {
    info = JSON.parse(infoText) as unknown;
  } catch {
    throw new Error("Podman returned invalid runtime information.");
  }
  if (typeof info !== "object" || info === null || !("host" in info) ||
      typeof info.host !== "object" || info.host === null || !("security" in info.host) ||
      typeof info.host.security !== "object" || info.host.security === null ||
      !("rootless" in info.host.security) || info.host.security.rootless !== true ||
      !("serviceIsRemote" in info.host) || info.host.serviceIsRemote !== false) {
    throw new Error("Sandbox requires a local rootless Podman runtime.");
  }
}

function buildRunArguments(image: string, workspace: string, brokerSocketPath: string, name: string): string[] {
  if (!isAbsolute(workspace) || /[,\r\n]/.test(workspace) ||
      !isAbsolute(brokerSocketPath) || /[,\r\n]/.test(brokerSocketPath)) {
    throw new Error("Sandbox workspace path is invalid.");
  }
  const { uid, gid } = userInfo();
  return [
    ...RUN_OPTIONS,
    `--name=${name}`,
    `--user=${uid}:${gid}`,
    `--mount=type=bind,src=${workspace},dst=/workspace,rw`,
    `--mount=type=bind,src=${brokerSocketPath},dst=/run/swarmroom/provider.sock,rw`,
    "--env=SWARMROOM_PROVIDER_SOCKET=/run/swarmroom/provider.sock",
    image,
    ...CONTAINER_COMMAND,
  ];
}

async function resolveWorkspaces(config: SandboxConfig): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const home = await realpath(homedir());
  for (const [agent, workspace] of config.workspaces) {
    if (!isAbsolute(workspace) || /[,\r\n]/.test(workspace)) {
      throw new Error(`Workspace configured for ${agent} must be an absolute path without commas or line breaks.`);
    }
    const path = await realpath(resolve(workspace));
    const details = await stat(path);
    if (!details.isDirectory()) throw new Error(`Workspace configured for ${agent} is not a directory.`);
    const homeRelative = relative(home, path);
    const workspaceRelative = relative(path, home);
    const homeIsInsideWorkspace = workspaceRelative !== "" &&
      !workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative);
    if (!homeRelative || homeIsInsideWorkspace) {
      throw new Error(`Workspace configured for ${agent} cannot be the home directory or contain it.`);
    }
    resolved.set(agent, path);
  }
  const entries = [...resolved.entries()];
  for (let index = 0; index < entries.length; index += 1) {
    const [agent, path] = entries[index]!;
    for (const [otherAgent, otherPath] of entries.slice(index + 1)) {
      const otherWithinPath = relative(path, otherPath);
      const pathWithinOther = relative(otherPath, path);
      const overlaps = (candidate: string) => candidate === "" ||
        (!candidate.startsWith("..") && !isAbsolute(candidate));
      if (overlaps(otherWithinPath) || overlaps(pathWithinOther)) {
        throw new Error(`Agent workspaces for ${agent} and ${otherAgent} cannot overlap.`);
      }
    }
  }
  return resolved;
}

class PodmanSandboxBackend implements SandboxBackend {
  private busy = false;

  constructor(
    private readonly image: string,
    private readonly workspaces: Map<string, string>,
    private readonly broker: ProviderEgressBroker,
    private readonly launch: PodmanSpawnFunction,
  ) {}

  async run(task: Task, signal: AbortSignal): Promise<SandboxResult> {
    if (signal.aborted) throw new Error("Sandbox task was cancelled.");
    if (this.busy) throw new Error("Sandbox is busy.");
    const workspace = this.workspaces.get(task.agent);
    if (!workspace) throw new Error("No workspace is configured for this agent.");
    this.busy = true;
    try {
      const brokerLease = await this.broker.openForTask(task);
      try {
        if (signal.aborted) throw new Error("Sandbox task was cancelled.");
        const name = `swarmroom-task-${randomUUID()}`;
        const args = buildRunArguments(this.image, workspace, brokerLease.socketPath, name);
        const child = this.launch("podman", args, spawnOptions());
        try {
          child.stdin.on("error", () => undefined);
          child.stdin.end(JSON.stringify(task));
          let output: Buffer;
          try {
            output = await collectProcessOutput(child, MAX_OUTPUT_BYTES, MAX_WALL_TIME_MS, signal);
            if (signal.aborted) throw new Error("Sandbox task was cancelled.");
          } catch (error) {
            // Killing the Podman client can leave its container running under conmon.
            await this.removeContainer(name);
            throw error;
          }
          if (brokerLease.budgetExceeded()) {
            throw new SandboxExecutionError("Requester token budget exceeded.", brokerLease.usage(), true);
          }
          const text = output.toString("utf8").trim();
          if (!text) throw new Error("Sandbox returned an empty response.");
          return { text: text.slice(0, 8_000), usage: brokerLease.usage() };
        } catch (error) {
          if (error instanceof SandboxExecutionError) throw error;
          throw new SandboxExecutionError("Sandbox execution failed.", brokerLease.usage(), brokerLease.budgetExceeded());
        }
      } finally {
        await brokerLease.close();
      }
    } finally {
      this.busy = false;
    }
  }

  private async removeContainer(name: string): Promise<void> {
    const child = this.launch("podman", ["rm", "--force", "--ignore", "--time", "0", name], spawnOptions());
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    await collectProcessOutput(child, MAX_INFO_BYTES, PODMAN_COMMAND_TIMEOUT_MS);
  }
}

export async function createPodmanSandboxBackend(
  config: SandboxConfig,
  broker: ProviderEgressBroker,
  launch: PodmanSpawnFunction = (command, args, options) =>
    nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams,
): Promise<SandboxBackend> {
  if (process.platform !== "linux") {
    throw new Error("The rootless Podman sandbox backend is currently supported on Linux only.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(config.image)) {
    throw new Error("Sandbox image must be pinned by SHA-256 digest.");
  }
  const workspaces = await resolveWorkspaces(config);
  const infoChild = launch("podman", ["info", "--format", "json"], spawnOptions());
  infoChild.stdin.on("error", () => undefined);
  infoChild.stdin.end();
  const info = await collectProcessOutput(infoChild, MAX_INFO_BYTES, PODMAN_COMMAND_TIMEOUT_MS);
  assertRootlessPodmanInfo(info.toString("utf8"));
  return new PodmanSandboxBackend(config.image, workspaces, broker, launch);
}

export const podmanSandboxLimits = {
  wallTimeMs: MAX_WALL_TIME_MS,
  outputBytes: MAX_OUTPUT_BYTES,
} as const;
