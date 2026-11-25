import { claimTaskPostSchema, containsKnownSecret, type TaskBidRequest, type TaskBidResponse } from "@swarmroom/protocol";
import { and, eq, isNotNull, isNull, ne, notExists } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agentHosts, agents, hosts, taskBids, taskPosts } from "../db/schema.js";
import type { HostRequestBroker, HostRequestConnection } from "../hosts/request-broker.js";
import { permissions } from "../permissions.js";
import { taskChannel, taskPostParams } from "../task-channel-access.js";
import { saveTaskBid } from "../tasks/bids.js";

type Options = {
  broker: HostRequestBroker<TaskBidRequest, TaskBidResponse["result"]>;
  findConnection: (hostId: string, tokenHash: string, agentName: string) => HostRequestConnection<TaskBidRequest> | undefined;
};

const endpoint = "/api/channels/:channelId/tasks/:taskId/bids/suggest";

async function openTask(request: FastifyRequest, reply: FastifyReply) {
  const access = await taskChannel(request, reply, permissions.sendMessages | permissions.invokeAgents);
  if (!access) return;
  const params = taskPostParams.safeParse(request.params);
  if (!params.success) {
    await reply.code(400).send({ error: "Provide a valid task ID." });
    return;
  }
  const [task] = await db.select().from(taskPosts)
    .where(and(eq(taskPosts.channelId, access.channel.id), eq(taskPosts.id, params.data.taskId))).limit(1);
  if (!task || task.createdBy !== access.user.id) {
    await reply.code(403).send({ error: "Only the task author can request automated bids." });
    return;
  }
  if (task.resolution || task.claimedByAgentId) {
    await reply.code(409).send({ error: "Request an agent bid for an open, unclaimed task." });
    return;
  }
  return { ...access, task };
}

export const taskBidSuggestionRoutes: FastifyPluginAsync<Options> = async (app, { broker, findConnection }) => {
  const inFlight = new Set<string>();

  async function eligible(
    channel: { id: string; serverId: string }, taskId: string, onlyAgentId?: string,
  ) {
    const bids = db.select({ id: taskBids.id }).from(taskBids)
      .where(and(eq(taskBids.taskId, taskId), eq(taskBids.agentId, agents.id)));
    const assignments = db.select({ id: taskPosts.id }).from(taskPosts).where(and(
      isNotNull(taskPosts.claimedByAgentId), eq(taskPosts.claimedByAgentId, agents.id), isNull(taskPosts.resolution),
    ));
    const candidates = await db.select({
      id: agents.id, name: agents.name, role: agents.role, ownerId: agents.ownerId,
      hostId: hosts.id, tokenHash: hosts.tokenHash,
    }).from(agents).innerJoin(agentHosts, and(eq(agentHosts.agentId, agents.id), eq(agentHosts.enabled, true)))
      .innerJoin(hosts, and(eq(hosts.id, agentHosts.hostId), eq(hosts.ownerId, agents.ownerId), ne(hosts.status, "revoked")))
      .where(and(eq(agents.serverId, channel.serverId), onlyAgentId ? eq(agents.id, onlyAgentId) : undefined,
        notExists(bids), notExists(assignments),
      )).orderBy(agents.name, agents.id, agentHosts.priority, hosts.id).limit(300);

    const available = new Map<string, { agent: (typeof candidates)[number]; connection: HostRequestConnection<TaskBidRequest> }>();
    const access = new Map<string, boolean>();
    for (const agent of candidates) {
      if (available.has(agent.id)) continue;
      const connection = findConnection(agent.hostId, agent.tokenHash, agent.name);
      if (!connection) continue;
      if (!access.has(agent.ownerId)) {
        access.set(agent.ownerId, await hasChannelPermission(channel, agent.ownerId, permissions.invokeAgents));
      }
      if (access.get(agent.ownerId)) available.set(agent.id, { agent, connection });
    }
    return available;
  }

  app.get(endpoint, async (request, reply) => {
    const access = await openTask(request, reply);
    if (!access) return;
    const candidates = await eligible(access.channel, access.task.id);
    return reply.header("Cache-Control", "no-store").send(
      [...candidates.values()].map(({ agent: { id, name, role } }) => ({ id, name, role })),
    );
  });

  app.post(endpoint, { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const access = await openTask(request, reply);
    if (!access) return;
    const body = claimTaskPostSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Choose an eligible agent." });
    const { task, channel, user } = access;
    const agentId = body.data.agentId.toLowerCase();
    if (containsKnownSecret(task.title) || containsKnownSecret(task.description)) {
      return reply.code(422).send({ error: "The task contains a blocked credential pattern." });
    }
    const candidate = (await eligible(channel, task.id, agentId)).get(agentId);
    if (!candidate) return reply.code(409).send({ error: "The agent is unavailable for a new bid." });
    const key = `${task.id}:${agentId}`;
    if (inFlight.has(key)) return reply.code(409).send({ error: "This agent already has a bid request for the task." });
    inFlight.add(key);
    try {
      const { agent, connection } = candidate;
      const result = await broker.request(connection, (requestId) => ({
        t: "task.bid.request", requestId, channelId: channel.id, requesterId: user.id,
        agent: agent.name, title: task.title, description: task.description.slice(0, 1600),
      }));
      if (!result || result.status === "unavailable") {
        return reply.code(503).send({ error: "The agent could not prepare a bid. Try again when its host is available." });
      }
      if (result.status === "declined") return reply.header("Cache-Control", "no-store").send({ bid: null });
      if (containsKnownSecret(result.draft.plan) || containsKnownSecret(result.draft.deliverable)) {
        return reply.code(422).send({ error: "The agent bid contains a blocked credential pattern." });
      }
      const latest = (await eligible(channel, task.id, agentId)).get(agentId);
      if (latest?.connection.connectionId !== connection.connectionId ||
          !await hasChannelPermission(channel, user.id, permissions.sendMessages | permissions.invokeAgents)) {
        return reply.code(409).send({ error: "The agent or channel permissions changed during the request." });
      }
      const stored = await saveTaskBid({
        ...result.draft, taskId: task.id, channelId: channel.id, agentId, agentName: agent.name,
        proposedBy: agent.ownerId, source: "agent",
      });
      if ("error" in stored) return reply.code(stored.status).send({ error: stored.error });
      return reply.code(stored.status).header("Cache-Control", "no-store").send({ bid: stored.bid });
    } finally {
      inFlight.delete(key);
    }
  });
};
