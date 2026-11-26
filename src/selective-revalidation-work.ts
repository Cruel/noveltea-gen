/** Read-only dependent revalidation at a reviewed upstream correction boundary.
 * Reuses the original generation inventory and independent narrative reviewer.
 * Historical review receipts are never changed; only narrow current-source
 * verdict references are stored. Failed dependent obligations are registered
 * in the same Turn Repair ledger, not treated as writer approval.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import type { GenerationInventory, ExecutionItem } from "./generation-plan.js";
import { trustedHead } from "./revision.js";
import { validateStoryJob } from "./validator.js";
import { inspectRepairLedger, admitCausalRevalidationFinding } from "./repair-ledger.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { reviewNarrative, type EditorialVerdict, type EditorialFinding,
  type ReviewAssignment } from "./narrative-review-specialist.js";
import { authenticateSelectiveImpact } from "./selective-revalidation-controller.js";
import { advanceDependentCorrection, inspectDependentCorrection } from "./dependent-correction-work.js";
import { verifiedNarrativeChain } from "./job-successor.js";
import { originalInventorySnapshotDigest, assertSelectiveRevalidationPlan,
  assertDependentCorrection,
  decideSelectiveRevalidation, proposeDependentCorrection,
  type DependentCorrectionAssignment, type ReviewedUpstreamCorrection,
  type RevalidationVerdict, type SelectiveRevalidationPlan } from "./selective-revalidation.js";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fileOf = (job: JobStartResult, sha: string) =>
  join(job.stateDir, "revalidation-items", sha + ".json");
type RevalidationReview = RevalidationVerdict & {
  originalCommitSha: string;
  originalReviewDigest: string;
  sessionFile: string;
  sessionDigest: string;
  verdict: EditorialVerdict;
  digest: string;
};
interface Receipt {
  version: 1;
  jobId: string;
  threadId: string;
  turnDigest: string;
  proposal: SelectiveRevalidationPlan;
  snapshot: SkillSnapshot;
  provider: string;
  model: string;
  originalInventoryDigest: string;
  state: "admitted" | "reviewing" | "completed" | "blocked";
  reviewing?: { itemId: string; sessionFile?: string };
  results: RevalidationReview[];
  failure?: string;
  correctiveAssignment?: DependentCorrectionAssignment;
  /** Negative reviews are never deleted on correction. */
  historicalFailures?: RevalidationReview[];
  /** Additional source edits invalidate earlier carry-forward verdicts.
   * Keep their transcripts; review those obligations again at the new HEAD. */
  supersededPasses?: RevalidationReview[];
  corrected?: Array<{ proposal: DependentCorrectionAssignment;
    itemId: string; successorSha: string; reviewDigest: string }>;
  finalHead?: string;
}
async function save(path: string, value: Receipt) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
async function read(path: string): Promise<Receipt | null> {
  if (!existsSync(path)) return null;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    throw Error("Unsafe source-bound dependent revalidation receipt.");
  return JSON.parse(await readFile(path, "utf8")) as Receipt;
}
async function transcript(job: JobStartResult, path: string): Promise<string> {
  if (!path.startsWith(join(job.stateDir, "review-sessions") + sep))
    throw Error("Revalidation reviewer transcript escaped the job's private review directory.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 50 || stat.size > 8 * 1024 * 1024)
    throw Error("Dependent reviewer transcript is missing or unsafe.");
  const raw = await readFile(path, "utf8");
  const first = JSON.parse(raw.split("\n")[0]!) as { type?: string; id?: string };
  if (first.type !== "session" || !first.id?.trim())
    throw Error("Independent revalidation reviewer lacks a durable Pi session header.");
  // Transcript receipts attest raw Pi session bytes, not a JSON-encoded
  // string. This is the same SHA-256 basis as the original writer/reviewer.
  return createHash("sha256").update(raw).digest("hex");
}
function checkReview(job: JobStartResult, plan: SelectiveRevalidationPlan,
  review: RevalidationReview, authenticatedHeads: readonly string[] = []) {
  const { digest, ...body } = review;
  if (!DIGEST.test(digest) || hash(body) !== digest ||
      !DIGEST.test(review.originalReviewDigest) || !DIGEST.test(review.reviewerDigest) ||
      !SHA.test(review.originalCommitSha) ||
      ![plan.successorSha, ...authenticatedHeads].includes(review.sourceSha) ||
      !review.verdict || review.verdict.verdict !== (review.status === "passed" ? "pass" : "block") ||
      review.reviewerDigest !== hash({ verdict: review.verdict,
        sessionDigest: review.sessionDigest, source: review.sourceSha, item: review.itemId }) ||
      !Array.isArray(review.verdict.findings) ||
      (review.status === "passed" && review.verdict.findings.some(f => f.severity === "blocking")) ||
      (review.status === "passed" && !review.verdict.evidence.length) ||
      !review.sessionFile.startsWith(job.stateDir))
    throw Error("Dependent revalidation's reviewer verdict or source digest changed.");
}
function reviewOrder(inventory: GenerationInventory, targets: string[]) {
  const items = new Map(inventory.items.map(i => [i.id, i]));
  const pending = new Set(targets);
  const ordered: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter(id => !items.get(id)?.dependencies.some(p => pending.has(p)));
    if (!ready.length) throw Error("Reviewed dependency graph has a cycle or missing source work item.");
    ready.sort();
    ordered.push(...ready);
    ready.forEach(id => pending.delete(id));
  }
  return ordered;
}
function preciseCorrectivePaths(item: ExecutionItem, sources: string[],
  findings: EditorialFinding[]): string[] {
  const owned = new Set(sources);
  const requested = [...new Set(findings.filter(f => f.severity === "blocking")
    .map(f => f.source.match(/^([a-z][a-z0-9-]*\/[a-z0-9._-]+\.md):[1-9][0-9]*$/)?.[1])
    .filter((s): s is string => !!s))].sort();
  // Reviewer prose does not grant extra paths. A finding on another owner's
  // record is an amendment request, never an implicit owner correction.
  return requested.filter(path => owned.has(path));
}
async function authenticatedCorrectionHeads(job: JobStartResult, state: Receipt) {
  const completed = state.corrected ?? [];
  const heads: string[] = [];
  if (new Set(completed.map(x => x.itemId)).size !== completed.length)
    throw Error("Duplicate original-owner corrective successors.");
  for (const corrected of completed) {
    assertDependentCorrection(corrected.proposal, state.proposal);
    if (corrected.itemId !== corrected.proposal.itemId ||
        !state.historicalFailures?.some(review => review.itemId === corrected.itemId &&
          review.status === "failed" &&
          review.reviewerDigest === corrected.proposal.revalidationReviewDigest))
      throw Error("Correction no longer cites its immutable negative dependent review.");
    const receipt = await inspectDependentCorrection(job, corrected.proposal, state.proposal);
    const last = receipt?.attempts.at(-1);
    if (receipt?.phase !== "verified" || !last || last.review.verdict !== "pass" ||
        last.commitSha !== corrected.successorSha ||
        last.reviewDigest !== corrected.reviewDigest)
      throw Error("Dependent corrective source lacks an independently passed Git successor.");
    heads.push(corrected.successorSha);
  }
  for (const history of [...state.historicalFailures ?? [], ...state.supersededPasses ?? []]) {
    checkReview(job, state.proposal, history, heads);
    if (history.sessionDigest !== await transcript(job, history.sessionFile))
      throw Error("Historical negative dependent review was altered after correction.");
  }
  return heads;
}
/** Recheck the durable independent verdicts whenever the original graph
 * resumes Composition. This is a read-only gate: saved model prose alone
 * cannot waive an unresolved dependent finding or missing session. */
