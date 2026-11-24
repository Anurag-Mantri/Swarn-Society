import { hostClientFrameSchema, hostServerFrameSchema, type HostServerFrame, type Task } from "@swarmroom/protocol";
import WebSocket from "ws";
import type { DaemonConfig } from "./config.js";
import { SandboxRunner } from "./sandbox/runner.js";
import type { AuditLogger } from "./audit-log.js";

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class HostClient {
  private stopped = false;
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectWait: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;

  constructor(
    private readonly config: DaemonConfig,
    private readonly token: string,
    private readonly runner: SandboxRunner,
    private readonly audit: AuditLogger,
  ) {}

  async start(): Promise<void> {
    let delay = RECONNECT_MIN_MS;
    while (!this.stopped) {
      const shouldReconnect = await this.connectOnce();
      if (!shouldReconnect || this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.reconnectWait = undefined;
          resolve();
        }, delay);
        this.reconnectWait = { timer, resolve };
      });
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectWait) {
      clearTimeout(this.reconnectWait.timer);
      this.reconnectWait.resolve();
      this.reconnectWait = undefined;
    }
    this.socket?.close(1000, "daemon stopping");
  }

  private connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(this.config.controlPlaneUrl, { followRedirects: false });
      this.socket = socket;
      let finished = false;
      const finish = (reconnect: boolean) => {
        if (finished) return;
        finished = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        resolve(reconnect);
      };

      socket.on("open", () => {
        const frame = hostClientFrameSchema.parse({
          t: "host", token: this.token, machine: this.config.machine, agents: this.config.agents,
        });
        socket.send(JSON.stringify(frame));
      });
      socket.on("message", (data) => {
        let frame: HostServerFrame;
        try {
          frame = hostServerFrameSchema.parse(JSON.parse(data.toString()) as unknown);
        } catch {
          socket.close(1008, "invalid server frame");
          finish(false);
          return;
        }
        if (frame.t === "host.registered") {
          this.heartbeat = setInterval(() => this.send({ t: "host.heartbeat" }), HEARTBEAT_INTERVAL_MS);
          return;
        }
        if (frame.t === "error") {
          socket.close(1008, "host authorization failed");
          finish(false);
          return;
        }
        void this.handleTask(frame);
      });
      socket.on("error", () => finish(true));
      socket.on("close", (code) => finish(code !== 1008 && !this.stopped));
      socket.on("unexpected-response", (_request, response) => {
        // Authentication failures are terminal until the token is rotated or repaired.
        finish(response.statusCode === 401 || response.statusCode === 403 ? false : true);
      });
    });
  }

  private async handleTask(task: Task): Promise<void> {
    const controller = new AbortController();
    let text: string;
    let started = false;
    try {
      await this.audit.recordTask(task, "task.started");
      started = true;
      text = await this.runner.run(task, controller.signal);
      await this.audit.recordTask(task, "task.succeeded");
    } catch {
      if (started) {
        try {
          await this.audit.recordTask(task, "task.failed");
        } catch {
          // Do not expose local audit storage errors to other users.
        }
      }
      text = "Task could not be completed in the host sandbox.";
    }
    this.send({ t: "reply", channelId: task.channelId, agent: task.agent, text });
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const validated = hostClientFrameSchema.parse(frame);
    this.socket.send(JSON.stringify(validated));
  }
}
