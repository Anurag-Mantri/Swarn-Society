import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { DaemonConfig } from "./config.js";
import { HostClient } from "./host-client.js";
import { SandboxRunner } from "./sandbox/runner.js";

describe("host client", () => {
  it("authenticates, sends tasks to the sandbox runner, and returns replies", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
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
              t: "task", channelId: "channel-1", from: "user-1", agent: "scout", text: "inspect this",
            }));
          } else if (typeof frame === "object" && frame !== null && "t" in frame && frame.t === "reply") {
            clearTimeout(timeout);
            resolve(frame);
          }
        });
      });
    });

    const run = vi.fn(async () => "sandbox result");
    const config: DaemonConfig = {
      controlPlaneUrl: new URL(`ws://127.0.0.1:${address.port}/ws`),
      machine: "test machine",
      agents: ["scout"],
    };
    const client = new HostClient(config, "host-token", new SandboxRunner({ run }));
    const started = client.start();

    try {
      await expect(reply).resolves.toEqual({
        t: "reply", channelId: "channel-1", agent: "scout", text: "sandbox result",
      });
      expect(hostFrames[0]).toMatchObject({ t: "host", token: "host-token", machine: "test machine", agents: ["scout"] });
      expect(run).toHaveBeenCalledWith(
        { t: "task", channelId: "channel-1", from: "user-1", agent: "scout", text: "inspect this" },
        expect.any(AbortSignal),
      );
    } finally {
      client.stop();
      await started;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
