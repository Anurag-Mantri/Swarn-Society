import { z } from "zod";

export const extensionCapability = z.enum(["resource.read", "resource.write", "snapshot.create"]);
export type ExtensionCapability = z.infer<typeof extensionCapability>;

const capabilities = z.array(extensionCapability).min(1).max(3)
  .refine((values) => new Set(values).size === values.length, "List each capability once.");
const resourceType = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,12}$/)).min(1).max(12),
}).strict();

export const extensionManifestSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/),
  protocolVersion: z.literal(1),
  operatingSystems: z.array(z.enum(["linux", "darwin", "win32"])).min(1).max(3)
    .refine((values) => new Set(values).size === values.length, "List each operating system once."),
  capabilities,
  resources: z.array(resourceType).min(1).max(16)
    .refine((values) => new Set(values.map(({ type }) => type)).size === values.length, "List each resource type once."),
  snapshotFormat: z.enum(["metadata-json", "file-copy"]).optional(),
}).strict().superRefine(({ capabilities: requested, snapshotFormat }, context) => {
  if (requested.includes("snapshot.create") !== (snapshotFormat !== undefined)) {
    context.addIssue({ code: "custom", path: ["snapshotFormat"], message: "Specify a snapshot format when requesting snapshots." });
  }
});

export const extensionApprovalSchema = z.object({ capabilities }).strict();
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