export async function assertCompletedSelectiveRevalidation(
  job: JobStartResult, successorSha: string, turnDigest: string,
  correctionReviewDigest?: string,
  historicalAudit = false,
) {
  if (!SHA.test(successorSha) || !DIGEST.test(turnDigest))
    throw Error("Revalidation gate lacks pinned Story or Turn identity.");
  const state = await read(fileOf(job, successorSha));
  if (state) assertSelectiveRevalidationPlan(state.proposal);
  if (!state || state.version !== 1 || state.jobId !== job.jobId ||
      state.threadId !== job.threadId || state.turnDigest !== turnDigest ||
      state.proposal.successorSha !== successorSha ||
      state.proposal.turnDigest !== turnDigest ||
      (correctionReviewDigest !== undefined &&
        state.proposal.correctionReviewDigest !== correctionReviewDigest) ||
      await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path ||
      state.state !== "completed" || state.reviewing)
    throw Error("Dependent revalidation has no completed, source-bound independent review.");
  const original = /^event:milestone\.([a-z][a-z0-9-]*)$/.exec(
    state.proposal.upstreamItemId);
  if (!original) throw Error("Saved revalidation has no original Event owner.");
  const upstreamFile = join(job.stateDir, "prerequisite-items", original[1] + ".json");
  const upstream = JSON.parse(await readFile(upstreamFile, "utf8")) as {
    jobId?: string; phase?: string; commitSha?: string; reviewDigest?: string;
    originalInventoryDigest?: string;
  };
  if (upstream.jobId !== job.jobId || upstream.phase !== "verified" ||
      upstream.commitSha !== successorSha ||
      upstream.reviewDigest !== state.proposal.correctionReviewDigest ||
      upstream.originalInventoryDigest !== state.originalInventoryDigest)
    throw Error("Dependent carry-forward does not match its original reviewed correction grant.");
  if (state.correctiveAssignment)
    throw Error("A pending original-owner correction cannot be certified as completed.");
  const heads = await authenticatedCorrectionHeads(job, state);
  // Normal Composition admission still requires the EXACT current source.
  // C07 historical recovery audit may accept a later HEAD only after proving
  // every intervening canonical commit through the existing successor chain;
  // this does not carry the old dependent Review into a new assignment.
  const current = await trustedHead(job);
  if (!state.finalHead || (!historicalAudit && state.finalHead !== current))
    throw Error("Dependent carry-forward is stale against the current verified Story HEAD.");
  await verifiedNarrativeChain(job, successorSha, state.finalHead);
  if (historicalAudit) await verifiedNarrativeChain(job, state.finalHead, current);
  const expected = [...state.proposal.affected, ...state.proposal.unknown];
  if (new Set(expected).size !== expected.length || state.results.length !== expected.length ||
      new Set(state.results.map(r => r.itemId)).size !== expected.length ||
      state.results.some(r => !expected.includes(r.itemId) || r.status !== "passed"))
    throw Error("Revalidation cannot carry forward unreviewed, failed or duplicate dependent work.");
  for (const result of state.results) {
    checkReview(job, state.proposal, result, heads);
    if (result.sessionDigest !== await transcript(job, result.sessionFile))
      throw Error("Dependent reviewer transcript no longer matches the sealed verdict.");
  }
  const ledger = await inspectRepairLedger(job, turnDigest);
  if (ledger.findings.some(f => [successorSha, ...heads].includes(f.causedBy ?? "") &&
      f.status !== "resolved"))
    throw Error("An unresolved causally linked downstream Repair finding blocks Composition.");
  return state.proposal;
}
/** #221: a separately authorized existing-record correction is not the
 * Milestone closeout adapter. Authenticate its completed downstream verdicts
 * without pretending it authored a prerequisite-* Event correction. The
 * supporting grant itself is verified by inspectDependencyPlan at the caller.
 */
