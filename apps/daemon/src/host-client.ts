import { hostClientFrameSchema, hostServerFrameSchema, threadedHostProtocolVersion, type HostServerFrame, type Task, type TaskBidRequest, type TaskBidResponse } from "@swarmroom/protocol";
import WebSocket from "ws";
import type { DaemonConfig } from "./config.js";
import { SandboxRunner } from "./sandbox/runner.js";
import { SandboxExecutionError, type SandboxTokenUsage } from "./sandbox/runner.js";
import { AdapterTransport, type AdapterReporter } from "./extensions/transport.js";
import { buildBidTask, parseBidDraft } from "./tasks/bid-draft.js";
import type { VoiceTokenIssuer } from "./voice/issuer.js";
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
    private readonly voiceIssuer?: VoiceTokenIssuer,
    private readonly autoBidAgents: string[] = [],
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
          version: threadedHostProtocolVersion, voice: this.voiceIssuer ? true : undefined,
          bidAgents: this.autoBidAgents.length ? this.autoBidAgents : undefined,
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
        if (frame.t === "voice.token.request") {
          const grant = this.voiceIssuer?.(frame) ?? Promise.resolve(null);
          void grant.catch(() => null).then((result) => {
            this.send({ t: "voice.token.response", requestId: frame.requestId, grant: result }, socket);
          });
          return;
        }
        if (frame.t === "task.bid.request") void this.handleBidRequest(frame, socket);
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

  private async runAudited(task: Task, signal: AbortSignal, recordUsage: (usage: SandboxTokenUsage) => void) {
    const { threadId: _threadId, ...executionTask } = task;
    await this.audit.recordTask(task, "task.started");
    try {
      const result = await this.runner.run(executionTask, signal);
      recordUsage(result.usage);
      await this.audit.recordTask(task, "task.succeeded");
      return result;
    } catch (error) {
      if (error instanceof SandboxExecutionError) recordUsage(error.usage);
      try {
        await this.audit.recordTask(task, "task.failed");
      } catch {
        // Do not expose local audit storage errors to other users.
      }
      throw error;
    }
  }

  private reportUsage(task: Task, usage: SandboxTokenUsage | undefined, socket: WebSocket) {
    if (!usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0)) return;
    this.send({
      t: "agent.usage", channelId: task.channelId, agent: task.agent, requesterId: task.from,
      tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
    }, socket);
  }

  private async handleTask(task: Task, socket: WebSocket): Promise<void> {
    const controller = new AbortController();
    this.activeTasks.add(controller);
    let text: string;
    let usage: SandboxTokenUsage | undefined;
    try {
      const result = await this.runAudited(task, controller.signal, (recorded) => { usage = recorded; });
      text = result.text;
    } catch (error: unknown) {
      text = error instanceof SandboxExecutionError && error.budgetExceeded
        ? "This task would exceed a token limit on the host. Ask the agent owner to raise the limit or try a shorter task."
        : "Task could not be completed in the host sandbox.";
    } finally {
      this.activeTasks.delete(controller);
    }
    this.reportUsage(task, usage, socket);
    this.send({ t: "reply", channelId: task.channelId, threadId: task.threadId, agent: task.agent, text }, socket);
  }

  private async handleBidRequest(request: TaskBidRequest, socket: WebSocket) {
    let result: TaskBidResponse["result"] = { status: "unavailable" };
    if (this.autoBidAgents.includes(request.agent)) {
      const controller = new AbortController();
      this.activeTasks.add(controller);
      let task: Task | undefined;
      let usage: SandboxTokenUsage | undefined;
      try {
        task = buildBidTask(request);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(48_000)]);
        const response = await this.runAudited(task, signal, (recorded) => { usage = recorded; });
        const draft = parseBidDraft(response.text);
        result = draft ? { status: "proposed", draft } : { status: "declined" };
      } catch {
        // The task board receives an unavailable result for sandbox or validation errors.
      } finally {
        this.activeTasks.delete(controller);
      }
      if (task) this.reportUsage(task, usage, socket);
    }
    this.send({ t: "task.bid.response", requestId: request.requestId, result }, socket);
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
