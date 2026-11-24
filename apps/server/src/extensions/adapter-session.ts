import type { AdapterFrame } from "@swarmroom/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { hasChannelPermission, hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import {
  channels, extensionAdapters, extensionManifests, extensionResources, extensionSessions, extensionSnapshots,
  hostExtensionApprovals, hosts,
} from "../db/schema.js";
import { permissions } from "../permissions.js";

export type AdapterConnection = { hostId: string; tokenHash: string; connectionId: string };
type AdapterReply =
  | { t: "adapter.ack"; action: "register" | "session.start" | "resource" | "snapshot" | "session.stop"; id: string }
  | { t: "error"; code: string; message: string };

const denied: AdapterReply = {
  t: "error", code: "adapter_denied", message: "The host, approved capabilities, or channel do not allow this adapter action.",
};
const conflict: AdapterReply = {
  t: "error", code: "adapter_conflict", message: "This adapter identifier is already bound to a different record.",
};

async function approval(host: AdapterConnection, manifestId: string) {
  const [row] = await db.select({
    ownerId: hosts.ownerId, serverId: extensionManifests.serverId, manifest: extensionManifests.manifest,
    capabilities: hostExtensionApprovals.capabilities,
  }).from(hosts).innerJoin(hostExtensionApprovals, eq(hostExtensionApprovals.hostId, hosts.id))
    .innerJoin(extensionManifests, eq(extensionManifests.id, hostExtensionApprovals.manifestId))
    .where(and(
      eq(hosts.id, host.hostId), eq(hosts.tokenHash, host.tokenHash), eq(hosts.status, "online"),
      eq(extensionManifests.id, manifestId),
    )).limit(1);
  return row;
}

async function adapterForHost(host: AdapterConnection, adapterId: string) {
  const [adapter] = await db.select().from(extensionAdapters)
    .where(and(eq(extensionAdapters.id, adapterId), eq(extensionAdapters.hostId, host.hostId))).limit(1);
  return adapter;
}

function sessionScope(host: AdapterConnection, sessionId: string) {
  return and(eq(extensionSessions.id, sessionId), eq(extensionSessions.connectionId, host.connectionId),
    isNull(extensionSessions.stoppedAt));
}

async function channelAllows(channelId: string, access: NonNullable<Awaited<ReturnType<typeof approval>>>) {
  const [channel] = await db.select({ id: channels.id, serverId: channels.serverId }).from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.serverId, access.serverId))).limit(1);
  return channel && await hasChannelPermission(channel, access.ownerId, permissions.sendMessages);
}

