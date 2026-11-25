import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateKnowledge } from "./score.js";

const data = JSON.parse(readFileSync(new URL("../../evaluation/structured.json", import.meta.url), "utf8")) as Array<{
  event: unknown;
  nodes: string[];
  edges: [string, string, string][];
}>;

describe("labeled structured knowledge evaluation", () => {
  it("preserves expected relationships and endpoints for every supported event type", () => {
    expect(evaluateKnowledge(data)).toEqual({
      sources: 11,
      nodes: { truePositive: 44, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1 },
      automaticEdges: { truePositive: 33, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1 },
    });
  });

  it("counts mismatches against labels in both directions", () => {
    const source = data[0]!;
    const [from, , to] = source.edges[0]!;
    const result = evaluateKnowledge([{
      ...source, edges: [[from, "authored", to], ...source.edges.slice(1)],
    }]);
    expect(result.automaticEdges).toEqual({
      truePositive: 3, falsePositive: 1, falseNegative: 1, precision: 0.75, recall: 0.75,
    });
  });

  it("rejects duplicate sources and relationships with missing endpoint labels", () => {
    const source = data[0]!;
    expect(() => evaluateKnowledge([source, source])).toThrow("same source");
    expect(() => evaluateKnowledge([{ ...source, nodes: [] }])).toThrow("endpoint");
  });
});
