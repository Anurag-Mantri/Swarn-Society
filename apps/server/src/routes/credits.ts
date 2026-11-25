import { creditAccountSchema, creditEntrySchema, type CreditAccount } from "@swarmroom/protocol";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { hasServerPermission } from "../channel-access.js";
import { db } from "../db/index.js";
import { agents, creditEntries, hosts, members, servers } from "../db/schema.js";
import { permissions } from "../permissions.js";

const path = "/api/servers/:serverId/credits";
const paramsSchema = z.object({ serverId: z.string().uuid() });
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function access(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply);
  if (!user) return;
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    await reply.code(400).send({ error: "Provide a valid workspace ID." });
    return;
  }
  if (!await hasServerPermission(params.data.serverId, user.id, permissions.manageAgents | permissions.manageMembers)) {
    await reply.code(403).send({ error: "You cannot manage credits in this workspace." });
    return;
  }
  return { ...params.data, actorId: user.id };
}

async function accountExists(transaction: Transaction, serverId: string, account: CreditAccount): Promise<boolean> {
  if (account.kind === "agent") {
    const [agent] = await transaction.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, account.id), eq(agents.serverId, serverId))).limit(1);
    return Boolean(agent);
  }
  const [host] = await transaction.select({ id: hosts.id }).from(hosts).innerJoin(members, and(
    eq(members.userId, hosts.ownerId), eq(members.serverId, serverId),
  )).where(and(eq(hosts.id, account.id), ne(hosts.status, "revoked"))).limit(1);
  return Boolean(host);
}

function accountFilters(account: CreditAccount) {
  return {
    incoming: and(eq(creditEntries.toKind, account.kind), eq(creditEntries.toId, account.id)),
    outgoing: and(eq(creditEntries.fromKind, account.kind), eq(creditEntries.fromId, account.id)),
  };
}

async function balance(query: typeof db | Transaction, serverId: string, account: CreditAccount): Promise<bigint> {
  const { incoming, outgoing } = accountFilters(account);
  const [row] = await query.select({
    amount: sql<string>`coalesce(sum(case when ${incoming} then ${creditEntries.amount} else -${creditEntries.amount} end), 0)::text`,
  }).from(creditEntries).where(and(eq(creditEntries.serverId, serverId), or(incoming, outgoing)));
  return BigInt(row?.amount ?? "0");
}

export const creditRoutes: FastifyPluginAsync = async (app) => {
  app.get(path, async (request, reply) => {
    const authorized = await access(request, reply);
    if (!authorized) return;
    const account = creditAccountSchema.safeParse(request.query);
    if (!account.success) return reply.code(400).send({ error: "Provide an account kind and ID." });
    const { serverId } = authorized;
    const { incoming, outgoing } = accountFilters(account.data);
    const ledger = await db.transaction(async (transaction) => {
      const amount = await balance(transaction, serverId, account.data);
      const entries = await transaction.select().from(creditEntries)
        .where(and(eq(creditEntries.serverId, serverId), or(incoming, outgoing)))
        .orderBy(desc(creditEntries.createdAt), desc(creditEntries.id)).limit(100);
      return amount === 0n && !entries.length && !await accountExists(transaction, serverId, account.data)
        ? null : { balance: amount.toString(), entries };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!ledger) return reply.code(404).send({ error: "Account not found in this workspace." });
    return reply.header("Cache-Control", "no-store").send(ledger);
  });

  app.post(path, async (request, reply) => {
    const authorized = await access(request, reply);
    if (!authorized) return;
    const parsed = creditEntrySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Provide valid credit accounts, an amount, a reason, and a request ID." });
    const { serverId, actorId } = authorized;
    const { requestId, from, to, amount, reason } = parsed.data;
    const values = {
      serverId, actorId, requestId, fromKind: from?.kind ?? null, fromId: from?.id ?? null,
      toKind: to.kind, toId: to.id, amount, reason,
    };
    const result = await db.transaction(async (transaction) => {
      // Serialize transfers and issuances for this workspace so balance checks cannot race.
      const [workspace] = await transaction.select({ id: servers.id }).from(servers)
        .where(eq(servers.id, serverId)).for("no key update");
      if (!workspace) return { status: 404, error: "Workspace not found." } as const;
      const [existing] = await transaction.select().from(creditEntries)
        .where(and(eq(creditEntries.serverId, serverId), eq(creditEntries.requestId, requestId))).limit(1);
      if (existing) {
        const same = existing.actorId === actorId && existing.fromKind === values.fromKind && existing.fromId === values.fromId
          && existing.toKind === to.kind && existing.toId === to.id && existing.amount === amount && existing.reason === reason;
        return same ? { status: 200, entry: existing } as const
          : { status: 409, error: "This request ID already belongs to another credit entry." } as const;
      }
      if (!await accountExists(transaction, serverId, to) || (from && !await accountExists(transaction, serverId, from))) {
        return { status: 404, error: "A credit account was not found in this workspace." } as const;
      }
      if (from && await balance(transaction, serverId, from) < BigInt(amount)) {
        return { status: 409, error: "The source account has insufficient credits." } as const;
      }
      const [entry] = await transaction.insert(creditEntries).values(values).returning();
      if (!entry) throw new Error("Credit insertion did not return a row");
      return { status: 201, entry } as const;
    });
    if ("error" in result) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send(result.entry);
  });
};