export async function assertCompletedOtherOwnerRevalidation(job: JobStartResult, source: {
  baseSha: string; successorSha: string; turnDigest: string; path: string; expectedContinuationHead?: string;
  historicalChainHead?: string; correctionReviewDigest?: string;
}) {
  const state = await read(fileOf(job, source.successorSha));
  if (state) assertSelectiveRevalidationPlan(state.proposal);
  if (!state || state.version !== 1 || state.jobId !== job.jobId ||
      state.threadId !== job.threadId || state.turnDigest !== source.turnDigest ||
      state.proposal.sourceSha !== source.baseSha ||
      state.proposal.successorSha !== source.successorSha ||
      state.proposal.turnDigest !== source.turnDigest ||
      (source.correctionReviewDigest !== undefined &&
        state.proposal.correctionReviewDigest !== source.correctionReviewDigest) ||
      JSON.stringify(state.proposal.changedPaths) !== JSON.stringify([source.path]) ||
      state.state !== "completed" || state.reviewing || state.correctiveAssignment ||
      await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path ||
      !state.finalHead || source.expectedContinuationHead && state.finalHead !== source.expectedContinuationHead)
    throw Error("Other-owner revalidation lacks a completed source-bound dependent review.");
  // The outer successor walker validates later commits; do not recursively
  // walk its own interval while authenticating this support commit.
  if (source.historicalChainHead) {
    const { dependencyGit } = await import("./dependency-state.js");
    dependencyGit(job, "merge-base", "--is-ancestor", state.finalHead, source.historicalChainHead);
    await verifiedNarrativeChain(job, source.successorSha, state.finalHead);
  } else {
    await verifiedNarrativeChain(job, state.finalHead, source.expectedContinuationHead ?? await trustedHead(job));
  }
  const heads = await authenticatedCorrectionHeads(job, state);
  const expected = [...state.proposal.affected, ...state.proposal.unknown];
  if (state.results.length !== expected.length ||
      new Set(state.results.map(r => r.itemId)).size !== expected.length ||
      state.results.some(r => !expected.includes(r.itemId) || r.status !== "passed"))
    throw Error("Other-owner revalidation cannot carry unreviewed or failed dependent work.");
  for (const result of state.results) {
    checkReview(job, state.proposal, result, heads);
    if (result.sessionDigest !== await transcript(job, result.sessionFile))
      throw Error("Other-owner revalidation lost a source-bound reviewer transcript.");
  }
  const ledger = await inspectRepairLedger(job, source.turnDigest);
  if (ledger.findings.some(f => [source.successorSha, ...heads].includes(f.causedBy ?? "") &&
      f.status !== "resolved"))
    throw Error("Unresolved downstream correction cannot be carried forward.");
  return state.proposal;
}

/** Current authority for a historical no-write pair after a reviewed support
 * correction. The original seal is unchanged; each changed path must match
 * the exact current-source independent dependent-review evidence. */
