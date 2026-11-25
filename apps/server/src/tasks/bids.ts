import type { TaskBidDraft } from "@swarmroom/protocol";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { taskBids, taskPosts } from "../db/schema.js";

type NewBid = TaskBidDraft & {
  taskId: string;
  channelId: string;
  agentId: string;
  agentName: string;
  proposedBy: string;
  source: "member" | "agent";
};

export function saveTaskBid({ taskId, channelId, agentId, agentName, proposedBy, source, ...draft }: NewBid) {
  return db.transaction(async (transaction) => {
    const [task] = await transaction.select({ id: taskPosts.id, resolution: taskPosts.resolution, claim: taskPosts.claimedByAgentId })
      .from(taskPosts).where(and(eq(taskPosts.id, taskId), eq(taskPosts.channelId, channelId))).for("update");
    if (!task) return { status: 404, error: "Task not found in this channel." } as const;
    if (task.resolution) return { status: 409, error: "This task is closed." } as const;
    if (task.claim) return { status: 409, error: "This task already has a claim." } as const;
    const [bid] = await transaction.insert(taskBids).values({
      ...draft, agentId, taskId, proposedBy, source,
    }).onConflictDoNothing({ target: [taskBids.taskId, taskBids.agentId] }).returning();
    if (!bid) return { status: 409, error: "This agent already submitted a bid." } as const;
    return { status: 201, bid: { ...bid, agentName } } as const;
  });
}
