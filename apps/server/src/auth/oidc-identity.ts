import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { members, memberRoles, oidcIdentities, roles, users } from "../db/schema.js";

type Identity = { issuer: string; subject: string; displayName: string };

export function ensureOidcMembership(serverId: string, { issuer, subject, displayName }: Identity) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([issuer, subject])}, 3381650))`);
    const [role] = await transaction.select({ id: roles.id }).from(roles)
      .where(and(eq(roles.serverId, serverId), eq(roles.name, "Member"))).limit(1);
    if (!role) throw new Error("Workspace member role is unavailable.");
    const [identity] = await transaction.select({ userId: oidcIdentities.userId }).from(oidcIdentities)
      .where(and(eq(oidcIdentities.issuer, issuer), eq(oidcIdentities.subject, subject))).limit(1);
    let userId = identity?.userId;
    if (!userId) {
      const [user] = await transaction.insert(users).values({ handle: displayName }).returning({ id: users.id });
      if (!user) throw new Error("Could not create workspace identity.");
      userId = user.id;
      await transaction.insert(oidcIdentities).values({ issuer, subject, userId });
    }
    const [added] = await transaction.insert(members).values({ serverId, userId }).onConflictDoNothing()
      .returning({ userId: members.userId });
    if (added) await transaction.insert(memberRoles).values({ serverId, userId, roleId: role.id });
    return userId;
  });
}
