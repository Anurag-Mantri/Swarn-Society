import { z } from "zod";

export const workspacePathSchema = z.string().trim().min(1).max(240).refine((path) => {
  return path.split("/").every((segment) =>
    /^[A-Za-z0-9_.-]+$/.test(segment) && ![".", "..", ".git"].includes(segment.toLowerCase()),
  );
}, "Use a repository-relative path with letters, numbers, dots, underscores, or hyphens.");

export const createWorkspaceFileSchema = z.object({ path: workspacePathSchema }).strict();
