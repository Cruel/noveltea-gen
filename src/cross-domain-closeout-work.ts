/** Source-bound, crash-fenced prerequisite correction between Interactive and
 * Composition. The writer receives ONLY a previously authenticated Event-owned
 * Milestone field grant. A separate independent review must pass before the
 * new Git HEAD is marked verified or any downstream writer may see it.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "./git-read-cache.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";
import { validateStoryJob } from "./validator.js";
import { assertMilestoneFulfillmentOnly } from "./milestone-field-scope.js";
import { preflightCompositionBoundary, type CompositionBoundaryDecision,
  type CompositionBoundaryRequest } from "./cross-domain-prerequisite-controller.js";
import { authorMilestoneCloseout } from "./cross-domain-closeout-specialist.js";
import { admitPrerequisiteRepair, submitPrerequisiteRepair, settlePrerequisiteRepair,
  inspectRepairLedger } from "./repair-ledger.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { reviewNarrative, checkEditorialVerdict,
  type EditorialVerdict, type ReviewAssignment } from "./narrative-review-specialist.js";
import { parseSpecialistJson } from "./composition-specialist.js";
import { repairProgressScope, productiveEditorialRepair } from "./editorial-repair-progress.js";
import { validCloseoutProposal, retryCloseoutProposal, closeoutReviewMayRetry,
  type CloseoutProposal } from "./cross-domain-prerequisite.js";
import type { CompletionContract } from "./architecture.js";
import type { GenerationInventory } from "./generation-plan.js";
import { revalidateAfterReviewedCorrection } from "./selective-revalidation-work.js";
import { originalInventorySnapshotDigest } from "./selective-revalidation.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sha = /^[a-f0-9]{40}$/;
interface RejectedCloseout {
  proposal: CloseoutProposal;
  commitSha: string;
  reviewDigest: string;
  review: EditorialVerdict;
  writerSessionDigest: string;
  reviewerSessionDigest: string;
  writerSessionFile: string;
  reviewerSessionFile: string;
  reviewSnapshot: SkillSnapshot;
  feedback: string;
}
interface Receipt {
  version: 1; jobId: string; threadId: string; baseSha: string;
  workItemId: string; turnDigest: string; repairId: string;
  proposal: CloseoutProposal;
  phase: "ready" | "retry-ready" | "writing" | "authored" | "committed" | "reviewing" | "reviewed" | "verified" | "blocked";
  worker: "pi"; provider: string; model: string;
  snapshot?: SkillSnapshot; reviewSnapshot?: SkillSnapshot;
  sessionFile?: string; reviewerSessionFile?: string;
  writerSessionDigest?: string; reviewerSessionDigest?: string;
  evidence?: string[]; authoredDigest?: string; commitSha?: string;
  validation?: { status: "passed"; sourceSha: string; validatorVersion: string };
  review?: EditorialVerdict; reviewDigest?: string; failure?: string;
  history?: RejectedCloseout[];
  originalInventoryDigest?: string;
  retry?: { sourceSession: string; feedback: string };
}
export interface CloseoutRunRequest extends CompositionBoundaryRequest {
  story: string; job: string; milestoneId: string; planVersion: number;
  provider?: string; model?: string;
  /** Original controller inventory before the repair, checkpointed by the
   * same generation graph. No independent dependency DAG is created. */
  originalInventory?: GenerationInventory;
  /** Pinned by the graph preflight; an interrupted proposal is not a lease. */
  expected?: { sourceSha: string; proposalDigest: string; repairId: string };
}
function gitRaw(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
}
const git = (job: JobStartResult, ...args: string[]) => gitRaw(job, ...args).trim();
const repoPath = (job: JobStartResult, path: string) =>
  (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path;
const fileOf = (job: JobStartResult, milestone: string) =>
  join(job.stateDir, "prerequisite-items", milestone.slice("milestone.".length) + ".json");
async function persist(path: string, data: Receipt) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
async function checkedSessionDigest(job: JobStartResult, file: string | undefined,
  folder: "prerequisite-sessions" | "review-sessions") {
  const directory = join(job.stateDir, folder) + sep;
  if (!file?.startsWith(directory) || !existsSync(file))
    throw Error("Original Pi author/reviewer session is missing or outside its private scope.");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 50 ||
      await realpath(file) !== file)
    throw Error("Original Pi author/reviewer transcript is missing or unsafe.");
  const content = await readFile(file, "utf8");
  const first = JSON.parse(content.split("\n")[0]!) as { type?: string; id?: string };
  if (first.type !== "session" || !first.id?.trim())
    throw Error("Original Pi transcript has no authentic durable session header.");
  return hash(content);
}
/** #211 upgrade recovery: the old reviewed-phase digest did not seal the
 * progress diagnosis. Never use that unsealed field to authorize a retry.
 * Reauthenticate the original settled Pi transcript and source-grounded
 * verdict, without opening a model session or replaying a writer. The old
 * digest remains stable for already-submitted repair ledger attempts. */
