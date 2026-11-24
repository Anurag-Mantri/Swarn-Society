import { describe, expect, it, vi } from "vitest";
import { runAgentTask, type AgentRuntimeConfig, type ProviderInvoker } from "./agent-runtime.js";

const task = {
  t: "task" as const,
  channelId: "general",
  from: "human-1",
  agent: "scout",
  text: "Summarize this issue.",
};

const baseConfig: AgentRuntimeConfig = {
  agent: "scout",
  provider: "openai-chat",
  model: "test-model",
  systemPrompt: "Be concise.",
  maxOutputTokens: 700,
};

describe("TypeScript agent runtime", () => {
  it("builds a bounded chat request and returns only model text", async () => {
    const invoke = vi.fn<ProviderInvoker>(async (_route, body) => {
      expect(body).toEqual({
        model: "test-model",
        max_completion_tokens: 700,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Channel: general\nRequester: human-1\nTask:\nSummarize this issue." },
        ],
      });
      return { choices: [{ message: { content: "Summary." } }] };
    });
    const reply = await runAgentTask(task, baseConfig, invoke);
    expect(reply).toBe("Summary.");
    expect(invoke).toHaveBeenCalledWith("/openai/chat/completions", expect.any(Object));
  });

  it("supports OpenAI Responses and Anthropic text blocks", async () => {
    const invoke = vi.fn<ProviderInvoker>(async (route) => route === "/openai/responses"
      ? { output: [{ content: [{ type: "output_text", text: "Responses reply." }] }] }
      : { content: [{ type: "text", text: "Anthropic reply." }] });
    await expect(runAgentTask(task, { ...baseConfig, provider: "openai-responses" }, invoke))
      .resolves.toBe("Responses reply.");
    await expect(runAgentTask(task, { ...baseConfig, provider: "anthropic" }, invoke))
      .resolves.toBe("Anthropic reply.");
    expect(invoke.mock.calls.map(([route]) => route)).toEqual([
      "/openai/responses",
      "/anthropic/messages",
    ]);
  });

  it("rejects mismatched agents, invalid tasks, and malformed model output", async () => {
    await expect(runAgentTask(task, { ...baseConfig, agent: "other" }, vi.fn()))
      .rejects.toThrow("Task agent does not match");
    await expect(runAgentTask({ ...task, text: "" }, baseConfig, vi.fn()))
      .rejects.toThrow();
    await expect(runAgentTask(task, baseConfig, vi.fn(async () => ({ choices: [] }))))
      .rejects.toThrow("Model response did not contain a chat reply");
  });
});
