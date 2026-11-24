import type { Task } from "@swarmroom/protocol";

export interface SandboxBackend {
  run(task: Task, signal: AbortSignal): Promise<string>;
}

export class SandboxRunner {
  constructor(private readonly backend?: SandboxBackend) {}

  async run(task: Task, signal: AbortSignal): Promise<string> {
    if (!this.backend) throw new Error("Sandbox backend is unavailable; task was not executed.");
    return this.backend.run(task, signal);
  }
}