export async function handleAdapterFrame(host: AdapterConnection, frame: AdapterFrame): Promise<AdapterReply> {
  if (frame.t === "adapter.register") {
    const access = await approval(host, frame.manifestId);
    if (!access || access.manifest.protocolVersion !== frame.protocolVersion ||
        !await hasServerPermission(access.serverId, access.ownerId, permissions.readMessages)) return denied;
    await db.insert(extensionAdapters).values({
      id: frame.adapterId, hostId: host.hostId, manifestId: frame.manifestId,
    }).onConflictDoNothing({ target: extensionAdapters.id });
    const adapter = await adapterForHost(host, frame.adapterId);
    return adapter?.manifestId === frame.manifestId
      ? { t: "adapter.ack", action: "register", id: frame.adapterId } : conflict;
  }

  if (frame.t === "adapter.session.start") {
    const adapter = await adapterForHost(host, frame.adapterId);
    const access = adapter && await approval(host, adapter.manifestId);
    if (!access || !await channelAllows(frame.channelId, access)) return denied;
    await db.insert(extensionSessions).values({
      id: frame.sessionId, adapterId: frame.adapterId, channelId: frame.channelId, connectionId: host.connectionId,
    }).onConflictDoNothing({ target: extensionSessions.id });
    const [session] = await db.select().from(extensionSessions).where(and(
      sessionScope(host, frame.sessionId), eq(extensionSessions.adapterId, frame.adapterId),
      eq(extensionSessions.channelId, frame.channelId),
    )).limit(1);
    return session ? { t: "adapter.ack", action: "session.start", id: frame.sessionId } : conflict;
  }

  if (frame.t === "adapter.session.stop") {
    const [session] = await db.update(extensionSessions).set({ stoppedAt: new Date() })
      .where(sessionScope(host, frame.sessionId)).returning({ id: extensionSessions.id });
    return session ? { t: "adapter.ack", action: "session.stop", id: frame.sessionId } : denied;
  }

  const [session] = await db.select({
    channelId: extensionSessions.channelId, manifestId: extensionAdapters.manifestId,
  }).from(extensionSessions).innerJoin(extensionAdapters, eq(extensionAdapters.id, extensionSessions.adapterId))
    .where(and(sessionScope(host, frame.sessionId), eq(extensionAdapters.hostId, host.hostId))).limit(1);
  const access = session && await approval(host, session.manifestId);
  if (!session || !access || !await channelAllows(session.channelId, access)) return denied;

  return db.transaction(async (transaction): Promise<AdapterReply> => {
    const [active] = await transaction.select({ id: extensionSessions.id })
      .from(extensionSessions).where(sessionScope(host, frame.sessionId)).for("update");
    if (!active) return denied;
    const [current] = await transaction.select({ capabilities: hostExtensionApprovals.capabilities })
      .from(hostExtensionApprovals).innerJoin(hosts, eq(hosts.id, hostExtensionApprovals.hostId)).where(and(
        eq(hostExtensionApprovals.hostId, host.hostId), eq(hostExtensionApprovals.manifestId, session.manifestId),
        eq(hosts.tokenHash, host.tokenHash), eq(hosts.status, "online"),
      )).for("share", { of: [hostExtensionApprovals, hosts] });
    if (!current) return denied;

    if (frame.t === "adapter.resource") {
      const declared = access.manifest.resources.some(({ type, extensions }) =>
        type === frame.resourceType && extensions.includes(frame.extension));
      if (!declared || !current.capabilities.includes("resource.read")) return denied;
      const resource = {
        id: frame.resourceId, sessionId: frame.sessionId,
        resourceType: frame.resourceType, extension: frame.extension, byteLength: frame.byteLength,
      };
      const [saved] = await transaction.insert(extensionResources).values(resource).onConflictDoUpdate({
        target: extensionResources.id,
        set: { byteLength: frame.byteLength, reportedAt: new Date() },
        setWhere: and(eq(extensionResources.sessionId, frame.sessionId),
          eq(extensionResources.resourceType, frame.resourceType), eq(extensionResources.extension, frame.extension)),
      }).returning({ id: extensionResources.id });
      return saved ? { t: "adapter.ack", action: "resource", id: frame.resourceId } : conflict;
    }

    if (!current.capabilities.includes("snapshot.create") || access.manifest.snapshotFormat !== frame.format) return denied;
    const [resource] = await transaction.select({ id: extensionResources.id }).from(extensionResources)
      .where(and(eq(extensionResources.id, frame.resourceId), eq(extensionResources.sessionId, frame.sessionId)));
    if (!resource) return denied;
    const snapshot = {
      id: frame.snapshotId, sessionId: frame.sessionId, resourceId: frame.resourceId,
      format: frame.format, sha256: frame.sha256, byteLength: frame.byteLength,
    };
    await transaction.insert(extensionSnapshots).values(snapshot).onConflictDoNothing({ target: extensionSnapshots.id });
    const [stored] = await transaction.select({ id: extensionSnapshots.id }).from(extensionSnapshots).where(and(
      eq(extensionSnapshots.id, frame.snapshotId), eq(extensionSnapshots.sessionId, frame.sessionId),
      eq(extensionSnapshots.resourceId, frame.resourceId), eq(extensionSnapshots.sha256, frame.sha256),
      eq(extensionSnapshots.format, frame.format), eq(extensionSnapshots.byteLength, frame.byteLength),
    )).limit(1);
    return stored ? { t: "adapter.ack", action: "snapshot", id: frame.snapshotId } : conflict;
  });
}

export async function closeAdapterSessions(connectionId: string): Promise<void> {
  await db.update(extensionSessions).set({ stoppedAt: new Date() }).where(and(
    eq(extensionSessions.connectionId, connectionId), isNull(extensionSessions.stoppedAt),
  ));
}
