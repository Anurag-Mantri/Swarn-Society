import { describe, expect, it } from "vitest";
import { extractKnowledge } from "./index.js";

const fixture = (suffix: string) => `00000000-0000-4000-8000-00000000000${suffix}`;
const scope = {
  sourceId: "task-claim:1",
  serverId: fixture("1"),
  channelId: fixture("2"),
  occurredAt: "2026-11-24T10:00:00-05:00",
};
const assigned = {
  ...scope,
  type: "task.assigned",
  taskId: fixture("3"),
  agentId: fixture("4"),
  assignedBy: fixture("5"),
};

describe("deterministic knowledge extraction", () => {
  it("uses stable scoped IDs and keeps provenance for task relationships", () => {
    const first = extractKnowledge(assigned);
    expect(extractKnowledge({ ...assigned, occurredAt: "2026-11-24T15:00:00Z" })).toEqual(first);
    expect(first.source).toMatchObject({
      serverId: scope.serverId, channelId: scope.channelId,
      sourceId: scope.sourceId, occurredAt: "2026-11-24T15:00:00.000Z", method: "structured-v1",
    });
    const task = first.nodes.find(({ kind }) => kind === "task");
    const agent = first.nodes.find(({ kind }) => kind === "agent");
    expect(first.edges).toContainEqual(expect.objectContaining({
      fromId: task?.id, toId: agent?.id, relation: "assigned_to", confidence: 100,
    }));
    expect(first.nodes.every((node) => node.serverId === scope.serverId)).toBe(true);
  });

  it("creates separate facts for the same input IDs from two workspaces", () => {
    const first = extractKnowledge(assigned);
    const other = extractKnowledge({ ...assigned, serverId: fixture("6") });
    expect(other.source.id).not.toBe(first.source.id);
    expect(other.nodes.every(({ id }) => !first.nodes.some((node) => node.id === id))).toBe(true);
    expect(other.edges.every(({ id }) => !first.edges.some((edge) => edge.id === id))).toBe(true);
  });

  it("uses recorded mentions and rejects raw message content", () => {
    const input = {
      ...scope, type: "message.posted", messageId: fixture("7"),
      author: { kind: "person", id: fixture("5") },
      mentionedAgentIds: [fixture("4"), fixture("4"), fixture("8")],
    };
    const result = extractKnowledge(input);
    expect(result.edges.filter(({ relation }) => relation === "mentioned_in")).toHaveLength(2);
    expect(extractKnowledge({ ...input, mentionedAgentIds: [...input.mentionedAgentIds].reverse() })).toEqual(result);
    expect(() => extractKnowledge({ ...input, body: "untrusted channel text" })).toThrow();
  });

  it("connects commit files by ID and retains the server visibility scope", () => {
    const graph = extractKnowledge({
      sourceId: "commit:1", serverId: scope.serverId, occurredAt: scope.occurredAt,
      type: "commit.recorded", repositoryId: "15", commitSha: "A".repeat(40),
      actor: { kind: "agent", id: fixture("4") },
      fileIds: [fixture("3"), fixture("3")],
    });
    expect(graph.source.channelId).toBeNull();
    expect(graph.nodes).toContainEqual(expect.objectContaining({ kind: "event", key: `commit:15:${"a".repeat(40)}` }));
    expect(graph.edges.filter(({ relation }) => relation === "changed")).toHaveLength(1);
  });
});
