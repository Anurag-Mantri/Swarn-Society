import { createHash } from "node:crypto";
import { knowledgeEventSchema, type KnowledgeEvent } from "./events.js";

export { knowledgeEventSchema } from "./events.js";
export type { KnowledgeEvent } from "./events.js";

export type NodeKind = "server" | "channel" | "person" | "agent" | "host" | "task" |
  "decision" | "file" | "repository" | "event";

export type Relation = "in_server" | "in_channel" | "authored" | "mentioned_in" | "assigned_to" |
  "assigned_by" | "completed_by" | "recorded_completion" | "decided_in" | "changed" |
  "in_repository" | "hosted_by";

export type KnowledgeSource = {
  id: string;
  serverId: string;
  channelId: string | null;
  type: KnowledgeEvent["type"];
  sourceId: string;
  occurredAt: string;
  method: "structured-v1";
};

export type KnowledgeNode = {
  id: string;
  serverId: string;
  kind: NodeKind;
  key: string;
  confidence: 100;
};

export type KnowledgeEdge = {
  id: string;
  serverId: string;
  fromId: string;
  toId: string;
  relation: Relation;
  confidence: 100;
};

function stableId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function extractKnowledge(input: unknown) {
  const event = knowledgeEventSchema.parse(input);
  const { serverId } = event;
  const source: KnowledgeSource = {
    id: stableId("source", serverId, event.type, event.sourceId),
    serverId,
    channelId: "channelId" in event ? event.channelId : null,
    type: event.type,
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
    method: "structured-v1",
  };
  const nodes = new Map<string, KnowledgeNode>();
  const edges = new Map<string, KnowledgeEdge>();
  const node = (kind: NodeKind, key: string): string => {
    const id = stableId("node", serverId, kind, key);
    nodes.set(id, { id, serverId, kind, key, confidence: 100 });
    return id;
  };
  const edge = (fromId: string, toId: string, relation: Relation): void => {
    const id = stableId("edge", serverId, fromId, relation, toId);
    edges.set(id, { id, serverId, fromId, toId, relation, confidence: 100 });
  };

  const server = node("server", serverId);
  const inChannel = (id: string, channelId: string): void => {
    const channel = node("channel", channelId);
    edge(channel, server, "in_server");
    edge(id, channel, "in_channel");
  };

  switch (event.type) {
    case "message.posted": {
      const message = node("event", `message:${event.messageId}`);
      inChannel(message, event.channelId);
      if (event.author) edge(node(event.author.kind, event.author.id), message, "authored");
      for (const id of event.mentionedAgentIds) edge(node("agent", id), message, "mentioned_in");
      break;
    }
    case "task.posted": {
      const task = node("task", event.taskId);
      inChannel(task, event.channelId);
      edge(node("person", event.authorId), task, "authored");
      break;
    }
    case "task.assigned": {
      const task = node("task", event.taskId);
      inChannel(task, event.channelId);
      edge(task, node("agent", event.agentId), "assigned_to");
      edge(task, node("person", event.assignedBy), "assigned_by");
      break;
    }
    case "task.completed": {
      const task = node("task", event.taskId);
      inChannel(task, event.channelId);
      edge(task, node("agent", event.agentId), "completed_by");
      edge(node("person", event.resolvedBy), task, "recorded_completion");
      break;
    }
    case "decision.recorded": {
      const decision = node("decision", event.decisionId);
      const message = node("event", `message:${event.messageId}`);
      inChannel(decision, event.channelId);
      inChannel(message, event.channelId);
      edge(decision, message, "decided_in");
      break;
    }
    case "file.changed": {
      const file = node("file", event.fileId);
      edge(file, server, "in_server");
      edge(node(event.actor.kind, event.actor.id), file, "changed");
      break;
    }
    case "commit.recorded": {
      const commit = node("event", `commit:${event.repositoryId}:${event.commitSha}`);
      const repository = node("repository", event.repositoryId);
      edge(repository, server, "in_server");
      edge(commit, repository, "in_repository");
      edge(node(event.actor.kind, event.actor.id), commit, "authored");
      for (const id of event.fileIds) {
        const file = node("file", id);
        edge(commit, file, "changed");
        edge(file, server, "in_server");
      }
      break;
    }
    case "agent.hosted": {
      const agent = node("agent", event.agentId);
      edge(agent, server, "in_server");
      edge(agent, node("host", event.hostId), "hosted_by");
      break;
    }
  }

  const ordered = <T>(records: Map<string, T>): T[] =>
    [...records.keys()].sort().map((key) => records.get(key)!);

  return { source, nodes: ordered(nodes), edges: ordered(edges) };
}