export async function verifyLegacyCloseoutReviewTranscript(
  job: JobStartResult, file: string, expectedDigest: string,
  review: EditorialVerdict, assignment: ReviewAssignment,
) {
  if (await checkedSessionDigest(job, file, "review-sessions") !== expectedDigest)
    throw Error("Legacy closeout requires its unchanged original reviewer transcript.");
  const stat = await lstat(file);
  if (stat.size > 16 * 1024 * 1024)
    throw Error("Legacy closeout reviewer transcript exceeds its bounded proof.");
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  let records: Array<{ type?: string; id?: string;
    message?: { role?: string; stopReason?: string;
      content?: Array<{ type?: string; text?: string }> } }>;
  try { records = lines.map(line => JSON.parse(line)); }
  catch { throw Error("Legacy closeout reviewer transcript contains malformed history."); }
  if (records[0]?.type !== "session" || !records[0].id)
    throw Error("Legacy closeout reviewer transcript lost its original Pi session identity.");
  const answers = records.filter(r => r.type === "message" &&
    r.message?.role === "assistant" && r.message.stopReason === "stop" &&
    Array.isArray(r.message.content)).map(r =>
    r.message!.content!.filter(c => c.type === "text")
      .map(c => c.text ?? "").join("\n"));
  if (!answers.length) throw Error("Legacy closeout transcript has no completed independent verdict.");
  const recovered = checkEditorialVerdict(parseSpecialistJson(answers.at(-1)!), assignment);
  if (!isDeepStrictEqual({
    verdict: recovered.verdict, findings: recovered.findings,
    evidence: recovered.evidence, progressDiagnosis: recovered.progressDiagnosis,
  }, {
    verdict: review.verdict, findings: review.findings,
    evidence: review.evidence, progressDiagnosis: review.progressDiagnosis,
  })) throw Error("Legacy closeout diagnosis differs from the pinned independent reviewer transcript.");
}

async function load(file: string): Promise<Receipt | null> {
  if (!existsSync(file)) return null;
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000)
    throw Error("Unsafe cross-domain dependency receipt.");
  return JSON.parse(await readFile(file, "utf8")) as Receipt;
}
async function assertOnlyOwnedEdit(job: JobStartResult, proposal: CloseoutProposal) {
  const expected = repoPath(job, proposal.allowedPaths[0]!);
  const entries = gitRaw(job, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n").filter(Boolean);
  if (entries.length !== 1 || entries[0] !== " M " + expected)
    throw Error("Cross-domain specialist changed files outside its one owned Milestone.");
  const target = join(job.worktreeStoryRoot, proposal.allowedPaths[0]!);
  if ((await realpath(target)) !== target || !(await lstat(target)).isFile())
    throw Error("Unsafe Milestone closeout target.");
  assertMilestoneFulfillmentOnly(gitRaw(job, "show", proposal.sourceSha + ":" + expected),
    await readFile(target, "utf8"));
}
async function validateCloseoutDraft(job: JobStartResult, request: CloseoutRunRequest,
  proposal: CloseoutProposal, committed = false) {
  // A recovered original Git commit has no dirty draft. Its exact path and
  // allowed fields were authenticated by inspectPublishedCloseoutCommit.
  if (!committed) await assertOnlyOwnedEdit(job, proposal);
  const outcome = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: proposal.sourceSha });
  const report = outcome.report as { diagnostics?: Array<{ path: string; code: string; message: string }>;
    protection?: { status: string; base: string; changes: unknown[]; warnings: unknown[] };
    records?: Array<{ path: string; metadata: { id: string; completeness?: string; fulfillment?: {
      any_of?: string[][] } } }>;
    coverage?: { milestoneRoutes: Array<{ id: string; routes: Array<{ status: string }> }>;
      search?: { truncated?: boolean } } } | undefined;
  if (outcome.status !== "passed" || !report || report.diagnostics?.length ||
      report.protection?.status !== "checked" || report.protection.base !== proposal.sourceSha ||
      report.protection.changes.length || report.protection.warnings.length ||
      report.coverage?.search?.truncated ||
      !report.records?.some(r => r.path === proposal.allowedPaths[0] &&
        r.metadata.id === proposal.milestoneId && r.metadata.completeness === "complete" &&
        Array.isArray(r.metadata.fulfillment?.any_of) && r.metadata.fulfillment.any_of.length > 0) ||
      !report.coverage?.milestoneRoutes.find(m => m.id === proposal.milestoneId)?.routes.some(r =>
        r.status === "reachable"))
    throw Error("Milestone closeout is not canonically valid, complete and reachable.");
  return { report, outcome };
}
/** Recover the exact crash window after Git committed the already-authored
 * Milestone but before the closeout receipt recorded its commit SHA.
 *
 * This is read-only and deliberately cannot discover/authorize a successor
 * from a plausible trailer alone. It requires the previously persisted
 * authored bytes, original writer session digest and single permitted field
 * change. Review/repair-ledger settlement still happens in the normal
 * `committed` branch and is never inferred here.
 */
