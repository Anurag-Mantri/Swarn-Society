#!/usr/bin/env node
import { runAgentRuntime } from "./agent-runtime.js";

try {
  await runAgentRuntime();
} catch {
  process.stderr.write("Agent task failed. Check the runtime config and host provider broker.\n");
  process.exitCode = 1;
}
