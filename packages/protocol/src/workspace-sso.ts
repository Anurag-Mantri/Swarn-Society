import { z } from "zod";

export const workspaceSsoIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
