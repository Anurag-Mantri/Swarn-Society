import { z } from "zod";
import { pool } from "../db/index.js";
import { rebuildKnowledgeGraph } from "./rebuild.js";

try {
  const args = process.argv.slice(2);
  const workspaceId = z.string().uuid().safeParse(args[0]);
  if (!workspaceId.success || args.length !== 1) throw new Error("usage");
  const result = await rebuildKnowledgeGraph(workspaceId.data);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write("Could not rebuild knowledge. Supply one workspace UUID and check the server database.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
