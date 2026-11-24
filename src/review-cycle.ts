/** The identity of one bounded writer/reviewer collaboration, not an approval.
 * Controllers bind it to trusted source and assignment provenance. Later review
 * adapters may share this identity without sharing their semantic findings. */
import { createHash } from "node:crypto";

export interface ReviewCycleScope {
  jobId: string;
  threadId: string;
  baseSha: string;
  executionHead: string;
  planVersion: number;
  contractDigest: string;
  snapshotId: string;
  provider: string;
  model: string;
  taskDigest: string;
}

export function reviewCycleId(scope: ReviewCycleScope): string {
  const {
    jobId,
    threadId,
    baseSha,
    executionHead,
    planVersion,
    contractDigest,
    snapshotId,
    provider,
    model,
    taskDigest,
  } = scope;
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: "noveltea-review-cycle/v1",
        jobId,
        threadId,
        baseSha,
        executionHead,
        planVersion,
        contractDigest,
        snapshotId,
        provider,
        model,
        taskDigest,
      }),
    )
    .digest("hex");
}

/** Domain adapters prove material changes against their own source model.
 * This common policy owns the progression decision, not the creative findings
 * or a second review ledger. In particular, a regression or repeated draft
 * never buys a fresh semantic correction window. */
export function reviewRoundProgress(input: {
  previousDigests: readonly string[];
  draftDigest: string;
  material: boolean;
  regressed: boolean;
  stalledBefore: number;
  status: "pass" | "revise";
  independentReplacement?: boolean;
}) {
  const hasPrior = input.previousDigests.length > 0;
  const oscillating = input.previousDigests.includes(input.draftDigest);
  const productive = hasPrior && !oscillating && input.material && !input.regressed;
  if (hasPrior && input.status === "pass" && !productive && !input.independentReplacement)
    throw Error("Review pass has no verified material source progress or repeats an old draft.");
  const stalled = !hasPrior || productive ? 0 : input.stalledBefore + 1;
  return { productive, oscillating, stalled,
    reassess: input.status === "revise" && stalled >= 2 };
}

/** Shared, source-grounded progress policy for bounded text review assignments.
 * A revised manuscript is not progress unless a prior finding is materially
 * improved at its original path; changing words or reporting fresh findings
 * does not buy another semantic retry. */
export function sourceReviewConvergence(
  review: {
    status: "pass" | "revise";
    prior: readonly {
      round: number;
      findingIndex: number;
      status: "resolved" | "improved" | "persisting" | "regressed";
      evidence: { path: string; quote: string };
    }[];
  },
  sources: Record<string, string>,
  previous: readonly {
    sources: Record<string, string>;
    verdict: { findings: readonly { path: string }[] };
  }[],
  stalledBefore = 0,
) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const now = digest(sources);
  const last = previous.at(-1);
  const material = !!last && review.prior.some((item) => {
      if (item.status !== "resolved" && item.status !== "improved") return false;
      const finding = previous[item.round]?.verdict.findings[item.findingIndex];
      return (
        !!finding &&
        sources[finding.path] !== last.sources[finding.path] &&
        sources[finding.path]?.includes(item.evidence.quote) &&
        !last.sources[finding.path]?.includes(item.evidence.quote)
      );
    });
  return reviewRoundProgress({
    previousDigests: previous.map(round => digest(round.sources)), draftDigest: now,
    material, regressed: review.prior.some(item => item.status === "regressed"),
    stalledBefore, status: review.status,
  });
}

export function sourceReviewDiagnosticTrigger(
  rounds: readonly { verdict: { status: "pass" | "revise"; findings: readonly { origin?: string }[] } }[],
  stalled: number,
  diagnosed = 0,
  lastDiagnosedRound = 0,
): "stagnation" | "late-blockers" | "review-depth" | null {
  if (rounds.at(-1)?.verdict.status !== "revise" || diagnosed >= 2) return null;
  const since = rounds.length - lastDiagnosedRound;
  if (since <= 0) return null;
  if (stalled >= 2 && (!lastDiagnosedRound || since >= 2))
    return "stagnation";
  const late = rounds
    .slice(-Math.min(3, since))
    .filter(
      (round, index) =>
        rounds.length - Math.min(3, since) + index >= 2 &&
        round.verdict.findings.some((f) => f.origin === "introduced" || f.origin === "overlooked"),
    );
  if (late.length >= 2) return "late-blockers";
  return since >= 5 ? "review-depth" : null;
}

export function assertReviewCycleSession(
  writer: { id: string; file: string },
  reviewer: { id: string; file: string },
  original?: { id: string; file: string },
): void {
  if (
    !writer.id ||
    !writer.file ||
    !reviewer.id ||
    !reviewer.file ||
    writer.id === reviewer.id ||
    writer.file === reviewer.file ||
    (original && (reviewer.id !== original.id || reviewer.file !== original.file))
  )
    throw Error("Independent review cycle has a wrong or changed reviewer Pi session.");
}
