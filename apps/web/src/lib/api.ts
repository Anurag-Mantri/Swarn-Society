import type { AgentReputation, ChannelKind, GitHubCommitReceipt, KnowledgeExtractionInput, KnowledgeOverview, KnowledgeProposalFile, KnowledgeReview, KnowledgeReviewCandidate, MemoryNote, MemoryScope, TaskBid, TaskBidInput, TaskClaimant, TaskCoordinationMetrics, TaskPost, TaskReputationInput, TaskReputationReview, TaskResolution } from '@swarmroom/protocol';

export type Profile = { id: string; handle: string; avatarUrl: string | null };
export type Workspace = { id: string; name: string; ownerId: string };
export type Channel = { id: string; name: string; kind: ChannelKind; serverId?: string };
export type WorkspaceFile = { id: string; path: string };
export type Message = {
  id: string;
  channelId: string;
  threadId: string | null;
  body: string;
  authorId: string;
  authorKind: string;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const message = typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string'
      ? error.error
      : 'The request failed. Try again.';
    throw new ApiError(response.status, message);
  }
  return await response.json() as T;
}

function post<T>(path: string, body?: object): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
}

export const api = {
  profile: () => request<Profile>('/api/me'),
  workspaces: () => request<Workspace[]>('/api/servers'),
  createWorkspace: (name: string) => post<Workspace>('/api/servers', { name }),
  createChannel: (workspaceId: string, name: string, kind: ChannelKind) =>
    post<Channel>(`/api/servers/${encodeURIComponent(workspaceId)}/channels`, { name, kind }),
  messages: (channelId: string, threadId?: string) => request<Message[]>(
    `/api/channels/${encodeURIComponent(channelId)}/messages${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`
  ),
  files: (workspaceId: string) => request<WorkspaceFile[]>(`/api/servers/${encodeURIComponent(workspaceId)}/files`),
  createFile: (workspaceId: string, path: string) =>
    post<WorkspaceFile>(`/api/servers/${encodeURIComponent(workspaceId)}/files`, { path }),
  snapshot: (workspaceId: string) => request<{ serverId: string; files: { path: string; content: string }[] }>(
    `/api/servers/${encodeURIComponent(workspaceId)}/files/snapshot`
  ),
  tasks: (channelId: string) => request<TaskPost[]>(`/api/channels/${encodeURIComponent(channelId)}/tasks`),
  taskClaimants: (channelId: string) => request<TaskClaimant[]>(`/api/channels/${encodeURIComponent(channelId)}/tasks/claimants`),
  createTask: (channelId: string, title: string, description: string, intent?: string, parentTaskId?: string) =>
    post<TaskPost>(`/api/channels/${encodeURIComponent(channelId)}/tasks`, { title, description, intent, parentTaskId }),
  claimTask: (channelId: string, taskId: string, agentId: string) =>
    post<TaskPost>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/claim`, { agentId }),
  taskBids: (channelId: string, taskId: string) =>
    request<TaskBid[]>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/bids`),
  placeBid: (channelId: string, taskId: string, bid: TaskBidInput) =>
    post<TaskBid>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/bids`, bid),
  approveBid: (channelId: string, taskId: string, bidId: string) =>
    post<TaskPost>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/bids/${encodeURIComponent(bidId)}/approve`),
  resolveTask: (channelId: string, taskId: string, resolution: TaskResolution, result: string) =>
    post<TaskPost>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/resolve`, { resolution, result }),
  taskMetrics: (channelId: string, days: string) => request<TaskCoordinationMetrics>(
    `/api/channels/${encodeURIComponent(channelId)}/tasks/metrics?days=${encodeURIComponent(days)}`
  ),
  agentReputation: (channelId: string) =>
    request<AgentReputation[]>(`/api/channels/${encodeURIComponent(channelId)}/tasks/reputation`),
  taskReputation: (channelId: string, taskId: string) =>
    request<{ canReview: boolean; review: TaskReputationReview | null }>(
      `/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/reputation`
    ),
  reviewTask: (channelId: string, taskId: string, review: TaskReputationInput) =>
    post<TaskReputationReview>(`/api/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}/reputation`, review),
  knowledge: (serverId: string, channelId?: string) => request<KnowledgeOverview>(
    `/api/servers/${encodeURIComponent(serverId)}/knowledge${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`
  ),
  importCommitReceipt: (serverId: string, receipt: GitHubCommitReceipt) =>
    post<{ sourceId: string; inserted: boolean }>(`/api/servers/${encodeURIComponent(serverId)}/knowledge/commit-receipts`, receipt),
  extractionInputPath: (channelId: string, messageId: string) =>
    `/api/channels/${encodeURIComponent(channelId)}/knowledge/extraction-input?messageId=${encodeURIComponent(messageId)}`,
  extractionInput: (channelId: string, messageId: string) =>
    request<KnowledgeExtractionInput>(api.extractionInputPath(channelId, messageId)),
  importKnowledgeProposal: (proposal: KnowledgeProposalFile) =>
    post<{ inserted: number }>(`/api/channels/${encodeURIComponent(proposal.channelId)}/knowledge/proposals`, proposal),
  knowledgeReviews: (serverId: string) =>
    request<KnowledgeReviewCandidate[]>(`/api/servers/${encodeURIComponent(serverId)}/knowledge/reviews`),
  decideKnowledgeReview: (serverId: string, edgeId: string, review: KnowledgeReview) =>
    post<{ id: string }>(`/api/servers/${encodeURIComponent(serverId)}/knowledge/reviews/${encodeURIComponent(edgeId)}`, review),
  memory: (id: string, scope: MemoryScope, q: string, targetId?: string) => {
    const query = new URLSearchParams({ scope, q });
    if (targetId) query.set('targetId', targetId);
    return request<MemoryNote[]>(`/api/servers/${encodeURIComponent(id)}/memory?${query}`);
  },
  memoryAgents: (id: string) => request<TaskClaimant[]>(`/api/servers/${encodeURIComponent(id)}/memory/agents`),
  saveMemory: (id: string, scope: MemoryScope, body: string, targetId?: string) =>
    post<MemoryNote>(`/api/servers/${encodeURIComponent(id)}/memory`, { scope, body, targetId }),
  signOut: () => post<{ ok: boolean }>('/auth/logout')
};
