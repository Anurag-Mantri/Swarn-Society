export type KnowledgeOverview = {
  sources: Array<{
    id: string;
    channelId: string | null;
    type: string;
    sourceId: string;
    method: string;
    occurredAt: string;
  }>;
  nodes: Array<{ id: string; kind: string; key: string; confidence: number; sourceIds: string[] }>;
  edges: Array<{ id: string; fromId: string; toId: string; relation: string; confidence: number; sourceIds: string[] }>;
};