export async function assertRevalidatedEventOnlySource(job: JobStartResult,
    original: import("./interactive-event-only.js").EventOnlyPayload, sealDigest: string, changed: string[]) {
  const { inspectDependencyPlan, dependencyGit, dependencyDigest } = await import("./dependency-state.js");
  const head = await trustedHead(job);
  const {reviewedOmissionSuccessor} = await import("./interactive-event-only.js");
  // The shared assignment-fidelity Review may attest an ordinary write's
  // affected no-write obligations, in addition to the support adapter below.
  if (await reviewedOmissionSuccessor(job,original,sealDigest,head)) {
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    if (Object.keys(original.sourceHashes).some(path=>dependencyGit(job,"status","--porcelain=v1","--untracked-files=all","--",prefix+path)))
      throw Error("Event-only canonical evidence changed after review.");
    return;
  }
  const plan = await inspectDependencyPlan(job);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  for (const path of changed) {
    const repoPath = prefix + path;
    // A stale seal cannot authorize an uncommitted draft or a later unrelated
    // edit, even if some older revalidation passed.
    if (dependencyGit(job, "diff", "--name-only", head, "--", repoPath))
      throw Error("Event-only canonical evidence changed after review.");
    const last = dependencyGit(job, "log", "-1", "--format=%H", head, "--", repoPath);
    const entry = plan?.entries.find(e => e.writerSource?.targetPath === path &&
      e.phase === "verified" && e.commitSha === last && e.review?.verdict === "pass");
    if (!entry?.writerSource || !entry.commitSha || !entry.review)
      throw Error("Event-only canonical evidence changed after review.");
    const state = await read(fileOf(job, entry.commitSha));
    const review = state?.results.find(r => r.itemId === "interactive:" + original.milestoneId &&
      r.originalCommitSha === original.reviewHead && r.originalReviewDigest === sealDigest &&
      r.status === "passed");
    if (!review || !state?.finalHead || state.proposal.turnDigest !== entry.report.turnDigest ||
        state.proposal.planVersion !== original.planVersion)
      throw Error("Event-only canonical evidence changed without its independent revalidation.");
    await assertCompletedOtherOwnerRevalidation(job, {
      baseSha: entry.report.sourceSha, successorSha: entry.commitSha,
      turnDigest: entry.report.turnDigest, path, historicalChainHead: head,
      correctionReviewDigest: dependencyDigest(entry.review),
    });
    if (dependencyGit(job, "rev-parse", review.sourceSha + ":" + repoPath) !==
        dependencyGit(job, "rev-parse", head + ":" + repoPath))
      throw Error("Event-only source changed after dependent revalidation.");
  }
}

export interface RevalidateAfterCorrectionOptions {
  job: JobStartResult;
  inventory: GenerationInventory;
  correction: ReviewedUpstreamCorrection;
  contract: CompletionContract;
  task: string;
  provider: string;
  model: string;
  skillsSource?: string;
  validatorSource?: string;
  /** An independently authorized other-owner grant uses its own receipt gate. */
  otherOwnerPath?: string;
}
/** Caller holds the existing single Story writer lock. The upstream commit
 * has ALREADY passed independent review and been published by its own owner.
 * This function only adds independent reviewer calls for affected dependents.
 */
