import type { SharedDatabase } from "../db/kysely-connection";
import type { StudioDb } from "../db/studio-db";
import type { SteeringBoundaryDecision, SteeringInput } from "../../../src/steering-boundary";

const sha = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const job = (id: string) => ({ kind: "job" as const, id });
const thread = (id: string) => ({ kind: "thread" as const, id });

/** This port works for both SQLite and PostgreSQL. It never derives a write
 * grant from message text or from the Pi SDK's delivery acknowledgement. */
export function createKyselySteeringPlanPersistence(db: SharedDatabase<StudioDb>) {
  return {
    async boundaryReceipts(owner: string, jobId: string, threadId: string) {
      if (!owner || !jobId || !threadId) throw Error('Authenticated steering boundary required.');
      return db.read.selectFrom('threadSteeringPlanAmendments')
        .select(['messageId', 'sourceSha', 'amendmentDigest'])
        .where('ownerUserId', '=', owner).where('sourceJobId', '=', jobId)
        .where('threadId', '=', threadId).orderBy('recordedAt').orderBy('messageId').execute();
    },
    async pendingBoundary(owner: string, jobId: string, threadId: string): Promise<SteeringInput[]> {
      if (!owner || !jobId || !threadId) throw Error("Authenticated steering boundary required.");
      const rows = await db.read.selectFrom("threadLiveInputs as l")
        .innerJoin("storyThreadMessages as m", join => join
          .onRef("m.id", "=", "l.messageId")
          .onRef("m.ownerUserId", "=", "l.ownerUserId")
          .onRef("m.threadId", "=", "l.threadId"))
        .innerJoin("generationRunQueue as q", join => join
          .onRef("q.jobId", "=", "l.sourceJobId")
          .onRef("q.ownerUserId", "=", "l.ownerUserId"))
        .leftJoin("threadSteeringIntents as i", join => join
          .onRef("i.messageId", "=", "l.messageId")
          .onRef("i.ownerUserId", "=", "l.ownerUserId")
          .onRef("i.threadId", "=", "l.threadId"))
        .select(["l.messageId as messageId", "l.threadId as threadId",
          "l.sourceJobId as jobId", "m.body as content", "l.state as state",
          "l.submittedHead as submittedHead", "l.targetWorkItem as targetWorkItem",
          "i.disposition as disposition"])
        .where("l.ownerUserId", "=", owner).where("l.sourceJobId", "=", jobId)
        .where("l.threadId", "=", threadId).where("l.mode", "=", "steer")
        .where("l.state", "in", ["pending", "deferred", "delivered"])
        .where("q.phase", "=", "running")
        .where("m.phase", "in", ["queued", "finished", "blocked"])
        .where(eb => eb.not(eb.exists(eb.selectFrom("threadSteeringPlanAmendments as p")
          .select("p.messageId").whereRef("p.messageId", "=", "l.messageId"))))
        // A rejected steer already has a durable review fence. Do not
        // re-pause the recovered controller on the same immutable message.
        .where(eb => eb.or([eb("i.reviewState", "is", null),
          eb("i.reviewState", "in", ["considered", "unresolved"])]))
        .where(eb => eb.not(eb.exists(eb.selectFrom("storyThreadMessageCancellations as c")
          .select("c.messageId").whereRef("c.messageId", "=", "l.messageId"))))
        .orderBy("m.sequence").execute();
      return rows.map(row => ({ ...row, state: row.state as SteeringInput["state"] }));
    },
    async settleBoundary(owner: string, jobId: string, threadId: string,
      decision: SteeringBoundaryDecision, at: string): Promise<void> {
      if (!owner || !jobId || !threadId || !sha.test(decision.sourceSha) ||
          !decision.messageId || !decision.content?.trim() ||
          decision.kind === "applied" && !digest.test(decision.amendmentDigest ?? "") ||
          decision.kind === "review-required" && decision.amendmentDigest !== null ||
          !decision.reason?.trim() || decision.reason.length > 1000)
        throw Error("Invalid source-bound author steering decision.");
      await db.withWriteTransaction([job(jobId), thread(threadId)], async tx => {
        const row = await tx.selectFrom("threadLiveInputs as l")
          .innerJoin("storyThreadMessages as m", join => join
            .onRef("m.id", "=", "l.messageId")
            .onRef("m.ownerUserId", "=", "l.ownerUserId")
            .onRef("m.threadId", "=", "l.threadId"))
          .innerJoin("generationRunQueue as q", join => join
            .onRef("q.jobId", "=", "l.sourceJobId")
            .onRef("q.ownerUserId", "=", "l.ownerUserId"))
          .leftJoin("threadSteeringIntents as i", join => join
            .onRef("i.messageId", "=", "l.messageId")
            .onRef("i.ownerUserId", "=", "l.ownerUserId"))
          .select(["l.state as state", "l.submittedHead as submittedHead",
            "l.targetWorkItem as workItem", "m.body as content",
            "m.phase as phase", "i.reviewState as reviewState",
            "i.disposition as disposition"])
          .where("l.messageId", "=", decision.messageId)
          .where("l.ownerUserId", "=", owner).where("l.sourceJobId", "=", jobId)
          .where("l.threadId", "=", threadId).where("l.mode", "=", "steer")
          .where("q.phase", "=", "running").executeTakeFirst();
        if (!row || row.content !== decision.content)
          throw Error("Steering message changed, lost ownership or its generation ended.");
        // Distinct from Pi checkpoint links: those may have the same commit SHA.
        // This row is the one-shot DB receipt for the private graph amendment.
        const targetState = decision.kind === "applied" ? "considered" : "pending-boundary";
        const reviewDisposition = decision.kind === "applied" ? "within-scope" :
          row.disposition === "protected-review" || /protected (?:canon|target|decision)/i.test(decision.reason)
            ? "protected-review" : "scope-review";
        const saved = await tx.selectFrom("threadSteeringPlanAmendments")
          .select(["ownerUserId", "threadId", "sourceJobId", "sourceSha", "amendmentDigest"])
          .where("messageId", "=", decision.messageId).executeTakeFirst();
        if (saved) {
          if (decision.kind === "applied" && saved.ownerUserId === owner &&
              saved.threadId === threadId && saved.sourceJobId === jobId &&
              saved.sourceSha === decision.sourceSha &&
              saved.amendmentDigest === decision.amendmentDigest) return;
          throw Error("Steering decision was already bound to another source.");
        }
        if (row.reviewState === "pending-boundary" && row.phase === "blocked" &&
            decision.kind === "review-required") return;
        if (!["pending", "deferred", "delivered"].includes(row.state) ||
            !["queued", "finished"].includes(row.phase ?? "") ||
            row.reviewState && !["considered", "unresolved", "pending-boundary"].includes(row.reviewState))
          throw Error("Steering decision is stale or has already been reviewed.");
        const cancelled = await tx.selectFrom("storyThreadMessageCancellations")
          .select("messageId").where("messageId", "=", decision.messageId).executeTakeFirst();
        if (cancelled) throw Error("Cancelled steering cannot amend a pending plan.");
        await tx.updateTable("threadLiveInputs")
          .set({ state: row.state === "pending" ? "deferred" : row.state })
          .where("messageId", "=", decision.messageId).where("ownerUserId", "=", owner)
          .where("sourceJobId", "=", jobId).execute();
        await tx.updateTable("storyThreadMessages")
          .set({ status: "delivered", jobId, phase: decision.kind === "applied" ? "finished" : "blocked" })
          .where("id", "=", decision.messageId).where("ownerUserId", "=", owner)
          .where("threadId", "=", threadId).execute();
        await tx.insertInto("threadSteeringIntents").values({
          messageId: decision.messageId, ownerUserId: owner, threadId, sourceJobId: jobId,
          disposition: reviewDisposition, workItem: row.workItem, consideredAt: at,
          reviewState: targetState,
        }).onConflict(oc => oc.column("messageId").doUpdateSet({
          reviewState: targetState,
          ...(decision.kind === "review-required" ? { disposition: reviewDisposition } : {}),
        }))
          .execute();
        if (decision.kind === "applied") {
          await tx.insertInto("threadSteeringPlanAmendments").values({
            messageId: decision.messageId, ownerUserId: owner, threadId,
            sourceJobId: jobId, sourceSha: decision.sourceSha,
            amendmentDigest: decision.amendmentDigest!, recordedAt: at,
          }).execute();
        }
      });
    },
  };
}
