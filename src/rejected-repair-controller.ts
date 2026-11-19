/**
 * Pure, bounded orchestration for a rejected specialist assignment.
 *
 * Storage, Pi, native validation, Git, author identity and sealed review
 * enforcement belong to the trusted adapters in rejected-review-repair.ts.
 * Keeping ordering separate makes the no-replay and no-debate contracts
 * executable in CI without fake Pi credentials or fake Git approvals.
 */
import type { RepairReceipt } from "./rejected-review-repair.js";
import type { SpecialistChoiceReceipt } from "./specialist-choice.js";

export type RepairCycleState = Pick<RepairReceipt,
  "phase" | "sourceCommitSha" | "repairedCommitSha" | "choiceId">;
export interface RepairCycleOps<S extends RepairCycleState> {
  begin(): Promise<S>;
  inspect(sourceSha: string): Promise<S>;
  correct(sourceSha: string): Promise<S>;
  choice(id: string): Promise<Pick<SpecialistChoiceReceipt,
    "id" | "phase" | "proposalSha256" | "question">>;
  consume(sourceSha: string): Promise<S>;
  validate(sourceSha: string): Promise<S>;
  commit(sourceSha: string): Promise<S>;
  reviewStatus(state: S): Promise<"required-pending" | "passed" | "failed">;
  rereview(state: S): Promise<void>;
  finishReview(sourceSha: string): Promise<S>;
  nextFailure(state: S): Promise<S>;
  /** Only after a sealed failed rereview may the graph yield for pending
   * author steering. Never interrupt a claimed writer or a pending review. */
  shouldYieldForSteering?: (state: S) => Promise<boolean>;
  /** Recheck deterministic source references before one fresh independent read-only review. */
  adjudicate(state: S): Promise<S>;
}
export type RepairCycleResult<S extends RepairCycleState> =
  | { state: S; next: "completed" }
  | { state: S; next: "author-escalation" }
  | { state: S; next: "steering-boundary" }
  | { state: S; next: "controller-replan" }
  | { state: S; next: "manual-reconcile"; reason: string }
  | { state: S; next: "author-choice"; choice: {
    id: string; proposalSha256: string; question: SpecialistChoiceReceipt["question"] } | null };

/** Never retries a claimed Pi turn after interruption. Each transition is
 * one-way and durable before any subsequent external side effect. */
export async function driveRejectedRepairCycle<S extends RepairCycleState>(
  // At most 12 ordinary + 6 explicit author-granted corrections per Turn,
  // each potentially traversing a writer, validator, checkpoint and separate
  // independent rereview. The ledger owns attempt limits, not this guard.
  ops: RepairCycleOps<S>, maxTransitions = 160,
): Promise<RepairCycleResult<S>> {
  let state = await ops.begin();
  for (let step = 0; step < maxTransitions; step++) {
    state = await ops.inspect(state.sourceCommitSha);
    switch (state.phase) {
      case "ready":
        state = await ops.correct(state.sourceCommitSha);
        continue;
      case "repairing":
        return { state, next: "manual-reconcile",
          reason: "An original Pi writer call was interrupted; never replay its external effects." };
      case "needs-plan":
        return { state, next: "controller-replan" };
      case "disputing":
        state = await ops.adjudicate(state);
        continue;
      case "adjudicating":
        return { state, next: "manual-reconcile",
          reason: "An independent dispute adjudication was interrupted; preserve its session." };
      case "awaiting-author": {
        const response = state.choiceId ? await ops.choice(state.choiceId) : null;
        if (response?.phase !== "answered" && response?.phase !== "resuming")
          return { state, next: "author-choice",
            choice: response ? { id: response.id, proposalSha256: response.proposalSha256,
              question: response.question } : null };
        state = await ops.consume(state.sourceCommitSha);
        continue;
      }
      case "validating":
        state = await ops.validate(state.sourceCommitSha);
        continue;
      case "awaiting-checkpoint":
        state = await ops.commit(state.sourceCommitSha);
        continue;
      case "reviewing":
        if (await ops.reviewStatus(state) === "required-pending")
          await ops.rereview(state);
        state = await ops.finishReview(state.sourceCommitSha);
        continue;
      case "failed":
        if (await ops.shouldYieldForSteering?.(state))
          return { state, next: "steering-boundary" };
        state = await ops.nextFailure(state);
        continue;
      case "passed":
        return { state, next: "completed" };
      case "blocked":
        return { state, next: "author-escalation" };
    }
  }
  throw Error("Review repair controller exceeded its bounded transition limit.");
}