export async function revalidateAfterReviewedCorrection(opts: RevalidateAfterCorrectionOptions) {
  const { job, inventory, correction } = opts;
  const currentHead = await trustedHead(job);
  if (currentHead !== correction.successorSha)
    await verifiedNarrativeChain(job, correction.successorSha, currentHead);
  if (!opts.task.trim() || !opts.provider.trim() || !opts.model.trim())
    throw Error("Revalidation has no original author objective or pinned model.");
  const turn = await readReviewTurnEvidence(job);
  if (!turn || turn.digest !== correction.turnDigest ||
      JSON.stringify(turn.contract) !== JSON.stringify(opts.contract) ||
      turn.originalRequest !== opts.task)
    throw Error("Selective revalidation lost its original author goal/contract.");
  const validation = await validateStoryJob(job, opts.validatorSource ?? opts.skillsSource,
    { ...job, baseSha: correction.baseSha });
  const report = validation.report as { diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] };
    coverage?: { branchProgress?: Array<{ event: string; step: string; branch: string;
      status: string; witness?: string[] }> } } | undefined;
  if (validation.status !== "passed" || report?.diagnostics?.length ||
      report?.protection?.status !== "checked" ||
      report.protection.base !== correction.baseSha ||
      report.protection.changes?.length || report.protection.warnings?.length)
    throw Error("Native Story/protected authority is invalid after the upstream correction.");
  const { plan, originalPoints, reviewedSources, originalOmissions } =
    await authenticateSelectiveImpact(job, inventory, correction);
  const file = fileOf(job, correction.successorSha);
  let state = await read(file);
  if (!state) {
    const config = opts.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: opts.skillsSource,
          skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] }
      : { ...(await loadSkillConfig(undefined, false)), discovery: "explicit-only" as const,
          requiredSkills: ["nt-narrative-review", "nt-catalog"] };
    const snapshot = await createSkillSnapshot(config);
    if (!snapshot) throw Error("Selective revalidation needs pinned independent reviewer skills.");
    state = { version: 1, jobId: job.jobId, threadId: job.threadId,
      turnDigest: correction.turnDigest, proposal: plan, snapshot,
      provider: opts.provider, model: opts.model,
      originalInventoryDigest: originalInventorySnapshotDigest(inventory),
      state: "admitted", results: [] };
    await save(file, state);
  }
  if (state.version !== 1 || state.jobId !== job.jobId ||
      state.originalInventoryDigest !== originalInventorySnapshotDigest(inventory) ||
      state.threadId !== job.threadId || state.turnDigest !== correction.turnDigest ||
      state.proposal.digest !== plan.digest || state.provider !== opts.provider ||
      state.model !== opts.model || await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path)
    throw Error("Saved revalidation differs from the current Turn, scope, model or reviewer snapshot.");
  const wanted = [...plan.affected, ...plan.unknown];
  if (state.results.some(r => !wanted.includes(r.itemId)) ||
      new Set(state.results.map(r => r.itemId)).size !== state.results.length)
    throw Error("Revalidation receipt includes an unauthorized or duplicate dependent.");
  const reviewedHeads = await authenticatedCorrectionHeads(job, state);
  for (const result of state.results) {
    checkReview(job, plan, result, reviewedHeads);
    if (result.sessionDigest !== await transcript(job, result.sessionFile))
      throw Error("Prior independent revalidation transcript changed after review.");
    const point = originalPoints[result.itemId]?.at(-1);
    const omission = originalOmissions[result.itemId];
    if ((!point && !omission) || result.originalCommitSha !== (point?.commitSha ?? omission?.reviewHead) ||
        result.originalReviewDigest !== (reviewedSources[result.itemId]?.reviewDigest ??
          hash(point?.assurance)))
      throw Error("Saved dependent verdict changed its original checkpoint evidence.");
  }
  if (state.correctiveAssignment) {
    assertDependentCorrection(state.correctiveAssignment, plan);
    const cited = state.results.find(r => r.itemId === state.correctiveAssignment!.itemId &&
      r.status === "failed");
    const ownerId=state.correctiveAssignment.upstreamOwner?.itemId??state.correctiveAssignment.itemId;
    const point = originalPoints[ownerId]?.find(p =>
      p.commitSha === state.correctiveAssignment!.originalCommitSha);
    if (!cited || cited.reviewerDigest !== state.correctiveAssignment.revalidationReviewDigest ||
        !point?.assurance ||
        state.correctiveAssignment.originalCommitSha !== point.commitSha ||
        state.correctiveAssignment.assignmentId !== point.assurance.assignmentId ||
        state.correctiveAssignment.originalReviewDigest !==
          (reviewedSources[ownerId]?.reviewDigest ?? hash(point.assurance)) ||
        (state.correctiveAssignment.upstreamOwner &&
          (state.correctiveAssignment.upstreamOwner.affectedCommitSha!==cited.originalCommitSha ||
           state.correctiveAssignment.upstreamOwner.affectedReviewDigest!==cited.originalReviewDigest)) ||
        state.correctiveAssignment.authorizedPaths.some(p =>
          !point.assurance!.changedPaths.includes(p)))
      throw Error("Saved dependent correction changed its original owner or negative verdict.");
  }
  if (state.state === "reviewing")
    throw Error("Interrupted independent revalidation session requires transcript reconciliation; no replay.");
  if (state.state === "blocked" && !state.correctiveAssignment)
    throw Error(state.failure ?? "A downstream reviewed obligation still requires a controller amendment.");
  if (state.state === "completed") {
    if (opts.otherOwnerPath) {
      if (correction.changedPaths.length !== 1 || correction.changedPaths[0] !== opts.otherOwnerPath)
        throw Error("Other-owner revalidation must retain its one authorized path.");
      await assertCompletedOtherOwnerRevalidation(job, { baseSha: correction.baseSha,
        successorSha: correction.successorSha, turnDigest: correction.turnDigest,
        path: opts.otherOwnerPath });
    } else await assertCompletedSelectiveRevalidation(job, correction.successorSha, correction.turnDigest,
      correction.reviewDigest);
    if (state.results.length !== wanted.length ||
        state.results.some(r => r.status !== "passed"))
      throw Error("Completed revalidation has unreviewed or failed dependents.");
    return { plan, revalidated: state.results.map(r => r.itemId), carriedForward: plan.unaffected };
  }
  const finishOwnerCorrection = async () => {
    const proposal = state!.correctiveAssignment;
    if (!proposal) return;
    const prior = state!.results.find(r => r.itemId === proposal.itemId &&
      r.status === "failed" && r.reviewerDigest === proposal.revalidationReviewDigest);
    const ownerId=proposal.upstreamOwner?.itemId??proposal.itemId;
    const original = originalPoints[ownerId]?.find(p =>
      p.commitSha === proposal.originalCommitSha);
    if (!prior || !original?.assurance || !original.eligible)
      throw Error("Failed dependent correction has no original sealed reviewer or specialist.");
    const catalog = await (await import("./validator.js")).historicalCanonicalCatalog(job,proposal.sourceSha);
    const affectedIds=new Set(catalog.filter(r=>proposal.authorizedPaths.includes(r.path)&&r.metadata.type==="event").map(r=>r.metadata.id));
    const sharedMilestones=catalog.filter(r=>r.metadata.type==="milestone" &&
      (r.metadata.id===proposal.itemId.split(":")[1] ||
       (r.metadata.fulfillment as {any_of?:string[][]}|undefined)?.any_of?.some(route=>route.some(id=>affectedIds.has(id))))).map(r=>r.path);
    const outcome = await advanceDependentCorrection({
      job, proposal, plan, point: original, reviewerSnapshot: state!.snapshot,
      provider: opts.provider, model: opts.model, validatorSource: opts.validatorSource,
      sourcePaths: [...new Set([...(reviewedSources[proposal.itemId]?.sourcePaths ?? []),
        ...original.assurance.changedPaths,
        ...(proposal.upstreamOwner?originalPoints[proposal.itemId]?.flatMap(p=>p.assurance?.changedPaths??[])??[]:[]),
        ...correction.changedPaths, ...sharedMilestones])],
      findings: prior.verdict.findings.map(f => ({ source: f.source, message: f.message })),
    });
    const receipt = await inspectDependentCorrection(job, proposal, plan);
    const approved = receipt?.attempts.at(-1);
    if (receipt?.phase !== "verified" || !approved ||
        approved.commitSha !== outcome.commitSha ||
        approved.reviewDigest !== outcome.reviewDigest ||
        approved.review.verdict !== "pass")
      throw Error("Dependent correction returned without a fresh independent positive proof.");
    const reviewed: Omit<RevalidationReview, "digest"> = {
      itemId: proposal.itemId, sourceSha: approved.commitSha,
      originalCommitSha: prior.originalCommitSha,
      originalReviewDigest: prior.originalReviewDigest,
      reviewerDigest: hash({ verdict: approved.review,
        sessionDigest: approved.reviewerSessionDigest,
        source: approved.commitSha, item: proposal.itemId }),
      sessionFile: approved.reviewerSession,
      sessionDigest: approved.reviewerSessionDigest,
      verdict: approved.review, status: "passed",
    };
    state!.historicalFailures = [...state!.historicalFailures ?? [], prior];
    if(proposal.upstreamOwner) {
      state!.supersededPasses=[...state!.supersededPasses??[],...state!.results.filter(r=>r.status==="passed")];
      state!.results=[{...reviewed,digest:hash(reviewed)}];
    } else state!.results = state!.results.map(result => result === prior
      ? { ...reviewed, digest: hash(reviewed) } : result);
    state!.corrected = [...state!.corrected ?? [], {
      proposal, itemId: proposal.itemId, successorSha: approved.commitSha,
      reviewDigest: approved.reviewDigest,
    }];
    state!.correctiveAssignment = undefined;
    state!.state = "admitted";
    state!.failure = undefined;
    await save(file, state!);
  };
  if (state.correctiveAssignment) await finishOwnerCorrection();
  const order = reviewOrder(inventory, wanted);
  for (;;) {
    const id=order.find(candidate=>!state!.results.some(r=>r.itemId===candidate));
    if(!id)break;
    const item = inventory.items.find(i => i.id === id);
    const points = originalPoints[id];
    const omission = originalOmissions[id];
    if (!item || (!points?.length && !omission))
      throw Error("Dependent revalidation cannot recover the original reviewed specialist assignment: " + id);
    const point = points?.at(-1);
    const original = reviewedSources[id];
    const source = original?.sourcePaths ?? [];
    if (!omission && (!point?.assurance || !turn.assignments.some(a => a.id === point.assurance!.assignmentId)))
      throw Error("Prior dependent reviewer has no original Turn-owned specialist assignment.");
    const relevant = [...new Set([...source, ...(point?.assurance?.changedPaths ?? []),
      ...correction.changedPaths])].sort();
    if (relevant.length > 32)
      throw Error("Dependent revalidation exceeds bounded Story context.");
    const reviewHead = await trustedHead(job);
    const assignment: ReviewAssignment = {
      contract: opts.contract, planVersion: correction.planVersion,
      scopeIds: [...item.targetIds], paths: relevant,
      routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
      turnGoal: "REVALIDATE PREVIOUSLY REVIEWED " + id +
        " under the original author objective: " + turn.goal +
        ". Only this unit's original obligations and actual consumed premises; " +
        "later assignments remain outside this review. Distinguish a genuine regression caused by the correction from a pre-existing issue or a future unimplemented obligation. " +
        "A Character's current preference is not a permanent restriction unless the author or canon explicitly makes it so. " +
        "If a later branch can honor the preference by obtaining consent, evaluate the actual promised route and do not require its implementation at a foundations checkpoint. " +
        "Exact upstream changed lines (old versus new): " + (await (await import("./dependency-state.js")).dependencyGit(job,
          "diff","--unified=1",correction.baseSha,reviewHead,"--",...correction.changedPaths.map(p=>
            (job.storyRelativePath?job.storyRelativePath+"/":"")+p))).slice(0,12000),
      ...(omission ? { omission: { assignmentId: id, headSha: reviewHead } } : {
      specialistAssignments: [{
        id: point!.assurance!.assignmentId,
        specialist: turn.assignments.find(a => a.id === point!.assurance!.assignmentId)!.specialist,
        outcome: "Revalidate the original reviewed " + point!.workItem + " obligation.",
        targets: [...item.targetIds],
        authority: { recordTypes: [...point!.assurance!.changedRecordTypes],
          existingPaths: [...point!.assurance!.changedPaths], mayCreate: false },
      }],
      revalidation: { assignmentId: point!.assurance!.assignmentId,
        originalCommitSha: point!.commitSha, correctedHeadSha: reviewHead,
        changedPaths: [...new Set([...correction.changedPaths,
          ...(state.corrected ?? []).flatMap(c => c.proposal.authorizedPaths)])] } }),
    };
    await preflightPiAssignment(job, "revalidate:" + reviewHead + ":" + id,
      { provider: opts.provider, model: opts.model });
    state.state = "reviewing"; state.reviewing = { itemId: id }; await save(file, state);
    const verdict = await reviewNarrative({ ...job, headSha: reviewHead },
      state.snapshot, assignment, opts.provider, opts.model, undefined,
      async sessionFile => { state!.reviewing = { itemId: id, sessionFile }; await save(file, state!); },
      "selective-revalidation:" + correction.successorSha + ":" + id);
    // Each independently sealed dependent verdict must own its immutable Pi
    // transcript. Reusing the previous reviewer's file would append the next
    // assignment and retroactively invalidate the earlier sealed session SHA.
    const sessionFile = state.reviewing?.sessionFile;
    if (!sessionFile) throw Error("Dependent reviewer has no durable independent session.");
    const sessionDigest = await transcript(job, sessionFile);
    const r: Omit<RevalidationReview, "digest"> = {
      itemId: id, sourceSha: reviewHead,
      originalCommitSha: point?.commitSha ?? omission!.reviewHead, originalReviewDigest: original?.reviewDigest ??
        hash(point?.assurance),
      reviewerDigest: hash({ verdict, sessionDigest, source: reviewHead, item: id }),
      sessionFile, sessionDigest, verdict,
      status: verdict.verdict === "pass" ? "passed" : "failed",
      ...(verdict.verdict === "block" ? { findings: verdict.findings
        .filter(f => f.severity === "blocking")
        .map(f => ({ path: f.source.split(":")[0]!, kind: "continuity" as const,
          message: f.message })) } : {}),
    };
    const sealed: RevalidationReview = { ...r, digest: hash(r) };
    state.results.push(sealed);
    state.state = "admitted"; state.reviewing = undefined;
    await save(file, state);
    const projection = decideSelectiveRevalidation(plan, inventory, state.results,
      [...state.corrected ?? []].map(c => c.successorSha));
    if (projection.failures.length) {
      const failed = projection.failures.at(-1)!;
      if (omission || !point?.assurance) {
        state.state = "blocked";
        state.failure = "Independent revalidation rejected commitless evidence; an authorized owner amendment is required.";
        await save(file, state);
        throw Error(state.failure);
      }
      // One original specialist session may only repair paths it actually wrote.
      // Interactive Choice and Puzzle share the high-level Turn owner, but
      // never share an interchangeable writer transcript or file grant.
      const owners = originalPoints[id]!.filter(p => p.assurance &&
        failed.findings!.every(f => p.assurance!.changedPaths.includes(f.path)));
      let originalPoint = owners.length === 1 ? owners[0]! : null;
      let ownerPaths = originalPoint?.assurance?.changedPaths ?? [];
      let exactPaths = preciseCorrectivePaths(item, ownerPaths, verdict.findings);
      let ownerCanCorrect = !!originalPoint && exactPaths.length > 0 &&
        failed.findings!.every(f => exactPaths.includes(f.path));
      // A consumer can identify a defect in the *already authorized upstream
      // record*. Reuse the existing exact owner correction, never transfer
      // ownership to the consumer. Preserve both review obligations.
      let upstreamOwner:DependentCorrectionAssignment["upstreamOwner"];
      if(!ownerCanCorrect && !(state.corrected??[]).length &&
          failed.findings!.every(f=>plan.changedPaths.includes(f.path))) {
        const upstream=originalPoints[plan.upstreamItemId]?.filter(p=>
          p.commitSha===plan.rootUpstreamCommitSha && p.eligible && p.semanticReview==="passed" &&
          p.assurance && failed.findings!.every(f=>p.assurance!.changedPaths.includes(f.path)))??[];
        const affected=turn.assignments.find(a=>a.id===point.assurance!.assignmentId);
        const owner=upstream[0]?.assurance && turn.assignments.find(a=>a.id===upstream[0]!.assurance!.assignmentId);
        if(upstream.length===1 && affected && owner && reviewedSources[plan.upstreamItemId]?.status==="passed") {
          originalPoint=upstream[0]!;
          ownerPaths=originalPoint.assurance!.changedPaths;
          exactPaths=preciseCorrectivePaths(item,ownerPaths,verdict.findings);
          const catalog=await (await import("./validator.js")).historicalCanonicalCatalog(job,reviewHead);
          const actual=exactPaths.map(path=>catalog.find(record=>record.path===path));
          // No protected metadata, structural grants or another support path.
          ownerCanCorrect=exactPaths.length>0 && failed.findings!.every(f=>exactPaths.includes(f.path)) &&
            actual.every(record=>record && owner.authority.recordTypes.includes(record.metadata.type) &&
              !(Array.isArray(record.metadata.decisions)&&record.metadata.decisions.some(d=>d?.authority==="user-protected")));
          if(ownerCanCorrect)upstreamOwner={itemId:plan.upstreamItemId,
            affectedCommitSha:point.commitSha,affectedReviewDigest:sealed.originalReviewDigest,
            affectedAssignmentId:affected.id,affectedObligation:affected.outcome};
        }
      }
      const originalAssignment = turn.assignments.find(a =>
        a.id === (ownerCanCorrect?originalPoint!.assurance!.assignmentId:point.assurance!.assignmentId));
      if (!originalAssignment)
        throw Error("Dependent correction lost the original specialist goal.");
      if (ownerCanCorrect) {
        state.correctiveAssignment = proposeDependentCorrection({
          plan, item, originalCommitSha: originalPoint!.commitSha,
          assignmentId: originalPoint!.assurance!.assignmentId,
          specialist: originalPoint!.workItem.startsWith("interactive-puzzle-")
            ? "nt-puzzle-design" : originalAssignment.specialist,
          originalReviewDigest: upstreamOwner ? reviewedSources[upstreamOwner.itemId]!.reviewDigest :
            original?.reviewDigest ?? hash(point.assurance),
          ...(upstreamOwner?{upstreamOwner}:{}),
          revalidationReviewDigest: sealed.reviewerDigest, ownerPaths,
          blockingPaths: exactPaths, currentHeadSha: reviewHead,
          originalObligation: originalAssignment.outcome,
        });
      }
      await admitCausalRevalidationFinding(job, {
        turnDigest: correction.turnDigest,
        rootFailureSha: ownerCanCorrect ? originalPoint!.commitSha : point.commitSha,
        sourceSha: reviewHead, reviewDigest: sealed.reviewerDigest,
        assignmentId: ownerCanCorrect?originalPoint!.assurance!.assignmentId:point.assurance.assignmentId,
        obligation: upstreamOwner?originalAssignment.outcome:"Revalidate previously reviewed " + id + " after source-bound upstream correction.",
        causedBy: reviewHead,
        findings: failed.findings!.map(f => ({
          path: f.path, kind: f.kind, message: f.message,
          affectedPaths: ownerCanCorrect ? exactPaths : [f.path],
        })),
      });
      state.state = "blocked";
      state.failure = ownerCanCorrect
        ? "Previously reviewed " + id + " now fails the original obligation after " +
          "upstream correction. New causal Repair finding admitted. Original owner " +
          originalPoint!.assurance!.assignmentId + " may correct ONLY " + exactPaths.join(", ") +
          " through an authenticated bounded assignment; no blanket re-authoring."
        : "Previously reviewed " + id + " now fails at a path not owned by its original " +
          "specialist. Causal Repair finding recorded, but a separate controller-authorized " +
          "owner/dependency amendment is mandatory; reviewer prose grants no new files.";
      await save(file, state);
      if (!ownerCanCorrect) throw Error(state.failure);
      await finishOwnerCorrection();
    }
  }
  const verdicts = decideSelectiveRevalidation(plan, inventory, state.results,
    [...state.corrected ?? []].map(c => c.successorSha));
  if (verdicts.pending.length || verdicts.failures.length)
    throw Error("Downstream revalidation remains incomplete; do not resume dependent writing.");
  state.state = "completed";
  state.finalHead = await trustedHead(job);
  await save(file, state);
  return { plan, revalidated: verdicts.carriedForward, carriedForward: plan.unaffected };
}
