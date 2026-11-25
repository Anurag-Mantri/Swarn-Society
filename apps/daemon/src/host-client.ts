import { hostClientFrameSchema, hostServerFrameSchema, threadedHostProtocolVersion, type HostServerFrame, type Task } from "@swarmroom/protocol";
import WebSocket from "ws";
import type { DaemonConfig } from "./config.js";
import { SandboxRunner } from "./sandbox/runner.js";
import { SandboxExecutionError } from "./sandbox/runner.js";
import { AdapterTransport, type AdapterReporter } from "./extensions/transport.js";
import type { AuditLogger } from "./audit-log.js";

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class HostClient {
  private stopped = false;
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectWait: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | undefined;
  private readonly activeTasks = new Set<AbortController>();

  constructor(
    private readonly config: DaemonConfig,
    private readonly token: string,
    private readonly runner: SandboxRunner,
    private readonly audit: AuditLogger,
    private readonly adapter?: AdapterReporter,
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
    this.abortActiveTasks();
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
      let adapterStarted = false;
      const adapterTransport = this.adapter ? new AdapterTransport((frame) => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        this.send(frame, socket);
        return true;
      }) : undefined;
      let finished = false;
      const finish = (reconnect: boolean) => {
        if (finished) return;
        finished = true;
        this.abortActiveTasks();
        adapterTransport?.close();
        if (this.heartbeat) clearInterval(this.heartbeat);
        resolve(reconnect);
      };

      socket.on("open", () => {
        const frame = hostClientFrameSchema.parse({
          t: "host", token: this.token, machine: this.config.machine, agents: this.config.agents,
          version: threadedHostProtocolVersion,
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
          if (!adapterStarted && this.adapter && adapterTransport) {
            adapterStarted = true;
            const controller = new AbortController();
            this.activeTasks.add(controller);
            void this.adapter(adapterTransport.exchange, controller.signal).catch(() => {
              if (!controller.signal.aborted) process.stderr.write("File adapter report could not be completed.\n");
            }).finally(() => this.activeTasks.delete(controller));
          }
          return;
        }
        if (frame.t === "adapter.ack" || (frame.t === "error" && frame.code.startsWith("adapter_"))) {
          adapterTransport?.receive(frame);
          return;
        }
        if (frame.t === "error") {
          socket.close(1008, "host authorization failed");
          finish(false);
          return;
        }
        if (frame.t === "task") void this.handleTask(frame, socket);
      });
      socket.on("error", () => finish(true));
      socket.on("close", (code) => finish(code !== 1008 && !this.stopped));
      socket.on("unexpected-response", (_request, response) => {
        // Authentication failures are terminal until the token is rotated or repaired.
        finish(response.statusCode === 401 || response.statusCode === 403 ? false : true);
      });
    });
  }

  private async handleTask(task: Task, socket: WebSocket): Promise<void> {
    // The daemon keeps reply routing metadata so older sandbox images can still run tasks.
    const { threadId, ...executionTask } = task;
    const controller = new AbortController();
    this.activeTasks.add(controller);
    let text: string;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let started = false;
    try {
      await this.audit.recordTask(task, "task.started");
      started = true;
      const result = await this.runner.run(executionTask, controller.signal);
      text = result.text;
      usage = result.usage;
      await this.audit.recordTask(task, "task.succeeded");
    } catch (error: unknown) {
      if (error instanceof SandboxExecutionError) usage = error.usage;
      if (started) {
        try {
          await this.audit.recordTask(task, "task.failed");
        } catch {
          // Do not expose local audit storage errors to other users.
        }
      }
      text = error instanceof SandboxExecutionError && error.budgetExceeded
        ? "This task would exceed a token limit on the host. Ask the agent owner to raise the limit or try a shorter task."
        : "Task could not be completed in the host sandbox.";
    } finally {
      this.activeTasks.delete(controller);
    }
    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      this.send({
        t: "agent.usage",
        channelId: task.channelId,
        agent: task.agent,
        requesterId: task.from,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
      }, socket);
    }
    this.send({ t: "reply", channelId: task.channelId, threadId, agent: task.agent, text }, socket);
  }

  private abortActiveTasks(): void {
    for (const controller of this.activeTasks) controller.abort();
  }

  private send(frame: unknown, socket = this.socket): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const validated = hostClientFrameSchema.parse(frame);
    socket.send(JSON.stringify(validated));
  }
}
