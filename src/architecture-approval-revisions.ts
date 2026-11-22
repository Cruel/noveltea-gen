/** Controller-verified operator projection for a second reviewed-work boundary:
 * the signed Architecture causal-amendment path. This is deliberately not a
 * second repair ledger. A model's causal discovery is only a proposal; the
 * existing signed plan history, original no-write receipt and independent
 * checkpoint reviews remain the execution and approval authorities.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { CausalAmendment } from "./causal-amendment.js";
import { authenticateEventNoWrite, type EventNoWriteSource } from "./event-prerequisite-auth.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readIndependentReview } from "./checkpoint-assurance.js";
import { readReviewedMilestoneBlueprint } from "./milestone-blueprint.js";
import { approvalRevisionSeverity, classifyApprovalRevisionCause,
  type ApprovalRevisionCause, type ApprovalRevisionSeverity } from "./repair-ledger.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = /^[a-f0-9]{40}$/;
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function safeJson(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    throw Error("Unsafe historical Architecture correction evidence.");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}
type ArchitectureHistory = {
  plan: Plan; proposal: string; verifiedHead: string;
  causalAmendment?: CausalAmendment;
};
export interface ArchitectureApprovalRevision {
  kind: "architecture-causal-amendment";
  id: string; turnDigest: string; jobId: string; threadId: string;
  original: { milestoneId: string; digest: string; version: number; sourceSha: string };
  originalReviewDigest: string;
  eventHead: string; triggeringSourceSha: string;
  cause: ApprovalRevisionCause; severity: ApprovalRevisionSeverity;
  trigger: { kind: "event-causal-amendment"; fields: string[];
    sourcePaths: string[]; reviewDigest: string };
  originalApproval: { reviewerId: string; reviewDigest: string; commitSha: string };
  successor: { milestoneId: string; digest: string; version: number; sourceSha: string } | null;
  successorApproval: { reviewerId: string; reviewDigest: string; commitSha: string } | null;
  affectedWork: string[]; disposition: "corrected" | "awaiting-review";
}
/** Recheck the original complete no-write finding even after the generation
 * graph archives it. Stale/forged copies cannot be turned into incident
 * metadata or a new authorizing source. */
async function originalEvent(job: JobStartResult, proposal: CausalAmendment, original: Plan) {
  const slug = proposal.source.milestoneId.slice("milestone.".length);
  const archived = join(job.stateDir, "event-causal-history",
    slug + "-" + proposal.source.reportDigest + ".json");
  const path = existsSync(archived) ? archived :
    join(job.stateDir, "event-items", slug + ".json");
  const event = await safeJson(path);
  if (event.version !== 1 || event.jobId !== job.jobId ||
      event.milestoneId !== proposal.source.milestoneId ||
      event.planVersion !== original.version || event.planDigest !== hash(original) ||
      event.expectedHead !== proposal.source.sha || event.phase !== "prerequisite-reported" ||
      event.prerequisite?.reportDigest !== proposal.source.reportDigest ||
      event.blueprintPin?.digest !== proposal.source.blueprintDigest ||
      event.causalDiscovery?.sourcePath !== proposal.source.path ||
      event.causalDiscovery?.sourceQuote !== proposal.source.quote ||
      event.causalDiscovery?.violatedObligation !== proposal.obligation ||
      event.causalDiscovery?.proposedCorrection !== proposal.correction ||
      event.assignment?.milestoneId !== proposal.source.milestoneId ||
      event.assignment?.milestonePath !== proposal.source.path ||
      !event.assignment?.sourcePaths?.includes(proposal.source.path))
    throw Error("Architecture post-approval incident has altered or stale Event causal evidence.");
  await authenticateEventNoWrite(job, event as EventNoWriteSource);
  await readReviewedMilestoneBlueprint(job, event.blueprintPin, event.assignment);
  const source = git(job, "show", proposal.source.sha + ":" +
    (job.storyRelativePath ? job.storyRelativePath + "/" : "") + proposal.source.path);
  if (source.split(proposal.source.quote).length !== 2)
    throw Error("Architecture post-approval incident lost its unique historical source quote.");
  return event;
}

/** No mutable approval state is created here. Historical signed revisions
 * survive restarts, and only exact sealed independent reviews settle a
 * material Architecture correction. */
