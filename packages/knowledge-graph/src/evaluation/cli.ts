import { readFile, stat } from "node:fs/promises";
import { evaluateKnowledge } from "./score.js";

try {
  const [path, ...extra] = process.argv.slice(2);
  const input = path ?? new URL("../../evaluation/structured.json", import.meta.url);
  const metadata = await stat(input);
  if (extra.length || !metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
    throw new Error("Invalid dataset file");
  }
  const result = evaluateKnowledge(JSON.parse(await readFile(input, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.automaticEdges.precision === null || result.automaticEdges.precision < 0.9) {
    process.stderr.write("Automatic edge precision is undefined or below 90%.\n");
    process.exitCode = 1;
  }
} catch {
  process.stderr.write("Could not evaluate knowledge extraction. Provide a valid labeled JSON dataset up to 8 MB.\n");
  process.exitCode = 1;
}
