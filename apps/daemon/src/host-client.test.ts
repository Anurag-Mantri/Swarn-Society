import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { DaemonConfig } from "./config.js";
import { HostClient } from "./host-client.js";
import { SandboxExecutionError, SandboxRunner } from "./sandbox/runner.js";
import { LocalAuditLog } from "./audit-log.js";

describe("host client", () => {
  it("authenticates, sends tasks to the sandbox runner, and returns replies", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const auditDirectory = await mkdtemp(join(tmpdir(), "swarmroom-host-test-"));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");

    const hostFrames: unknown[] = [];
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for host reply.")), 5_000);
      server.once("connection", (socket) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as unknown;
          hostFrames.push(frame);
          if (typeof frame === "object" && frame !== null && "t" in frame && frame.t === "host") {
            socket.send(JSON.stringify({ t: "host.registered", hostId: "host-1" }));
            socket.send(JSON.stringify({
              t: "task", channelId: "channel-1", from: "00000000-0000-4000-8000-000000000001", agent: "scout", text: "inspect this",
            }));
          } else if (typeof frame === "object" && frame !== null && "t" in frame && frame.t === "reply") {
            clearTimeout(timeout);
            resolve(frame);
          }
        });
      });
    });

    const run = vi.fn(async () => ({ text: "sandbox result", usage: { inputTokens: 123, outputTokens: 45 } }));
    const config: DaemonConfig = {
      controlPlaneUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
      machine: "test machine",
      agents: ["scout"],
    };
    const client = new HostClient(
      config,
      "host-token",
      new SandboxRunner({ run }),
      new LocalAuditLog(join(auditDirectory, "audit.jsonl")),
    );
    const started = client.start();

    try {
      await expect(reply).resolves.toEqual({
        t: "reply", channelId: "channel-1", agent: "scout", text: "sandbox result",
      });
      expect(hostFrames[0]).toMatchObject({ t: "host", token: "host-token", machine: "test machine", agents: ["scout"] });
      expect(run).toHaveBeenCalledWith(
        { t: "task", channelId: "channel-1", from: "00000000-0000-4000-8000-000000000001", agent: "scout", text: "inspect this" },
        expect.any(AbortSignal),
      );
      const audit = await readFile(join(auditDirectory, "audit.jsonl"), "utf8");
      expect(audit).toContain('"t":"task.started"');
      expect(audit).toContain('"t":"task.succeeded"');
      expect(audit).not.toContain("inspect this");
      expect(hostFrames).toContainEqual({
        t: "agent.usage",
        channelId: "channel-1",
        agent: "scout",
        requesterId: "00000000-0000-4000-8000-000000000001",
        tokensIn: 123,
        tokensOut: 45,
      });
    } finally {
      client.stop();
      await started;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(auditDirectory, { recursive: true, force: true });
    }
  });

  it("does not execute a task when the audit start record cannot be written", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");

    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for failure reply.")), 5_000);
      server.once("connection", (socket) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as unknown;
          if (typeof frame !== "object" || frame === null || !("t" in frame)) return;
          if (frame.t === "host") {
            socket.send(JSON.stringify({ t: "host.registered", hostId: "host-1" }));
            socket.send(JSON.stringify({
              t: "task", channelId: "channel-1", from: "user-1", agent: "scout", text: "do not execute",
            }));
          } else if (frame.t === "reply") {
            clearTimeout(timeout);
            resolve(frame);
          }
        });
      });
    });
    const run = vi.fn(async () => ({ text: "must not run", usage: { inputTokens: 0, outputTokens: 0 } }));
    const audit = { recordTask: vi.fn(async () => { throw new Error("audit store unavailable"); }) };
    const config: DaemonConfig = {
      controlPlaneUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
      machine: "test machine",
      agents: ["scout"],
    };
    const client = new HostClient(config, "host-token", new SandboxRunner({ run }), audit);
    const started = client.start();

    try {
      await expect(reply).resolves.toMatchObject({
        t: "reply", channelId: "channel-1", agent: "scout",
        text: "Task could not be completed in the host sandbox.",
      });
      expect(audit.recordTask).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    } finally {
      client.stop();
      await started;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("tells requesters when the host budget blocks their task", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for budget reply.")), 5_000);
      server.once("connection", (socket) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as unknown;
          if (typeof frame !== "object" || frame === null || !("t" in frame)) return;
          if (frame.t === "host") {
            socket.send(JSON.stringify({ t: "host.registered", hostId: "host-1" }));
            socket.send(JSON.stringify({
              t: "task", channelId: "channel-1", from: "user-1", agent: "scout", text: "run this",
            }));
          } else if (frame.t === "reply") {
            clearTimeout(timeout);
            resolve(frame);
          }
        });
      });
    });
    const run = vi.fn(async () => {
      throw new SandboxExecutionError("budget exceeded", { inputTokens: 0, outputTokens: 0 }, true);
    });
    const config: DaemonConfig = {
      controlPlaneUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
      machine: "test machine",
      agents: ["scout"],
    };
    const client = new HostClient(config, "host-token", new SandboxRunner({ run }), {
      recordTask: async () => undefined,
    });
    const started = client.start();
    try {
      await expect(reply).resolves.toMatchObject({
        t: "reply",
        text: "This task would exceed your token budget. Ask the agent owner to raise the limit or try a shorter task.",
      });
    } finally {
      client.stop();
      await started;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts sandbox work when its authenticated socket closes", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    let serverSocket: WebSocket | undefined;
    let signalStarted: ((signal: AbortSignal) => void) | undefined;
    const runnerStarted = new Promise<AbortSignal>((resolve) => { signalStarted = resolve; });
    const run = vi.fn((_task: unknown, signal: AbortSignal) => new Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>((_resolve, reject) => {
      signalStarted?.(signal);
      signal.addEventListener("abort", () => reject(new Error("sandbox stopped")), { once: true });
    }));
    server.once("connection", (socket) => {
      serverSocket = socket;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as unknown;
        if (typeof frame === "object" && frame !== null && "t" in frame && frame.t === "host") {
          socket.send(JSON.stringify({ t: "host.registered", hostId: "host-1" }));
          socket.send(JSON.stringify({
            t: "task", channelId: "channel-1", from: "user-1", agent: "scout", text: "running task",
          }));
        }
      });
    });

    const config: DaemonConfig = {
      controlPlaneUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
      machine: "test machine",
      agents: ["scout"],
    };
    const client = new HostClient(config, "host-token", new SandboxRunner({ run }), {
      recordTask: async () => undefined,
    });
    const started = client.start();
    try {
      const signal = await runnerStarted;
      serverSocket?.close(4000, "test disconnect");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(signal.aborted).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      client.stop();
      await started;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
