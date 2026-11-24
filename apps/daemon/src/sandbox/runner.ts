import type { Task } from "@swarmroom/protocol";

export interface SandboxTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SandboxResult {
  text: string;
  usage: SandboxTokenUsage;
}

export class SandboxExecutionError extends Error {
  constructor(
    message: string,
    readonly usage: SandboxTokenUsage,
    readonly budgetExceeded = false,
  ) {
    super(message);
  }
}

export interface SandboxBackend {
  run(task: Task, signal: AbortSignal): Promise<SandboxResult>;
}

export class SandboxRunner {
  constructor(private readonly backend?: SandboxBackend) {}

  async run(task: Task, signal: AbortSignal): Promise<SandboxResult> {
    if (!this.backend) throw new Error("Sandbox backend is unavailable; task was not executed.");
    return this.backend.run(task, signal);
  }
}
