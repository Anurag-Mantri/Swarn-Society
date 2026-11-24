import type { KnowledgeEvent } from "@swarmroom/knowledge-graph";
import { Hocuspocus } from "@hocuspocus/server";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import * as Y from "yjs";
import { z } from "zod";
import { getSessionUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { workspaceFiles } from "../db/schema.js";
import { recordKnowledgeEvent } from "../knowledge/storage.js";
import { permissions } from "../permissions.js";

const documentId = z.string().uuid();
const writeMask = permissions.readMessages | permissions.sendMessages;
const maxDocumentBytes = 192 * 1024;
type Context = { userId: string; serverId?: string };
type FileEdit = Extract<KnowledgeEvent, { type: "file.changed" }>;

async function storeDocument(id: string, update: Uint8Array, edits: FileEdit[]): Promise<void> {
  await db.transaction(async (transaction) => {
    const [file] = await transaction.select({ serverId: workspaceFiles.serverId, document: workspaceFiles.document })
      .from(workspaceFiles).where(eq(workspaceFiles.id, id)).for("update");
    if (!file) return;
    const merged = file.document ? Y.mergeUpdates([file.document, update]) : update;
    await transaction.update(workspaceFiles).set({ document: Buffer.from(merged) })
      .where(eq(workspaceFiles.id, id));
    for (const edit of edits.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
      await recordKnowledgeEvent(transaction, { ...edit, serverId: file.serverId });
    }
  });
}

export const workspaceCollaborationRoutes: FastifyPluginAsync = async (app) => {
  const pendingEdits = new Map<string, Map<string, FileEdit>>();
  const persist = async (documentName: string, document: Y.Doc) => {
    const pending = pendingEdits.get(documentName);
    const edited = [...(pending?.values() ?? [])];
    await storeDocument(documentName, Y.encodeStateAsUpdate(document), edited);
    for (const edit of edited) if (pending?.get(edit.sourceId) === edit) pending.delete(edit.sourceId);
    if (pending?.size === 0 && pendingEdits.get(documentName) === pending) pendingEdits.delete(documentName);
  };
  const collaboration = new Hocuspocus<Context>({
    name: "Swarmroom workspace",
    quiet: true,
    debounce: 300,
    maxDebounce: 1500,
    maxPendingDocuments: 4,
    maxUnauthenticatedQueueSize: 256 * 1024,
    async onAuthenticate({ documentName, context, connectionConfig }) {
      const id = documentId.safeParse(documentName);
      if (!id.success) throw new Error("Workspace file is unavailable.");
      const [file] = await db.select({ serverId: workspaceFiles.serverId })
        .from(workspaceFiles).where(eq(workspaceFiles.id, id.data)).limit(1);
      if (!file || !await hasServerPermission(file.serverId, context.userId, permissions.readMessages)) {
        throw new Error("Workspace file is unavailable.");
      }
      connectionConfig.readOnly = !await hasServerPermission(file.serverId, context.userId, writeMask);
      return { serverId: file.serverId };
    },
    async onLoadDocument({ document, documentName }) {
      const [file] = await db.select({ document: workspaceFiles.document })
        .from(workspaceFiles).where(eq(workspaceFiles.id, documentName)).limit(1);
      if (!file) throw new Error("Workspace file is unavailable.");
      if (file.document) Y.applyUpdate(document, file.document);
    },
    async beforeSync({ document, payload, type, context, connection }) {
      // SyncStep2 and Update both contain document changes.
      if ((type !== 1 && type !== 2) || connection.readOnly) return;
      if (!context.serverId || !await hasServerPermission(context.serverId, context.userId, writeMask)) {
        throw { code: 1008, reason: "Workspace write access changed." };
      }
      const current = Y.encodeStateAsUpdate(document);
      const candidate = Y.mergeUpdates([current, payload]);
      if (candidate.byteLength > maxDocumentBytes) {
        throw { code: 1009, reason: "Workspace file exceeds the size limit." };
      }
    },
    async onChange({ context, documentName, connection }) {
      if (!connection || !context.serverId) return;
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      const pending = pendingEdits.get(documentName) ?? new Map<string, FileEdit>();
      const sourceId = `edited:${documentName}:${context.userId}:${minute}`;
      pending.set(sourceId, {
        type: "file.changed", sourceId,
        serverId: context.serverId, fileId: documentName,
        actor: { kind: "person", id: context.userId }, occurredAt: new Date(minute).toISOString(),
      });
      pendingEdits.set(documentName, pending);
    },
    async onStoreDocument({ document, documentName }) {
      await persist(documentName, document);
    },
  });

  const authenticated = new WeakMap<FastifyRequest, string>();
  const origin = new URL(config.githubCallbackUrl).origin;
  app.get("/collaboration", {
    websocket: true,
    async preValidation(request, reply) {
      if (request.headers.origin !== origin) {
        return reply.code(403).send({ error: "Invalid workspace origin." });
      }
      const user = await getSessionUser(request);
      if (!user) return reply.code(401).send({ error: "Authentication required." });
      authenticated.set(request, user.id);
    },
  }, (socket, request) => {
    const userId = authenticated.get(request);
    if (!userId) return socket.close(1008, "Invalid session.");
    const handshake = new Request(new URL(request.url, origin), { headers: { origin } });
    const client = collaboration.handleConnection({
      get readyState() { return socket.readyState; },
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
    }, handshake, { userId });
    socket.on("error", (error) => app.log.debug({ error }, "Collaboration connection failed"));
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) return socket.close(1003, "Workspace updates must be binary.");
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      client.handleMessage(data);
    });
    socket.once("close", () => client.handleClose());
  });

  app.addHook("preClose", async () => {
    collaboration.closeConnections();
    collaboration.flushPendingStores();
    await Promise.all([...collaboration.documents].map(([id, document]) =>
      persist(id, document),
    ));
  });
};
