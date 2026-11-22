/** Proof for discharging an original, independently deferred no-write failure.
 * Reads existing specialist/Review and idea-placement authorities only.
 * Never dispatches the failed operation or grants any writer/model scope. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JobStartResult } from "./job.js";
import type { RecoveryCase, RecoveryDischarge } from "./generation-recovery-contract.js";
import type { RecoverySource } from "./generation-recovery-graph.js";
import type { GenerationInventory } from "./generation-plan.js";
import type { IdeaHistoryEntry } from "./generation.js";
import { git, load } from "./ideas.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { trustedHead } from "./revision.js";

export interface DeferredResolutionState {
  inventory: GenerationInventory | null;
  ideaHistory: readonly IdeaHistoryEntry[];
  /** Fixtures have deterministic, request-bound non-Pi proof only. */
  fixture: boolean;
}

/** Returns exact, source-linked existing receipts or null. A later verified
 * correction is NOT a reentry ticket for the original failed specialist. */
export async function inspectDeferredCorrection(
  job: JobStartResult, original: RecoveryCase, source: RecoverySource,
  state: DeferredResolutionState,
  expected?: RecoveryDischarge,
): Promise<RecoveryDischarge | null> {
  if (source.caseId !== original.id || source.channel !== "operationRecovery" ||
      source.input.safeAction !== "continue-independent" ||
      !["specialist-dispatch", "idea-integration"].includes(original.origin.operation))
    return null;
  const head = await trustedHead(job);
  // Original provenance remains immutable even when later work changes HEAD.
  git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, head);
  let discharge: RecoveryDischarge | null = null;
  if (original.origin.operation === "specialist-dispatch") {
    const assignment = original.origin.assignmentId;
    const evidence = source.input.evidence as { assignmentId?: string } | undefined;
    const item = state.inventory?.items.find(entry => entry.id === assignment);
    if (!assignment || evidence?.assignmentId !== assignment ||
        item?.status !== "verified" || !item.verifiedSha) return null;
    const point = (await inspectRecoveryCheckpoints(job)).find(entry =>
      entry.eligible && entry.workItem === assignment &&
      entry.commitSha === item.verifiedSha &&
      (entry.semanticReview === "passed" || entry.semanticReview === "not-required" ||
        entry.stage === "foundation" && entry.semanticReview === "untracked" &&
          entry.validation.status === "passed"));
    if (!point || point.commitSha === original.origin.sourceHeadSha) return null;
    git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, point.commitSha);
    discharge = { case: original, correction: { store: "review-checkpoint", ref: point.commitSha },
      correctedHeadSha: point.commitSha };
  } else {
    const evidence = source.input.evidence as {
      ideaId?: string; signature?: string; action?: string; resultStatus?: string
    } | undefined;
    if (!evidence?.ideaId || evidence.resultStatus !== "deferred" ||
        !state.ideaHistory.some(entry =>
          entry.id === evidence.ideaId && entry.signature === evidence.signature &&
          entry.action === evidence.action && entry.status === "deferred"))
      return null;
    // load authenticates the immutable inbox capture, every placement
    // transition and its exact committed Git/Pi/receipt provenance.
    const idea = (await load(job)).find(entry => entry.id === evidence.ideaId);
    const placement = idea?.lifecycle.placements.at(-1);
    if (idea?.lifecycle.status !== "integrated" || !placement ||
        !["integrated", "reassessed", "relocated"].includes(placement.action) ||
        !(placement.verified === "pi" || state.fixture && placement.verified === "fixture-unverified"))
      return null;
    const file = join(job.stateDir, "idea-placements",
      idea.id + "-" + placement.revision + ".json");
    const receipt = JSON.parse(await readFile(file, "utf8")) as {
      jobId?: string; ideaId?: string; revision?: number; commitSha?: string;
    };
    if (receipt.jobId !== job.jobId || receipt.ideaId !== idea.id ||
        receipt.revision !== placement.revision || !receipt.commitSha ||
        receipt.commitSha === original.origin.sourceHeadSha) return null;
    git(job, "merge-base", "--is-ancestor", original.origin.sourceHeadSha, receipt.commitSha);
    discharge = { case: original,
      correction: { store: "idea-placement", ref: idea.id + ":" + receipt.commitSha },
      correctedHeadSha: receipt.commitSha };
  }
  return expected && !isDeepStrictEqual(discharge, expected) ? null : discharge;
}
