import { z } from "zod";

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const sessionId = uuid;
const resourceId = uuid;
const byteLength = z.number().int().nonnegative().max(32 * 1024 * 1024);

export const adapterRegisterSchema = z.object({
  t: z.literal("adapter.register"),
  adapterId: uuid,
  manifestId: uuid,
  protocolVersion: z.literal(1),
}).strict();

export const adapterStartSchema = z.object({
  t: z.literal("adapter.session.start"),
  adapterId: uuid,
  sessionId,
  channelId: uuid,
}).strict();

export const adapterResourceSchema = z.object({
  t: z.literal("adapter.resource"),
  sessionId,
  resourceId,
  resourceType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  extension: z.string().regex(/^\.[a-z0-9]{1,12}$/),
  byteLength,
}).strict();

export const adapterSnapshotSchema = z.object({
  t: z.literal("adapter.snapshot"),
  sessionId,
  resourceId,
  snapshotId: uuid,
  format: z.enum(["metadata-json", "file-copy"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength,
}).strict();

export const adapterStopSchema = z.object({
  t: z.literal("adapter.session.stop"),
  sessionId,
}).strict();

export const adapterAckSchema = z.object({
  t: z.literal("adapter.ack"),
  action: z.enum(["register", "session.start", "resource", "snapshot", "session.stop"]),
  id: uuid,
}).strict();

export const adapterFrames = [
  adapterRegisterSchema,
  adapterStartSchema,
  adapterResourceSchema,
  adapterSnapshotSchema,
  adapterStopSchema,
] as const;

export const adapterFrameSchema = z.discriminatedUnion("t", adapterFrames);
export type AdapterFrame = z.infer<typeof adapterFrameSchema>;
