import { z } from "zod";

const common = {
  model: z.string().trim().min(1).max(200),
  stream: z.literal(false),
};
const maxTokens = z.number().int().positive();
const textMessage = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.string(),
}).strict();
const responsesContent = z.object({ type: z.literal("input_text"), text: z.string() }).strict();
const responsesMessage = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.array(responsesContent).min(1).max(8),
}).strict();
const anthropicMessage = z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict();

const cappedModels: Record<string, z.ZodType<unknown>> = {
  "/openai/responses": z.object({
    ...common, max_output_tokens: maxTokens,
    input: z.union([z.string(), z.array(responsesMessage).min(1).max(8)]),
    store: z.literal(false).optional(),
  }).strict(),
  "/openai/chat/completions": z.object({
    ...common, max_completion_tokens: maxTokens, messages: z.array(textMessage).min(1).max(8),
  }).strict(),
  "/anthropic/messages": z.object({
    ...common, max_tokens: maxTokens, system: z.string().optional(), messages: z.array(anthropicMessage).min(1).max(8),
  }).strict(),
};

export function isCappedProviderInput(route: string, input: unknown): boolean {
  return cappedModels[route]?.safeParse(input).success === true;
}