export async function inspectPublishedCloseoutCommit(job: JobStartResult,
  state: Pick<Receipt, "phase" | "proposal" | "workItemId" | "jobId" |
    "authoredDigest" | "writerSessionDigest" | "sessionFile">): Promise<string> {
  const proposal = state.proposal;
  if (state.phase !== "authored" || !validCloseoutProposal(proposal) ||
      state.jobId !== job.jobId || !state.authoredDigest ||
      !state.writerSessionDigest || !state.sessionFile ||
      state.writerSessionDigest !== await checkedSessionDigest(job,
        state.sessionFile, "prerequisite-sessions"))
    throw Error("Unpublished closeout lacks its original settled writer receipt.");
  const head = git(job, "rev-parse", "HEAD");
  const target = repoPath(job, proposal.allowedPaths[0]!);
  if (gitRaw(job, "status", "--porcelain=v1", "--untracked-files=all") ||
      git(job, "rev-parse", head + "^") !== proposal.sourceSha ||
      git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", head) !== target)
    throw Error("Published closeout differs from its exact original parent or bounded file inventory.");
  const trailers = git(job, "log", "-1", "--format=%B").split("\n");
  if (![ "NovelTea-Job: " + job.jobId,
        "NovelTea-Work-Item: " + state.workItemId,
        "NovelTea-Plan-Version: " + proposal.planVersion,
        "NovelTea-Prerequisite: " + proposal.digest ].every(t => trailers.includes(t)) ||
      state.authoredDigest !== hash(gitRaw(job, "show", head + ":" + target)))
    throw Error("Published closeout lacks its original signed source or authored bytes.");
  assertMilestoneFulfillmentOnly(gitRaw(job, "show", proposal.sourceSha + ":" + target),
    gitRaw(job, "show", head + ":" + target));
  return head;
}

/** Authenticate an unpublished original Event-owned commit for its SELECTED
 * generation recovery case. This only permits the existing adapter to resume
 * its independent review; it does not promote the commit to trustedHead.
 * Only the first original closeout is eligible here: subsequent negative
 * review retries have distinct source/ledger lineage handled separately. */
export async function inspectInterruptedCloseoutCommit(job: JobStartResult,
  expected: { milestoneId: string; planVersion: number; sourceSha: string;
    proposalDigest: string; repairId: string; originalInventoryDigest: string },
): Promise<string> {
  const state = await load(fileOf(job, expected.milestoneId));
  if (!state || !["authored", "committed"].includes(state.phase) ||
      state.version !== 1 || state.jobId !== job.jobId ||
      state.threadId !== job.threadId || state.baseSha !== job.baseSha ||
      state.worker !== "pi" || state.history?.length ||
      state.workItemId !== "prerequisite-" + expected.milestoneId.slice(10) ||
      state.proposal.milestoneId !== expected.milestoneId ||
      state.proposal.planVersion !== expected.planVersion ||
      state.proposal.sourceSha !== expected.sourceSha ||
      state.proposal.digest !== expected.proposalDigest ||
      state.repairId !== expected.repairId ||
      state.originalInventoryDigest !== expected.originalInventoryDigest)
    throw Error("Interrupted closeout is not the selected original recovery operation.");
  const verified = JSON.parse(await readFile(join(job.stateDir, "revisions", "verified-head.json"), "utf8")) as {
    version?: number; jobId?: string; headSha?: string };
  if (verified.version !== 1 || verified.jobId !== job.jobId ||
      verified.headSha !== expected.sourceSha)
    throw Error("Unpublished closeout lost its prior independently verified source.");
  let head: string;
  if (state.phase === "authored") {
    head = await inspectPublishedCloseoutCommit(job, state);
  } else {
    if (!state.commitSha || !state.writerSessionDigest ||
        state.writerSessionDigest !== await checkedSessionDigest(job,
          state.sessionFile, "prerequisite-sessions") ||
        state.validation?.status !== "passed" ||
        state.validation.sourceSha !== expected.sourceSha ||
        state.validation.validatorVersion !== job.validatorVersion ||
        gitRaw(job, "status", "--porcelain=v1", "--untracked-files=all"))
      throw Error("Interrupted committed closeout lost its native validation or writer proof.");
    verifyCommitted(job, state);
    head = state.commitSha;
  }
  if (head === expected.sourceSha || git(job, "rev-parse", "HEAD") !== head)
    throw Error("Interrupted closeout did not publish its exact original Git successor.");
  return head;
}

function verifyCommitted(job: JobStartResult, state: Receipt) {
  if (!state.commitSha || !sha.test(state.commitSha) ||
      git(job, "rev-parse", state.commitSha + "^") !== state.proposal.sourceSha ||
      git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", state.commitSha) !==
        repoPath(job, state.proposal.allowedPaths[0]!) ||
      !state.authoredDigest)
    throw Error("Closeout successor has an unverified Git parent or file inventory.");
  const lines = git(job, "log", "-1", "--format=%B", state.commitSha).split("\n");
  if (![ "NovelTea-Job: " + job.jobId, "NovelTea-Work-Item: " + state.workItemId,
    "NovelTea-Plan-Version: " + state.proposal.planVersion,
    "NovelTea-Prerequisite: " + state.proposal.digest ].every(s => lines.includes(s)) ||
      !state.authoredDigest ||
      hash(gitRaw(job, "show", state.commitSha + ":" + repoPath(job, state.proposal.allowedPaths[0]!))) !==
        state.authoredDigest)
    throw Error("Closeout successor lacks exact source-bound field-only provenance.");
  // The field-only restriction is enforced on committed blobs as well as
  // uncommitted drafts, not just a now-mutable receipt assertion.
  assertMilestoneFulfillmentOnly(
    gitRaw(job, "show", state.proposal.sourceSha + ":" + repoPath(job, state.proposal.allowedPaths[0]!)),
    gitRaw(job, "show", state.commitSha + ":" + repoPath(job, state.proposal.allowedPaths[0]!)));
}
/** New receipts include the progress diagnosis that determines retry
 * authority. Pre-diagnosis receipts retain their original digest unchanged. */
export function closeoutReviewDigest(input: {
  reviewerSessionDigest: string; proposal: string; commitSha: string;
  review: EditorialVerdict;
}, includeDiagnosis = true) {
  return hash(JSON.stringify({
    reviewerSessionDigest: input.reviewerSessionDigest,
    proposal: input.proposal, commitSha: input.commitSha,
    verdict: input.review.verdict, findings: input.review.findings,
    evidence: input.review.evidence,
    ...(includeDiagnosis && input.review.progressDiagnosis !== undefined ?
      { progressDiagnosis: input.review.progressDiagnosis } : {}),
  }));
}
/** A failed independent review never becomes a trusted positive checkpoint.
 * It can occur inside a later successful dependency repair chain only after
 * each source, field-only diff and negative reviewer is reauthenticated. */
async function verifyRejectedChain(job: JobStartResult, state: Receipt) {
  const history = state.history ?? [];
  if (!history.length) return;
  const ledger = await inspectRepairLedger(job, state.turnDigest);
  let parent = history[0]!.proposal.sourceSha;
  for (const entry of history) {
    if (!validCloseoutProposal(entry.proposal) || entry.proposal.sourceSha !== parent ||
        !sha.test(entry.commitSha) ||
        git(job, "rev-parse", entry.commitSha + "^") !== parent ||
        git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", entry.commitSha) !==
          repoPath(job, entry.proposal.allowedPaths[0]!) ||
        !git(job, "log", "-1", "--format=%B", entry.commitSha).split("\n")
          .includes("NovelTea-Prerequisite: " + entry.proposal.digest) ||
        entry.review.verdict !== "block" ||
        // Historical negative rounds could be sealed before progressDiagnosis
        // entered the digest. Retain their independent negative verdict and
        // ledger admission; only NEW reviewed rounds may authorize retries.
        (entry.reviewDigest !== closeoutReviewDigest({
          reviewerSessionDigest: entry.reviewerSessionDigest,
          proposal: entry.proposal.digest, commitSha: entry.commitSha,
          review: entry.review }) &&
          entry.reviewDigest !== closeoutReviewDigest({
            reviewerSessionDigest: entry.reviewerSessionDigest,
            proposal: entry.proposal.digest, commitSha: entry.commitSha,
            review: entry.review }, false)) ||
        entry.writerSessionDigest !== await checkedSessionDigest(job,
          entry.writerSessionFile, "prerequisite-sessions") ||
        entry.reviewerSessionDigest !== await checkedSessionDigest(job,
          entry.reviewerSessionFile, "review-sessions") ||
        await openSkillSnapshot(entry.reviewSnapshot.id) !== entry.reviewSnapshot.path ||
        !ledger.prerequisites?.some(p => p.id === state.repairId && p.attempts.some(a =>
          a.sourceSha === parent && a.submittedSha === entry.commitSha &&
          a.verdict === "failed" && a.reviewDigest === entry.reviewDigest)))
      throw Error("Rejected prerequisite ancestor lost its original independent negative review.");
    assertMilestoneFulfillmentOnly(gitRaw(job, "show", parent + ":" +
      repoPath(job, entry.proposal.allowedPaths[0]!)),
      gitRaw(job, "show", entry.commitSha + ":" +
        repoPath(job, entry.proposal.allowedPaths[0]!)));
    parent = entry.commitSha;
  }
  if (state.proposal.sourceSha !== parent)
    throw Error("Current closeout does not descend directly from its reviewed failed source.");
  const trusted = JSON.parse(await readFile(join(job.stateDir, "revisions",
    "verified-head.json"), "utf8")) as { version?: number; jobId?: string; headSha?: string };
  if (trusted.version !== 1 || trusted.jobId !== job.jobId ||
      !sha.test(trusted.headSha ?? ""))
    throw Error("Original verified Story boundary changed beneath failed corrections.");
  if (![history[0]!.proposal.sourceSha, state.commitSha].includes(trusted.headSha)) {
    if (state.phase !== "verified" || !state.commitSha)
      throw Error("Original verified Story boundary changed beneath failed corrections.");
    const { verifiedNarrativeChain } = await import("./job-successor.js");
    await verifiedNarrativeChain(job, state.commitSha, trusted.headSha!);
  }
}
async function publish(job: JobStartResult, state: Receipt) {
  await verifyRejectedChain(job, state);
  if (!state.commitSha || state.phase !== "verified") throw Error("Cannot publish unreviewed dependency.");
  verifyCommitted(job, state);
  const file = join(job.stateDir, "revisions", "verified-head.json");
  if (existsSync(file)) {
    const previous = JSON.parse(await readFile(file, "utf8")) as {
      version: number; jobId: string; headSha: string };
    if (previous.version !== 1 || previous.jobId !== job.jobId)
      throw Error("Another verified Story boundary moved during dependency publication.");
    if (previous.headSha === state.commitSha) return;
    if (previous.headSha !== (state.history?.[0]?.proposal.sourceSha ?? state.proposal.sourceSha)) {
      // Post-closeout correction descendants are already separately reviewed.
      // Never overwrite a later verified head with the earlier prerequisite.
      const { verifiedNarrativeChain } = await import("./job-successor.js");
      await verifiedNarrativeChain(job, state.commitSha!, previous.headSha);
      return;
    }
  }
  const tmp = file + "." + randomUUID() + ".tmp";
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(tmp, JSON.stringify({ version: 1, jobId: job.jobId,
    headSha: state.commitSha, workItemId: state.workItemId }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  await rename(tmp, file);
}
async function reviewerAssignment(job: JobStartResult, request: CloseoutRunRequest,
  proposal: CloseoutProposal, commitSha: string): Promise<ReviewAssignment> {
  const slug = proposal.milestoneId.slice(10);
  const event = JSON.parse(await readFile(join(job.stateDir, "event-items", slug + ".json"), "utf8")) as {
    paths?: string[]; assignment?: { sourcePaths?: string[] }; validation?: { eventIds?: string[] } };
  const interactive = JSON.parse(await readFile(join(job.stateDir, "interactive-items", slug + ".json"), "utf8")) as {
    units?: Array<{ paths?: string[] }> };
  const source = [...new Set([proposal.allowedPaths[0]!,
    ...(event.paths ?? []), ...(event.assignment?.sourcePaths ?? []),
    ...(interactive.units ?? []).flatMap(u => u.paths ?? [])])].sort();
  const checked = await validateStoryJob(job, request.validatorSource ?? request.skillsSource,
    { ...job, baseSha: proposal.sourceSha });
  const report = checked.report as { coverage: { branchProgress: Array<{
    event: string; step: string; branch: string; status: string; witness?: string[] }>;
    milestoneRoutes: Array<{ id: string; routes: Array<{
      status: string; witness?: string[] }> }> } };
  // The Choice specialist may enact consequences in newly authored Event
  // records. The original Event receipt is deliberately immutable and cannot
  // list those later Events, so derive review scope from the actual inspected
  // canonical source inventory rather than that original receipt alone.
  const events = new Set([...event.validation?.eventIds ?? [],
    ...((checked.report as { records?: Array<{ path: string; metadata?: {
      type?: string; id?: string } }> }).records ?? [])
      .filter(record => source.includes(record.path) && record.metadata?.type === "event")
      .map(record => record.metadata!.id!)]);
  const routes = report.coverage.branchProgress.filter(r => events.has(r.event))
    .map(r => ({ event: r.event, step: r.step, branch: r.branch,
      status: r.status, witness: r.witness ?? [] }));
  const milestoneRoutes = (report.coverage.milestoneRoutes.find(m =>
    m.id === proposal.milestoneId)?.routes ?? []).map((r, alternative) => ({
      milestone: proposal.milestoneId, alternative, status: r.status, witness: r.witness ?? [],
    }));
  return {
    contract: request.contract, planVersion: proposal.planVersion,
    scopeIds: [proposal.milestoneId], paths: source, routes, milestoneRoutes,
    puzzleRoutes: [], outstanding: [], uncertainties: [],
    turnGoal: "INDEPENDENT CROSS-DOMAIN CLOSEOUT REVIEW. The Event specialist's ONLY " +
      "authorized correction is completeness/fulfillment on " + proposal.allowedPaths[0] + ". " +
      "Check the original author Milestone change, every material Event/Choice outcome and " +
      "its reachable and playable source-linked evidence. A reachable ID alone does not " +
      "prove every semantic clause. Reject a false completed Milestone, missing supporting " +
      "Event or protected-authority violation. The downstream Composition is not yet written.",
    specialistAssignments: [{ id: "prerequisite:" + proposal.milestoneId,
      specialist: "nt-event-design",
      outcome: "Certify the original Milestone only if existing authored Event/Choice routes " +
        "actually fulfill it without a protected Story change.",
      targets: [proposal.milestoneId],
      authority: { recordTypes: ["milestone"], existingPaths: proposal.allowedPaths,
        mayCreate: false } }],
    dependency: { sourceSha: proposal.sourceSha, commitSha,
      obligation: "Real Milestone closeout before " + proposal.blocks[0],
      reason: "The original reviewed Event left this Milestone partial pending Choice.",
      sources: [{ path: proposal.allowedPaths[0]!,
        quote: "Original Milestone completeness and fulfillment are partial/unbound." }],
      diff: git(job, "diff", "--no-ext-diff", proposal.sourceSha, commitSha,
        "--", repoPath(job, proposal.allowedPaths[0]!)) },
  };
}
/** Invoked only from the production graph's separate dependency node. */
export async function advanceCrossDomainCloseout(request: CloseoutRunRequest) {
  const job = await startStoryJob({ story: request.story, job: request.job }, false);
  return withStoryJobLock(job, "cross-domain-closeout-" + request.milestoneId.slice(10), async () => {
    const file = fileOf(job, request.milestoneId);
    let state = await load(file);
    if (!state) {
      if (!request.originalInventory || !request.originalInventory.items.length)
        throw Error("Reviewed upstream correction requires the original controller work inventory.");
      const boundary = await preflightCompositionBoundary(job, request,
        request.milestoneId, request.planVersion);
      if (boundary.kind !== "repair")
        throw Error("No authenticated unmet cross-domain prerequisite: " +
          (boundary.kind === "ready" ? "Milestone is already complete" : boundary.reason));
      if (request.expected && (request.expected.sourceSha !== boundary.proposal.sourceSha ||
          request.expected.proposalDigest !== boundary.proposal.digest || request.expected.repairId !== boundary.repairId))
        throw Error("Current prerequisite differs from the checkpointed controller decision.");
      if (request.originalInventory.headSha !== boundary.proposal.sourceSha ||
          request.originalInventory.planVersion !== request.planVersion ||
          !request.originalInventory.items.some(item =>
            item.id === "event:" + request.milestoneId &&
            item.status === "verified" &&
            item.verifiedSha === boundary.proposal.sourceEventSha))
        throw Error("Cross-domain revalidation cannot replace a reviewed original Event work item.");
      await preflightPiAssignment(job, "prerequisite:" + request.milestoneId, {
        provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
      });
      state = {
        version: 1, jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
        workItemId: "prerequisite-" + request.milestoneId.slice(10),
        turnDigest: boundary.turnDigest, repairId: boundary.repairId,
        proposal: boundary.proposal, phase: "ready", worker: "pi",
        originalInventoryDigest: originalInventorySnapshotDigest(request.originalInventory),
        provider: request.provider ?? "openai", model: request.model ?? "gpt-6-luna",
      };
      await persist(file, state);
    }
    if (!request.originalInventory || state.originalInventoryDigest !==
        originalInventorySnapshotDigest(request.originalInventory))
      throw Error("Upstream corrective work lost the original pinned dependent inventory.");
    if (!validCloseoutProposal(state.proposal) ||
        state.version !== 1 || state.jobId !== job.jobId ||
        state.threadId !== job.threadId || state.baseSha !== job.baseSha ||
        state.proposal.milestoneId !== request.milestoneId ||
        state.proposal.planVersion !== request.planVersion ||
        state.worker !== "pi" || state.provider !== (request.provider ?? "openai") ||
        state.model !== (request.model ?? "gpt-6-luna") ||
        (request.expected && (
          (state.history?.[0]?.proposal.sourceSha ?? state.proposal.sourceSha) !== request.expected.sourceSha ||
          (state.history?.[0]?.proposal.digest ?? state.proposal.digest) !== request.expected.proposalDigest ||
          state.repairId !== request.expected.repairId)))
      throw Error("Closeout resumed with a stale original Turn, provider or source.");
    if (state.phase === "blocked" || state.phase === "writing" ||
        state.phase === "reviewing")
      throw Error("Interrupted or rejected closeout must be reconciled at its preserved " +
        "original specialist/reviewer session, never replayed.");
    // Every round changes the authenticated source and proposal. Repeating an
    // identical controller transition is a recovery error, not semantic
    // stagnation or a reason to impose an arbitrary correction count.
    const traversed = new Set<string>();
    for (;;) {
    const proposal = state.proposal;
    const transition = state.phase + ":" + proposal.digest;
    if (traversed.has(transition))
      throw Error("Prerequisite correction repeated an unchanged controller transition.");
    traversed.add(transition);
    const head = git(job, "rev-parse", "HEAD");
    if (state.phase === "ready" || state.phase === "retry-ready") {
      const first = state.phase === "ready";
      if (first) {
        const checked = await preflightCompositionBoundary(job, request,
          request.milestoneId, request.planVersion);
        if (checked.kind !== "repair" || checked.proposal.digest !== proposal.digest ||
            checked.repairId !== state.repairId || checked.turnDigest !== state.turnDigest)
          throw Error("Pending cross-domain repair lost its exact current-HEAD/Turn authority.");
      } else await verifyRejectedChain(job, state);
      if (head !== proposal.sourceSha || first && await trustedHead(job) !== proposal.sourceSha ||
          gitRaw(job, "status", "--porcelain=v1", "--untracked-files=all"))
        throw Error("Closeout writer cannot start on moved HEAD or dirty source.");
      const event = JSON.parse(await readFile(join(job.stateDir, "event-items",
        request.milestoneId.slice(10) + ".json"), "utf8")) as {
        snapshot?: SkillSnapshot; assignment?: { sourcePaths?: string[] } };
      if (!event.snapshot || await openSkillSnapshot(event.snapshot.id) !== event.snapshot.path)
        throw Error("Original Event specialist snapshot is unavailable or unpinned.");
      state.snapshot = event.snapshot;
      const interactive = JSON.parse(await readFile(join(job.stateDir, "interactive-items",
        request.milestoneId.slice(10) + ".json"), "utf8")) as {
          units?: Array<{ paths?: string[] }> };
      const sources = [...new Set([proposal.allowedPaths[0]!,
        ...(event.assignment?.sourcePaths ?? []),
        ...(interactive.units ?? []).flatMap(unit => unit.paths ?? [])])];
      if (sources.some(p => !/^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(p)))
        throw Error("Closeout read-only source manifest contains unsafe Story paths.");
      state.phase = "writing"; await persist(file, state);
      const audit = async () => {
        try {
          await validateCloseoutDraft(job, request, proposal); return [];
        } catch (error) {
          const message = String(error);
          if (/Cross-domain specialist changed files outside|Unsafe Milestone|changed unrelated frontmatter|protected decisions or body/.test(message))
            throw error; // A scope violation is never a repairable model feedback loop.
          return [message];
        }
      };
      try {
        const evidence = await authorMilestoneCloseout(job, state.snapshot,
          proposal, sources, state.provider, state.model,
          async sessionFile => { state!.sessionFile = sessionFile; await persist(file, state!); },
          audit, state.retry);
        await validateCloseoutDraft(job, request, proposal);
        state.evidence = evidence.evidence;
        state.writerSessionDigest = await checkedSessionDigest(job, state.sessionFile,
          "prerequisite-sessions");
        state.authoredDigest = hash(await readFile(join(job.worktreeStoryRoot,
          proposal.allowedPaths[0]!), "utf8"));
        state.phase = "authored"; await persist(file, state);
      } catch (error) {
        state.failure = String(error); await persist(file, state);
        throw error;
      }
    }
    if (state.phase === "authored") {
      // If the authored commit already exists, reauthenticate it and resume
      // the original independent reviewer. Never invoke or commit the writer
      // twice merely because the parent receipt wasn't published yet.
      if (git(job, "rev-parse", "HEAD") !== proposal.sourceSha) {
        state.commitSha = await inspectPublishedCloseoutCommit(job, state);
        await validateCloseoutDraft(job, request, proposal, true);
      } else {
        if (!(state.history?.length) && await trustedHead(job) !== proposal.sourceSha)
          throw Error("Authored closeout changed its verified source before commit.");
        await validateCloseoutDraft(job, request, proposal);
        if (state.authoredDigest !== hash(await readFile(join(job.worktreeStoryRoot,
          proposal.allowedPaths[0]!), "utf8")))
          throw Error("Milestone closeout draft changed after specialist submission.");
        git(job, "add", "--", repoPath(job, proposal.allowedPaths[0]!));
        git(job, "-c", "user.name=NovelTea Generator",
          "-c", "user.email=noveltea-gen@users.noreply.github.com",
          "commit", "-m", "Close out " + proposal.milestoneId + " [" + job.jobId + "]\n\n" +
            "NovelTea-Job: " + job.jobId + "\n" +
            "NovelTea-Work-Item: " + state.workItemId + "\n" +
            "NovelTea-Plan-Version: " + proposal.planVersion + "\n" +
            "NovelTea-Prerequisite: " + proposal.digest);
        state.commitSha = git(job, "rev-parse", "HEAD");
      }
      state.validation = { status: "passed", sourceSha: proposal.sourceSha,
        validatorVersion: job.validatorVersion };
      state.phase = "committed";
      await persist(file, state);
    }
    if (state.phase === "committed") {
      verifyCommitted(job, state);
      if (git(job, "rev-parse", "HEAD") !== state.commitSha ||
          gitRaw(job, "status", "--porcelain=v1", "--untracked-files=all"))
        throw Error("Committed closeout cannot be reviewed against moved or dirty HEAD.");
      await submitPrerequisiteRepair(job, { turnDigest: state.turnDigest,
        id: state.repairId, sourceSha: proposal.sourceSha,
        submittedSha: state.commitSha!, paths: proposal.allowedPaths });
      const config = request.skillsSource
        ? { discovery: "explicit-only" as const, novelteaSkills: request.skillsSource,
          skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] }
        : { ...(await loadSkillConfig(undefined, false)),
          discovery: "explicit-only" as const,
          requiredSkills: ["nt-narrative-review", "nt-catalog"] };
      const snapshot = await createSkillSnapshot(config);
      if (!snapshot) throw Error("Independent closeout reviewer requires pinned skills.");
      state.reviewSnapshot = snapshot; state.phase = "reviewing"; await persist(file, state);
      try {
        const assignment = await reviewerAssignment(job, request, proposal, state.commitSha!);
        const previous = state.history?.at(-1);
        if (previous) assignment.progressScope = repairProgressScope(job,
          previous.commitSha, state.commitSha!, proposal.allowedPaths, previous.review.findings);
        state.review = await reviewNarrative({ ...job, headSha: state.commitSha! },
          snapshot, assignment, state.provider, state.model, undefined,
          async sessionFile => { state!.reviewerSessionFile = sessionFile; await persist(file, state!); });
        state.reviewerSessionDigest = await checkedSessionDigest(job, state.reviewerSessionFile,
          "review-sessions");
        state.reviewDigest = closeoutReviewDigest({
          reviewerSessionDigest: state.reviewerSessionDigest,
          proposal: proposal.digest, commitSha: state.commitSha!,
          review: state.review });
        state.phase = "reviewed"; await persist(file, state);
      } catch (error) {
        state.failure = String(error); await persist(file, state);
        throw error;
      }
    }
    if (state.phase === "reviewed") {
      if (!state.commitSha || !state.review || !state.reviewDigest ||
          !state.reviewerSessionFile || !state.reviewSnapshot ||
          !state.reviewerSessionDigest || !state.writerSessionDigest ||
          state.reviewerSessionDigest !== await checkedSessionDigest(job,
            state.reviewerSessionFile, "review-sessions") ||
          state.writerSessionDigest !== await checkedSessionDigest(job,
            state.sessionFile, "prerequisite-sessions") ||
          await openSkillSnapshot(state.reviewSnapshot.id) !== state.reviewSnapshot.path)
        throw Error("Independent closeout review lacks pinned source or session.");
      const sealed = closeoutReviewDigest({
        reviewerSessionDigest: state.reviewerSessionDigest,
        proposal: state.proposal.digest, commitSha: state.commitSha,
        review: state.review,
      });
      if (state.reviewDigest !== sealed) {
        const legacy = closeoutReviewDigest({
          reviewerSessionDigest: state.reviewerSessionDigest,
          proposal: state.proposal.digest, commitSha: state.commitSha,
          review: state.review,
        }, false);
        if (state.reviewDigest !== legacy || !state.review.progressDiagnosis)
          throw Error("Independent closeout review has a changed or unsealed disposition.");
        const originalAssignment = await reviewerAssignment(job, request, proposal, state.commitSha);
        const previous = state.history?.at(-1);
        if (previous) originalAssignment.progressScope = repairProgressScope(job,
          previous.commitSha, state.commitSha, proposal.allowedPaths, previous.review.findings);
        await verifyLegacyCloseoutReviewTranscript(job, state.reviewerSessionFile,
          state.reviewerSessionDigest, state.review, originalAssignment);
        // Settlement must use the original sealed negative review digest.
        // Upgrading it here would invalidate any already-submitted ledger row.
      }
      verifyCommitted(job, state);
      const verdict = state.review.verdict === "pass" ? "passed" : "failed";
      await settlePrerequisiteRepair(job, { turnDigest: state.turnDigest, id: state.repairId,
        submittedSha: state.commitSha, reviewDigest: state.reviewDigest, verdict });
      if (verdict === "failed") {
        if (!state.writerSessionDigest || !state.reviewerSessionDigest ||
            !state.sessionFile || !state.reviewerSessionFile || !state.reviewSnapshot)
          throw Error("Negative dependency review has no preserved sessions.");
        const feedback = JSON.stringify(state.review.findings);
        const mayRetry = closeoutReviewMayRetry(state.review, proposal);
        const productive = !state.history?.length ||
          productiveEditorialRepair(state.review.progressDiagnosis, true);
        if (!mayRetry || !productive) {
          state.phase = "blocked"; state.failure =
            (!productive ? "Independent source-grounded Diagnostic found no meaningful " +
              "progress. Preserve failed revisions and request an approved new strategy: " :
              "Independent reviewer requires another owner's or protected source. " +
              "Preserve the negative review and request a controller amendment: ") +
            feedback.slice(0, 1800);
          await persist(file, state);
          throw Error(state.failure);
        }
        const rejected: RejectedCloseout = {
          proposal, commitSha: state.commitSha, reviewDigest: state.reviewDigest,
          review: state.review,
          writerSessionDigest: state.writerSessionDigest,
          reviewerSessionDigest: state.reviewerSessionDigest,
          writerSessionFile: state.sessionFile,
          reviewerSessionFile: state.reviewerSessionFile,
          reviewSnapshot: state.reviewSnapshot, feedback,
        };
        const newProposal = retryCloseoutProposal(proposal, state.commitSha);
        await admitPrerequisiteRepair(job, {
          turnDigest: state.turnDigest, milestoneId: newProposal.milestoneId,
          path: newProposal.allowedPaths[0]!, sourceEventSha: newProposal.sourceEventSha,
          proposalDigest: newProposal.digest, sourceSha: newProposal.sourceSha,
          planVersion: newProposal.planVersion,
        });
        state.history = [...state.history ?? [], rejected];
        state.retry = { sourceSession: state.sessionFile, feedback };
        state.proposal = newProposal;
        state.commitSha = undefined;
        state.review = undefined;
        state.reviewDigest = undefined;
        state.reviewerSessionFile = undefined;
        state.reviewerSessionDigest = undefined;
        state.writerSessionDigest = undefined;
        state.authoredDigest = undefined;
        state.sessionFile = undefined;
        state.reviewSnapshot = undefined;
        state.phase = "retry-ready";
        await persist(file, state);
        continue;
      }
      state.phase = "verified"; await persist(file, state);
    }
    if (state.phase !== "verified")
      throw Error("Closeout has no independently verified completion.");
    const ledger = await inspectRepairLedger(job, state.turnDigest);
    if (!ledger.prerequisites?.some(item => item.id === state.repairId &&
        item.status === "resolved" && item.attempts.some(a => a.submittedSha === state.commitSha &&
          a.verdict === "passed" && a.reviewDigest === state.reviewDigest)))
      throw Error("Closeout cannot publish without the original Turn's independent verdict.");
    await publish(job, state);
    if (await trustedHead(job) !== state.commitSha)
      throw Error("Closeout verified-head publication has not become authoritative.");
    const source = state.history?.[0]?.proposal ?? state.proposal;
    await revalidateAfterReviewedCorrection({
      job, inventory: request.originalInventory,
      correction: {
        version: 1, planVersion: state.proposal.planVersion,
        baseSha: source.sourceSha, successorSha: state.commitSha!,
        upstreamItemId: "event:" + state.proposal.milestoneId,
        predecessorCommitSha: state.proposal.sourceEventSha,
        turnDigest: state.turnDigest, reviewDigest: state.reviewDigest!,
        changedPaths: state.proposal.allowedPaths,
        permittedPaths: source.allowedPaths,
      },
      contract: request.contract, task: request.task,
      provider: state.provider, model: state.model,
      skillsSource: request.skillsSource, validatorSource: request.validatorSource,
    });
    return { status: "verified" as const, headSha: await trustedHead(job),
      workItemId: state.workItemId };
    }
  });
}
/** Recognized by the existing narrative successor verifier. An arbitrary
 * Milestone-only commit cannot be accepted via a plausible Git trailer. */
export async function verifyCrossDomainCloseoutSuccessor(
  job: JobStartResult, commit: string, parent: string,
  paths: string[], trailers: string[],
): Promise<void> {
  const workItem = trailers.find(t => /^NovelTea-Work-Item: prerequisite-[a-z][a-z0-9-]*$/.test(t))
    ?.slice("NovelTea-Work-Item: ".length);
  if (!workItem) throw Error("No source-bound prerequisite successor work item.");
  const name = "milestone." + workItem.slice("prerequisite-".length);
  const state = await load(fileOf(job, name));
  if (state?.phase === "verified" && state.history?.some(h => h.commitSha === commit)) {
    await verifyRejectedChain(job, state);
    const rejected = state.history.find(h => h.commitSha === commit)!;
    const expected = repoPath(job, rejected.proposal.allowedPaths[0]!);
    if (state.jobId !== job.jobId || !validCloseoutProposal(rejected.proposal) ||
        rejected.proposal.sourceSha !== parent ||
        JSON.stringify(paths) !== JSON.stringify([expected]) ||
        !trailers.includes("NovelTea-Job: " + job.jobId) ||
        !trailers.includes("NovelTea-Work-Item: " + workItem) ||
        !trailers.includes("NovelTea-Prerequisite: " + rejected.proposal.digest))
      throw Error("Historical rejected prerequisite is not a verified ancestor of the later approved closeout.");
    return;
  }
  if (!state || !validCloseoutProposal(state.proposal) ||
      state.version !== 1 || state.jobId !== job.jobId ||
      state.phase !== "verified" || state.workItemId !== workItem ||
      state.commitSha !== commit || state.proposal.sourceSha !== parent ||
      state.proposal.milestoneId !== name || state.worker !== "pi" ||
      state.validation?.status !== "passed" ||
      state.validation?.sourceSha !== parent ||
      state.validation.validatorVersion !== job.validatorVersion ||
      !state.review || state.review.verdict !== "pass" ||
      !state.reviewerSessionFile || !state.reviewSnapshot || !state.reviewDigest ||
      !state.reviewerSessionDigest || !state.writerSessionDigest ||
      state.reviewerSessionDigest !== await checkedSessionDigest(job,
        state.reviewerSessionFile, "review-sessions") ||
      state.writerSessionDigest !== await checkedSessionDigest(job,
        state.sessionFile, "prerequisite-sessions") ||
      await openSkillSnapshot(state.reviewSnapshot.id) !== state.reviewSnapshot.path ||
      state.reviewDigest !== closeoutReviewDigest({
        reviewerSessionDigest: state.reviewerSessionDigest,
        proposal: state.proposal.digest, commitSha: commit,
        review: state.review }) ||
      JSON.stringify(paths) !== JSON.stringify(state.proposal.allowedPaths.map(p =>
        repoPath(job, p))) ||
      !trailers.includes("NovelTea-Job: " + job.jobId) ||
      !trailers.includes("NovelTea-Prerequisite: " + state.proposal.digest))
    throw Error("Prerequisite successor is unverified, stale or changed out of scope.");
  await verifyRejectedChain(job, state);
  verifyCommitted(job, state);
  const ledger = await inspectRepairLedger(job, state.turnDigest);
  if (!ledger.prerequisites?.some(p => p.id === state.repairId && p.status === "resolved" &&
      p.attempts.some(a => a.submittedSha === commit && a.verdict === "passed" &&
        a.reviewDigest === state.reviewDigest)))
    throw Error("Prerequisite successor lost its original independent correction verdict.");
}
