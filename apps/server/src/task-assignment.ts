import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { agents, channels, taskBids, taskCoordinationDaily, taskPosts } from "./db/schema.js";

type Assignment = {
  channelId: string;
  serverId: string;
  taskId: string;
  agentId: string;
  actorId: string;
  bidId?: string;
};

type AssignmentResult =
  | { task: typeof taskPosts.$inferSelect }
  | { status: 403 | 404 | 409; error: string };

export function assignTask(assignment: Assignment): Promise<AssignmentResult> {
  const { channelId, serverId, taskId, agentId, actorId, bidId } = assignment;
  return db.transaction(async (transaction): Promise<AssignmentResult> => {
    async function conflict(
      reason: "duplicateIntentAttempts" | "busyAgentAttempts" | "competingClaimAttempts",
      error: string,
    ): Promise<AssignmentResult> {
      const day = new Date().toISOString().slice(0, 10);
      await transaction.insert(taskCoordinationDaily).values({ channelId, day, [reason]: 1 }).onConflictDoUpdate({
        target: [taskCoordinationDaily.channelId, taskCoordinationDaily.day],
        set: { [reason]: sql`${taskCoordinationDaily[reason]} + 1` },
      });
      return { status: 409, error };
    }

    // Serialize claims in the channel and across the agent's channels without blocking foreign key inserts.
    await transaction.select({ id: channels.id }).from(channels)
      .where(eq(channels.id, channelId)).for("no key update");
    const [agent] = await transaction.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId))).for("no key update");
    if (!agent) return { status: 404, error: "Agent not found in this workspace." };

    const [task] = await transaction.select().from(taskPosts)
      .where(and(eq(taskPosts.id, taskId), eq(taskPosts.channelId, channelId))).for("update");
    if (!task) return { status: 404, error: "Task not found in this channel." };
    if (task.createdBy !== actorId) return { status: 403, error: "Only the task author can assign it." };
    if (task.resolution) return { status: 409, error: "This task is closed." };
    if (task.claimedByAgentId) {
      if (task.claimedByAgentId === agentId) {
        if (!bidId) return { task };
        const [bid] = await transaction.select({ approvedBy: taskBids.approvedBy }).from(taskBids)
          .where(and(eq(taskBids.id, bidId), eq(taskBids.taskId, taskId))).limit(1);
        if (bid?.approvedBy === actorId) return { task };
      }
      return conflict("competingClaimAttempts", "Another claim was accepted for this task.");
    }

    const [intentInProgress] = await transaction.select({ id: taskPosts.id }).from(taskPosts).where(and(
      eq(taskPosts.channelId, channelId), eq(taskPosts.intent, task.intent),
      isNull(taskPosts.resolution), isNotNull(taskPosts.claimedByAgentId),
    )).limit(1);
    if (intentInProgress) return conflict("duplicateIntentAttempts", "An agent is already working on this intent in the channel.");

    const [busy] = await transaction.select({ id: taskPosts.id }).from(taskPosts).where(and(
      eq(taskPosts.claimedByAgentId, agentId), isNull(taskPosts.resolution),
    )).limit(1);
    if (busy) return conflict("busyAgentAttempts", "This agent has an active task. Close it before assigning more work.");

    const assignedAt = new Date();
    const [claimed] = await transaction.update(taskPosts).set({ claimedByAgentId: agentId, claimedAt: assignedAt })
      .where(eq(taskPosts.id, taskId)).returning();
    if (!claimed) throw new Error("The locked task did not exist");
    if (bidId) {
      const [approved] = await transaction.update(taskBids).set({ approvedAt: assignedAt, approvedBy: actorId })
        .where(and(eq(taskBids.id, bidId), eq(taskBids.taskId, taskId), eq(taskBids.agentId, agentId)))
        .returning({ id: taskBids.id });
      if (!approved) throw new Error("The approved bid did not exist");
    }
    return { task: claimed };
  });
}
