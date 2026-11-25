import { voiceHostSelectionSchema, type VoiceGrant, type VoiceTokenRequest } from "@swarmroom/protocol";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasChannelPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { channels, hosts, servers, voiceHosts } from "../db/schema.js";
import { permissions } from "../permissions.js";
import type { HostRequestBroker, HostRequestConnection } from "../hosts/request-broker.js";

const channelParams = z.object({ channelId: z.string().uuid() });
const serverParams = z.object({ serverId: z.string().uuid() });
const settingsPath = "/api/servers/:serverId/voice";
type Options = {
  broker: HostRequestBroker<VoiceTokenRequest, VoiceGrant>;
  findConnection: (hostId: string, tokenHash: string) => HostRequestConnection<VoiceTokenRequest> | undefined;
};

async function workspaceOwner(serverId: string) {
  const [workspace] = await db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId)).limit(1);
  return workspace?.ownerId;
}

function selectedHost(serverId: string) {
  return db.select({ hostId: hosts.id, tokenHash: hosts.tokenHash }).from(voiceHosts)
    .innerJoin(servers, eq(servers.id, voiceHosts.serverId))
    .innerJoin(hosts, and(eq(hosts.id, voiceHosts.hostId), eq(hosts.ownerId, servers.ownerId)))
    .where(and(eq(voiceHosts.serverId, serverId), ne(hosts.status, "revoked"))).limit(1);
}

export const voiceRoutes: FastifyPluginAsync<Options> = async (app, { broker, findConnection }) => {
  app.get(settingsPath, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = serverParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid workspace ID." });
    const { serverId } = params.data;
    if (await workspaceOwner(serverId) !== user.id) {
      return reply.code(403).send({ error: "Only the workspace owner can view voice settings." });
    }
    const [selected] = await selectedHost(serverId);
    const owned = await db.select({ id: hosts.id, machineLabel: hosts.machineLabel, tokenHash: hosts.tokenHash }).from(hosts)
      .where(and(eq(hosts.ownerId, user.id), ne(hosts.status, "revoked"))).orderBy(hosts.machineLabel, hosts.id);
    return reply.header("Cache-Control", "no-store").send({
      hostId: selected?.hostId ?? null,
      hosts: owned.map(({ id, machineLabel, tokenHash }) => ({ id, machineLabel, connected: !!findConnection(id, tokenHash) })),
    });
  });

  app.put(settingsPath, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = serverParams.safeParse(request.params);
    const body = voiceHostSelectionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Provide a workspace and valid voice host." });
    const { serverId } = params.data;
    if (await workspaceOwner(serverId) !== user.id) {
      return reply.code(403).send({ error: "Only the workspace owner can configure voice." });
    }
    const { hostId } = body.data;
    if (hostId) {
      const [host] = await db.select({ id: hosts.id }).from(hosts)
        .where(and(eq(hosts.id, hostId), eq(hosts.ownerId, user.id), ne(hosts.status, "revoked"))).limit(1);
      if (!host) return reply.code(404).send({ error: "Choose a registered host that you own." });
      await db.insert(voiceHosts).values({ serverId, hostId }).onConflictDoUpdate({ target: voiceHosts.serverId, set: { hostId } });
    } else {
      await db.delete(voiceHosts).where(eq(voiceHosts.serverId, serverId));
    }
    return reply.header("Cache-Control", "no-store").send({ hostId });
  });

  app.post("/api/channels/:channelId/voice/join", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const params = channelParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Provide a valid voice channel ID." });
    const [channel] = await db.select().from(channels)
      .where(and(eq(channels.id, params.data.channelId), eq(channels.kind, "voice"))).limit(1);
    if (!channel) return reply.code(404).send({ error: "Voice channel not found." });
    if (!await hasChannelPermission(channel, user.id, permissions.readMessages)) {
      return reply.code(403).send({ error: "You cannot join this voice channel." });
    }
    const [selected] = await selectedHost(channel.serverId);
    const connection = selected && findConnection(selected.hostId, selected.tokenHash);
    if (!selected || !connection) {
      return reply.code(503).send({ error: "The workspace voice host is unavailable." });
    }
    const canPublish = await hasChannelPermission(channel, user.id, permissions.sendMessages);
    const grant = await broker.request(connection, (requestId) => ({
      t: "voice.token.request", requestId,
      userId: user.id, displayName: user.handle, canPublish, channelId: channel.id, serverId: channel.serverId,
    }));
    const [current] = await selectedHost(channel.serverId);
    if (!grant || current?.hostId !== selected.hostId || current.tokenHash !== selected.tokenHash ||
        findConnection(current.hostId, current.tokenHash)?.connectionId !== connection.connectionId) {
      return reply.code(503).send({ error: "The workspace voice host could not issue a join token." });
    }
    if (!await hasChannelPermission(channel, user.id, canPublish ? permissions.sendMessages : permissions.readMessages)) {
      return reply.code(403).send({ error: "Your voice channel access changed. Try joining again." });
    }
    return reply.header("Cache-Control", "no-store").send({ ...grant, canPublish });
  });
};
