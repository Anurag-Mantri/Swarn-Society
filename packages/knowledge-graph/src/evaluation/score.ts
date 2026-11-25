import { z } from "zod";
import { extractKnowledge, knowledgeEventSchema } from "../index.js";

const node = z.string().min(3).max(256).regex(/^[a-z]+:.+$/);
const edge = z.tuple([node, z.string().max(64).regex(/^[a-z_]+$/), node]);
const labeledEvent = z.object({
  event: knowledgeEventSchema,
  nodes: z.array(node).max(500),
  edges: z.array(edge).max(500),
}).strict().superRefine(({ nodes, edges }, context) => {
  const expected = new Set(nodes);
  if (expected.size !== nodes.length || new Set(edges.map((edge) => JSON.stringify(edge))).size !== edges.length) {
    context.addIssue({ code: "custom", message: "Each fact must be labeled once per source." });
  }
  if (edges.some(([from, , to]) => !expected.has(from) || !expected.has(to))) {
    context.addIssue({ code: "custom", message: "Every edge endpoint must have a node label." });
  }
});

const dataset = z.array(labeledEvent).min(1).max(10_000);

type Counts = { truePositive: number; falsePositive: number; falseNegative: number };
type LabelSet = { actual: Iterable<string>; expected: Iterable<string> };

function countMatches(counts: Counts, { actual, expected }: LabelSet) {
  const predictions = new Set(actual);
  const labels = new Set(expected);
  for (const fact of predictions) {
    if (labels.has(fact)) counts.truePositive += 1;
    else counts.falsePositive += 1;
  }
  for (const fact of labels) {
    if (!predictions.has(fact)) counts.falseNegative += 1;
  }
}

function rates(counts: Counts) {
  const { truePositive, falsePositive, falseNegative } = counts;
  const predicted = truePositive + falsePositive;
  const labeled = truePositive + falseNegative;
  return {
    ...counts,
    precision: predicted ? truePositive / predicted : null,
    recall: labeled ? truePositive / labeled : null,
  };
}

export function evaluateKnowledge(input: unknown) {
  const cases = dataset.parse(input);
  const nodes: Counts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  const edges: Counts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  const sources = new Set<string>();
  for (const sample of cases) {
    const facts = extractKnowledge(sample.event);
    if (sources.has(facts.source.id)) throw new Error("The dataset labels the same source more than once.");
    sources.add(facts.source.id);
    const actualNodes = new Map(facts.nodes.map(({ id, kind, key }) => [id, `${kind}:${key}`]));
    countMatches(nodes, { actual: actualNodes.values(), expected: sample.nodes });
    const actualEdges = facts.edges.filter(({ confidence, method }) => method === "deterministic" && confidence >= 90).map(({ fromId, relation, toId }) =>
      JSON.stringify([actualNodes.get(fromId), relation, actualNodes.get(toId)]));
    countMatches(edges, { actual: actualEdges, expected: sample.edges.map((edge) => JSON.stringify(edge)) });
  }
  return { sources: cases.length, nodes: rates(nodes), automaticEdges: rates(edges) };
}