export async function inspectArchitectureApprovalRevisions(job: JobStartResult):
  Promise<ArchitectureApprovalRevision[]> {
  const path = join(job.stateDir, "architecture.json");
  if (!existsSync(path)) return [];
  const receipt = await safeJson(path);
  if (receipt.jobId !== job.jobId || receipt.threadId && receipt.threadId !== job.threadId ||
      !Array.isArray(receipt.history)) throw Error("Architecture incident has wrong job/Thread identity.");
  const entries = receipt.history as ArchitectureHistory[];
  // Ordinary job reporting must not rescan review checkpoints or load the
  // Architecture verifier unless this job actually has a signed challenge.
  if (!entries.some(entry => entry.causalAmendment)) return [];
  const { verifyPlanHistory } = await import("./architecture.js");
  verifyPlanHistory(job, receipt as Parameters<typeof verifyPlanHistory>[1]);
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const reviewed = async (commit: string, version: number) => {
    const matches = checkpoints.filter(p => p.commitSha === commit);
    if (matches.some(p => !p.eligible))
      throw Error("Architecture post-approval incident contains an untrustworthy historical checkpoint.");
    const point = matches.find(p => p.eligible &&
      p.workItem === "global-architecture" && p.planVersion === version &&
      p.assurance && p.semanticReview === "passed");
    if (!point?.assurance) return null;
    const review = await readIndependentReview(job, point.assurance);
    if (review.status !== "passed" || !review.result) return null;
    return { reviewerId: review.result.reviewer, reviewDigest: hash(review.result),
      commitSha: commit, turnDigest: point.assurance.turnDigest };
  };
  const result: ArchitectureApprovalRevision[] = [];
  for (const [index, entry] of entries.entries()) {
    const proposal = entry.causalAmendment;
    if (!proposal) continue;
    const originalCommit = entry.plan.items.find(i => i.id === "global-architecture")?.verifiedSha;
    if (!originalCommit || !sha.test(originalCommit) ||
        !checkpoints.some(p => p.commitSha === originalCommit && p.workItem === "global-architecture"))
      throw Error("Architecture post-approval incident lost its historical approved checkpoint.");
    const originalReview = await reviewed(originalCommit, entry.plan.version);
    // An unreviewed Architecture is not a second *reviewed* artifact. Never
    // present a purported historical approval based on a model assertion.
    if (!originalReview) continue;
    if (proposal.jobId !== job.jobId || proposal.threadId !== job.threadId ||
        proposal.source.planVersion !== entry.plan.version ||
        proposal.source.sha !== entry.verifiedHead ||
        !sha.test(proposal.source.sha))
      throw Error("Stale Architecture causal amendment identity.");
    // git merge-base --is-ancestor has no output; it throws on failure.
    git(job, "merge-base", "--is-ancestor", originalCommit!, proposal.source.sha);
    await originalEvent(job, proposal, entry.plan);
    const later = (entries[index + 1]?.plan ?? receipt.plan) as Plan | undefined;
    if (!later || later.version !== entry.plan.version + 1 ||
        JSON.stringify(later.causalAmendment) !== JSON.stringify(proposal))
      throw Error("Architecture revision lost its exact signed successor plan.");
    const updatedCommit = later.items.find(i => i.id === "global-architecture")?.verifiedSha;
    const approvedReview = updatedCommit && sha.test(updatedCommit)
      ? await reviewed(updatedCommit, later.version) : null;
    if (updatedCommit) {
      git(job, "merge-base", "--is-ancestor", proposal.source.sha, updatedCommit);
      const changed = git(job, "diff", "--name-only", proposal.source.sha, updatedCommit);
      const expected = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + proposal.source.path;
      if (changed !== expected)
        throw Error("Architecture correction changed sources outside its approved Milestone.");
    }
    const cause = classifyApprovalRevisionCause({ kind: "unknown",
      originalSourceSha: originalCommit!, verifiedSourceSha: proposal.source.sha });
    const base = { jobId: job.jobId, threadId: job.threadId,
      proposal: entry.proposal, reportDigest: proposal.source.reportDigest };
    result.push({
      kind: "architecture-causal-amendment", id: hash(base),
      turnDigest: originalReview.turnDigest, jobId: job.jobId, threadId: job.threadId,
      original: { milestoneId: proposal.source.milestoneId,
        digest: hash(entry.plan), version: entry.plan.version, sourceSha: originalCommit! },
      originalReviewDigest: originalReview.reviewDigest,
      eventHead: proposal.source.sha, triggeringSourceSha: proposal.source.sha,
      cause, severity: approvalRevisionSeverity(cause),
      trigger: { kind: "event-causal-amendment", fields: [proposal.source.path],
        sourcePaths: [proposal.source.path], reviewDigest: proposal.source.reportDigest },
      originalApproval: { reviewerId: originalReview.reviewerId,
        reviewDigest: originalReview.reviewDigest, commitSha: originalCommit! },
      successor: approvedReview ? { milestoneId: proposal.source.milestoneId,
        digest: hash(later), version: later.version, sourceSha: updatedCommit! } : null,
      successorApproval: approvedReview ? { reviewerId: approvedReview.reviewerId,
        reviewDigest: approvedReview.reviewDigest, commitSha: updatedCommit! } : null,
      affectedWork: [...proposal.affected], disposition: approvedReview ? "corrected" : "awaiting-review",
    });
  }
  return result;
}
