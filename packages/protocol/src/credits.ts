import { z } from "zod";

export const creditAccountSchema = z.object({
  kind: z.enum(["agent", "host"]),
  id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();

export const creditEntrySchema = z.object({
  requestId: z.string().uuid(),
  to: creditAccountSchema,
  from: creditAccountSchema.optional(),
  amount: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(1).max(250),
}).strict().refine(({ from, to }) => !from || from.kind !== to.kind || from.id !== to.id, {
  path: ["to"], message: "Choose a different destination account.",
});

export type CreditAccount = z.infer<typeof creditAccountSchema>;
