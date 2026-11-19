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
  return hash(raw);
}
function checkReview(job: JobStartResult, plan: SelectiveRevalidationPlan, review: RevalidationReview) {
  const { digest, ...body } = review;
  if (!DIGEST.test(digest) || hash(body) !== digest ||
      !DIGEST.test(review.originalReviewDigest) || !DIGEST.test(review.reviewerDigest) ||
      !SHA.test(review.originalCommitSha) ||
      review.sourceSha !== plan.successorSha ||
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
/** Recheck the durable independent verdicts whenever the original graph
 * resumes Composition. This is a read-only gate: saved model prose alone
 * cannot waive an unresolved dependent finding or missing session. */
export async function assertCompletedSelectiveRevalidation(
  job: JobStartResult, successorSha: string, turnDigest: string,
  correctionReviewDigest?: string,
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
  if (state.correctiveAssignment) {
    assertDependentCorrection(state.correctiveAssignment, state.proposal);
    throw Error("A pending dependent corrective assignment cannot be certified as completed.");
  }
  const expected = [...state.proposal.affected, ...state.proposal.unknown];
  if (new Set(expected).size !== expected.length || state.results.length !== expected.length ||
      new Set(state.results.map(r => r.itemId)).size !== expected.length ||
      state.results.some(r => !expected.includes(r.itemId) || r.status !== "passed"))
    throw Error("Revalidation cannot carry forward unreviewed, failed or duplicate dependent work.");
  for (const result of state.results) {
    checkReview(job, state.proposal, result);
    if (result.sessionDigest !== await transcript(job, result.sessionFile))
      throw Error("Dependent reviewer transcript no longer matches the sealed verdict.");
  }
  const ledger = await inspectRepairLedger(job, turnDigest);
  if (ledger.findings.some(f => f.causedBy === successorSha && f.status === "open"))
    throw Error("An unresolved causally linked downstream Repair finding blocks Composition.");
  return state.proposal;
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
}
/** Caller holds the existing single Story writer lock. The upstream commit
 * has ALREADY passed independent review and been published by its own owner.
 * This function only adds independent reviewer calls for affected dependents.
 */
export async function revalidateAfterReviewedCorrection(opts: RevalidateAfterCorrectionOptions) {
  const { job, inventory, correction } = opts;
  if (await trustedHead(job) !== correction.successorSha)
    throw Error("Selective revalidation needs the exact published, independently reviewed upstream HEAD.");
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
  const { plan, originalPoints, reviewedSources } =
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
  for (const result of state.results) {
    checkReview(job, plan, result);
    if (result.sessionDigest !== await transcript(job, result.sessionFile))
      throw Error("Prior independent revalidation transcript changed after review.");
    const point = originalPoints[result.itemId]?.at(-1);
    if (!point || result.originalCommitSha !== point.commitSha ||
        result.originalReviewDigest !== (reviewedSources[result.itemId]?.reviewDigest ??
          hash(point.assurance)))
      throw Error("Saved dependent verdict changed its original checkpoint evidence.");
  }
  if (state.correctiveAssignment) {
    assertDependentCorrection(state.correctiveAssignment, plan);
    const cited = state.results.find(r => r.itemId === state.correctiveAssignment!.itemId &&
      r.status === "failed");
    const point = originalPoints[state.correctiveAssignment.itemId]?.at(-1);
    if (!cited || cited.reviewerDigest !== state.correctiveAssignment.revalidationReviewDigest ||
        !point?.assurance ||
        state.correctiveAssignment.originalCommitSha !== point.commitSha ||
        state.correctiveAssignment.assignmentId !== point.assurance.assignmentId ||
        state.correctiveAssignment.originalReviewDigest !==
          (reviewedSources[state.correctiveAssignment.itemId]?.reviewDigest ??
            hash(point.assurance)) ||
        state.correctiveAssignment.authorizedPaths.some(p =>
          !point.assurance!.changedPaths.includes(p)))
      throw Error("Saved dependent correction changed its original owner or negative verdict.");
  }
  if (state.state === "reviewing")
    throw Error("Interrupted independent revalidation session requires transcript reconciliation; no replay.");
  if (state.state === "blocked")
    throw Error(state.failure ?? "A downstream reviewed obligation still requires correction.");
  if (state.state === "completed") {
    if (state.results.length !== wanted.length ||
        state.results.some(r => r.status !== "passed"))
      throw Error("Completed revalidation has unreviewed or failed dependents.");
    return { plan, revalidated: state.results.map(r => r.itemId), carriedForward: plan.unaffected };
  }
  const order = reviewOrder(inventory, wanted);
  for (const id of order) {
    if (state.results.some(r => r.itemId === id)) continue;
    const item = inventory.items.find(i => i.id === id);
    const points = originalPoints[id];
    if (!item || !points?.length)
      throw Error("Dependent revalidation cannot recover the original reviewed specialist assignment: " + id);
    const point = points.at(-1)!;
    const original = reviewedSources[id];
    const source = original?.sourcePaths ?? [];
    if (!point.assurance || !turn.assignments.some(a => a.id === point.assurance!.assignmentId))
      throw Error("Prior dependent reviewer has no original Turn-owned specialist assignment.");
    const relevant = [...new Set([...source, ...point.assurance.changedPaths,
      ...correction.changedPaths])].sort();
    if (relevant.length > 32)
      throw Error("Dependent revalidation exceeds bounded Story context.");
    const assignment: ReviewAssignment = {
      contract: opts.contract, planVersion: correction.planVersion,
      scopeIds: [...item.targetIds], paths: relevant,
      routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
      turnGoal: "REVALIDATE PREVIOUSLY REVIEWED " + id +
        " under the original author objective: " + turn.goal +
        ". Only this unit's original obligations and actual consumed premises; " +
        "later assignments remain outside this review.",
      specialistAssignments: [{
        id: point.assurance.assignmentId,
        specialist: turn.assignments.find(a => a.id === point.assurance!.assignmentId)!.specialist,
        outcome: "Revalidate the original reviewed " + point.workItem + " obligation.",
        targets: [...item.targetIds],
        authority: { recordTypes: [...point.assurance.changedRecordTypes],
          existingPaths: [...point.assurance.changedPaths], mayCreate: false },
      }],
      revalidation: { assignmentId: point.assurance.assignmentId,
        originalCommitSha: point.commitSha, correctedHeadSha: correction.successorSha,
        changedPaths: correction.changedPaths },
    };
    await preflightPiAssignment(job, "revalidate:" + correction.successorSha + ":" + id,
      { provider: opts.provider, model: opts.model });
    state.state = "reviewing"; state.reviewing = { itemId: id }; await save(file, state);
    const verdict = await reviewNarrative({ ...job, headSha: correction.successorSha },
      state.snapshot, assignment, opts.provider, opts.model, undefined,
      async sessionFile => { state!.reviewing = { itemId: id, sessionFile }; await save(file, state!); });
    const sessionFile = state.reviewing?.sessionFile;
    if (!sessionFile) throw Error("Dependent reviewer has no durable independent session.");
    const sessionDigest = await transcript(job, sessionFile);
    const r: Omit<RevalidationReview, "digest"> = {
      itemId: id, sourceSha: correction.successorSha,
      originalCommitSha: point.commitSha, originalReviewDigest: original?.reviewDigest ??
        hash(point.assurance),
      reviewerDigest: hash({ verdict, sessionDigest, source: correction.successorSha, item: id }),
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
    const projection = decideSelectiveRevalidation(plan, inventory, state.results);
    if (projection.failures.length) {
      const failed = projection.failures.at(-1)!;
      const ownerPaths = originalPoints[id]!.flatMap(p => p.assurance?.changedPaths ?? []);
      const exactPaths = preciseCorrectivePaths(item, ownerPaths, verdict.findings);
      const ownerCanCorrect = exactPaths.length > 0 &&
        failed.findings!.every(f => exactPaths.includes(f.path));
      const originalAssignment = turn.assignments.find(a =>
        a.id === point.assurance!.assignmentId);
      if (!originalAssignment)
        throw Error("Dependent correction lost the original specialist goal.");
      if (ownerCanCorrect) {
        state.correctiveAssignment = proposeDependentCorrection({
          plan, item, originalCommitSha: point.commitSha,
          assignmentId: point.assurance.assignmentId,
          specialist: originalAssignment.specialist,
          originalReviewDigest: original?.reviewDigest ?? hash(point.assurance),
          revalidationReviewDigest: sealed.reviewerDigest, ownerPaths,
          blockingPaths: exactPaths, originalObligation: originalAssignment.outcome,
        });
      }
      await admitCausalRevalidationFinding(job, {
        turnDigest: correction.turnDigest,
        rootFailureSha: point.commitSha,
        sourceSha: correction.successorSha, reviewDigest: sealed.reviewerDigest,
        assignmentId: point.assurance.assignmentId,
        obligation: "Revalidate previously reviewed " + id + " after source-bound upstream correction.",
        causedBy: correction.successorSha,
        findings: failed.findings!.map(f => ({
          path: f.path, kind: f.kind, message: f.message,
          affectedPaths: ownerCanCorrect ? exactPaths : [f.path],
        })),
      });
      state.state = "blocked";
      state.failure = ownerCanCorrect
        ? "Previously reviewed " + id + " now fails the original obligation after " +
          "upstream correction. New causal Repair finding admitted. Original owner " +
          point.assurance.assignmentId + " may correct ONLY " + exactPaths.join(", ") +
          " through an authenticated bounded assignment; no blanket re-authoring."
        : "Previously reviewed " + id + " now fails at a path not owned by its original " +
          "specialist. Causal Repair finding recorded, but a separate controller-authorized " +
          "owner/dependency amendment is mandatory; reviewer prose grants no new files.";
      await save(file, state);
      throw Error(state.failure);
    }
  }
  const verdicts = decideSelectiveRevalidation(plan, inventory, state.results);
  if (verdicts.pending.length || verdicts.failures.length)
    throw Error("Downstream revalidation remains incomplete; do not resume dependent writing.");
  state.state = "completed"; await save(file, state);
  return { plan, revalidated: verdicts.carriedForward, carriedForward: plan.unaffected };
}
