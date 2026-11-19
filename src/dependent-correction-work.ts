/** Bounded same-owner correction after a historically PASSED checkpoint is
 * invalidated by a later independently reviewed upstream source.
 *
 * Same Story writer lane, original Pi history, native validator and Repair
 * ledger. A new Git revision and fresh independent reviewer are mandatory.
 * Historical PASSES, source commits, and rejected attempts are immutable.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import { trustedHead } from "./revision.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { inspectRecoveryCheckpoints, type RecoveryInspection } from "./recovery-checkpoints.js";
import { inspectCheckpointReview } from "./checkpoint-assurance.js";
import { readRejectedRepairOrigin, type RepairOrigin } from "./rejected-review-repair.js";
import { inspectRepairLedger, submitRepairCorrection, settleRepairReview,
  admitCausalRevalidationFinding, MAX_LOCAL_CORRECTIONS } from "./repair-ledger.js";
import { validateStoryJob } from "./validator.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { reviewNarrative, type EditorialVerdict, type ReviewAssignment } from "./narrative-review-specialist.js";
import { assertDependentCorrection, type DependentCorrectionAssignment,
  type SelectiveRevalidationPlan } from "./selective-revalidation.js";
import type { JobStartResult } from "./job.js";

const SHA = /^[a-f0-9]{40}$/;
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const fileOf = (job: JobStartResult, proposal: DependentCorrectionAssignment) =>
  join(job.stateDir, "dependent-corrections", proposal.digest + ".json");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
}
const repoPath = (job: JobStartResult, p: string) =>
  (job.storyRelativePath ? job.storyRelativePath + "/" : "") + p;
function changed(job: JobStartResult) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  // Do not trim porcelain XY: leading whitespace is the Git status.
  const all = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return all.split("\0").filter(Boolean);
}
async function atomic(path: string, state: DependentCorrectionReceipt) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
export async function verifiedPiSession(job: JobStartResult, file: string, original: string) {
  const root = join(job.stateDir, "dependent-correction-sessions") + sep;
  if (file !== original && !file.startsWith(root) ||
      !file.startsWith(job.stateDir + sep) || !existsSync(file) ||
      await realpath(file) !== file)
    throw Error("Original-owner repair transcript is missing or outside its private job.");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 50 ||
      stat.size > 16 * 1024 * 1024)
    throw Error("Unsafe original-owner Pi session.");
  const content = await readFile(file, "utf8");
  const header = JSON.parse(content.split("\n")[0]!) as { type?: string; id?: string };
  if (header.type !== "session" || !header.id?.trim())
    throw Error("Dependent repair Pi session lacks the original durable identity.");
  return hash(content);
}
interface Attempt {
  sourceSha: string;
  commitSha: string;
  paths: string[];
  draftDigest: string;
  validationDigest: string;
  writerSession: string;
  writerSessionDigest: string;
  reviewerSession: string;
  reviewerSessionDigest: string;
  reviewDigest: string;
  review: EditorialVerdict;
}
export interface DependentCorrectionReceipt {
  version: 1; jobId: string; threadId: string; turnDigest: string;
  proposal: DependentCorrectionAssignment;
  phase: "ready" | "writing" | "authored" | "committed" |
    "reviewing" | "reviewed" | "verified" | "blocked";
  currentSourceSha: string;
  origin: RepairOrigin;
  originalCheckpointProofDigest: string;
  originalSessionDigest: string;
  snapshot: SkillSnapshot;
  attempts: Attempt[];
  writerSession?: string;
  writerSessionDigest?: string;
  draftDigest?: string;
  draftPaths?: string[];
  validationDigest?: string;
  commitSha?: string;
  reviewerSession?: string;
  reviewerSessionDigest?: string;
  review?: EditorialVerdict;
  reviewDigest?: string;
  failure?: string;
}
export async function inspectDependentCorrection(job: JobStartResult,
  proposal: DependentCorrectionAssignment, plan: SelectiveRevalidationPlan,
): Promise<DependentCorrectionReceipt | null> {
  assertDependentCorrection(proposal, plan);
  const file = fileOf(job, proposal);
  if (!existsSync(file)) return null;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200_000)
    throw Error("Unsafe previous dependent correction receipt.");
  const state = JSON.parse(await readFile(file, "utf8")) as DependentCorrectionReceipt;
  if (state.version !== 1 || state.jobId !== job.jobId ||
      state.threadId !== job.threadId || state.turnDigest !== proposal.turnDigest ||
      !/^[a-f0-9]{64}$/.test(state.originalCheckpointProofDigest) ||
      JSON.stringify(state.proposal) !== JSON.stringify(proposal) ||
      !SHA.test(state.currentSourceSha) || !Array.isArray(state.attempts) ||
      state.attempts.length > MAX_LOCAL_CORRECTIONS ||
      !["ready", "writing", "authored", "committed", "reviewing",
        "reviewed", "verified", "blocked"].includes(state.phase) ||
      await openSkillSnapshot(state.origin.snapshot.id) !== state.origin.snapshot.path ||
      await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path ||
      await verifiedPiSession(job, state.origin.sessionFile, state.origin.sessionFile) !==
        state.originalSessionDigest)
    throw Error("Dependent correction lost original owner, model context or source identity.");
  let parent = proposal.sourceSha;
  for (const attempt of state.attempts) {
    if (attempt.sourceSha !== parent || !SHA.test(attempt.commitSha) ||
        JSON.stringify(attempt.paths) !== JSON.stringify(
          [...attempt.paths].sort()) || !attempt.paths.length ||
        attempt.paths.some(p => !proposal.authorizedPaths.includes(p)) ||
        attempt.draftDigest !== hash(attempt.paths.map(p => [p,
          git(job, "diff", "--binary", parent, attempt.commitSha,
            "--", repoPath(job, p))])) ||
        git(job, "rev-parse", attempt.commitSha + "^") !== parent ||
        git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", attempt.commitSha)
          .split("\n").filter(Boolean).sort().join("\n") !==
          attempt.paths.map(p => repoPath(job, p)).sort().join("\n") ||
        !/^[a-f0-9]{64}$/.test(attempt.validationDigest) ||
        !git(job, "log", "-1", "--format=%B", attempt.commitSha)
          .split("\n").includes("NovelTea-Dependent-Native: " + attempt.validationDigest) ||
        !git(job, "log", "-1", "--format=%B", attempt.commitSha)
          .split("\n").includes("NovelTea-Dependent-Correction: " + proposal.digest) ||
        !["pass", "block"].includes(attempt.review.verdict) ||
        attempt.reviewDigest !== hash({ proposal: proposal.digest,
          source: attempt.commitSha, transcript: attempt.reviewerSessionDigest,
          review: attempt.review }) ||
        attempt.writerSessionDigest !== await verifiedPiSession(job,
          attempt.writerSession, state.origin.sessionFile) ||
        attempt.reviewerSessionDigest !== await reviewTranscript(job, attempt.reviewerSession))
      throw Error("Previous dependent correction Git/validator/reviewer provenance changed.");
    parent = attempt.commitSha;
  }
  if (state.attempts.length && state.currentSourceSha !== parent)
    throw Error("Dependent correction source chain is stale.");
  return state;
}
async function reviewTranscript(job: JobStartResult, file: string) {
  if (!file?.startsWith(join(job.stateDir, "review-sessions") + sep) ||
      !existsSync(file) || await realpath(file) !== file)
    throw Error("Dependent independent reviewer transcript escaped its private job.");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 50 ||
      stat.size > 16 * 1024 * 1024)
    throw Error("Unsafe independent reviewer transcript.");
  const content = await readFile(file, "utf8");
  const header = JSON.parse(content.split("\n")[0]!) as { type?: string; id?: string };
  if (header.type !== "session" || !header.id?.trim())
    throw Error("Dependent correction reviewer lacks a durable independent session.");
  return hash(content);
}
export async function auditDependentCorrectionDraft(job: JobStartResult,
  proposal: DependentCorrectionAssignment, sourceSha: string) {
  if (git(job, "rev-parse", "HEAD") !== sourceSha ||
      git(job, "symbolic-ref", "--short", "HEAD") !== job.branch)
    throw Error("Dependent correction source HEAD or branch changed.");
  const entries = changed(job);
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const paths = entries.map(entry => {
    if (!entry.startsWith(" M " + prefix))
      throw Error("Dependent correction changed staged, new, deleted or unrelated Story data.");
    return entry.slice(3 + prefix.length);
  }).sort();
  if (!paths.length || paths.some(p => !proposal.authorizedPaths.includes(p)))
    throw Error("Dependent correction has no changed original-owned files or exceeded its grant.");
  // A high-level record owner is not permission to rewrite all of an Arc,
  // Milestone, protected direction or narrative ordering. The dedicated
  // Event field-only closeout already has a separate authenticated grant.
  // Do not silently turn its fields into general repair authority.
  if (paths.some(p => /^(?:arcs|milestones|creative-direction|narrative-positions)\//.test(p)))
    throw Error("Protected-adjacent Story fields require their original signed field-level amendment.");
  for (const path of paths) {
    const target = join(job.worktreeStoryRoot, path);
    if (await realpath(target) !== target || !(await lstat(target)).isFile())
      throw Error("Dependent correction target is symlinked or not a regular file.");
    if (proposal.itemId.startsWith("interactive:") && path.startsWith("events/")) {
      const { prerequisitesText } = await import("./interactive-work.js");
      const original = git(job, "show", sourceSha + ":" + repoPath(job, path));
      if (prerequisitesText(original) !== prerequisitesText(await readFile(target, "utf8")))
        throw Error("Dependent Choice/Puzzle repair changed an immutable Event prerequisite route.");
    }
  }
  return paths;
}
async function native(job: JobStartResult, sourceSha: string,
  originWorkItem: string, validatorSource?: string) {
  const result = await validateStoryJob(job, validatorSource, { ...job, baseSha: sourceSha });
  const report = result.report as { diagnostics?: unknown[]; protection?: {
    status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (result.status !== "passed" || !report || !Array.isArray(report.diagnostics) ||
      report.diagnostics.length || report.protection?.status !== "checked" ||
      report.protection.base !== sourceSha || report.protection.changes?.length ||
      report.protection.warnings?.length)
    throw Error("Dependent correction failed native/protected-canon validation.");
  if (originWorkItem.startsWith("interactive-choice-")) {
    const slug = originWorkItem.slice("interactive-choice-".length);
    if (!/^[a-z][a-z0-9-]*$/.test(slug))
      throw Error("Dependent Choice owner has unsafe original Milestone identity.");
    const receipt = JSON.parse(await readFile(join(job.stateDir,
      "interactive-items", slug + ".json"), "utf8")) as {
      jobId?: string; units?: Array<{ id?: string; paths?: string[];
        obligations?: string[] }> };
    const original = receipt.units?.find(u => u.id === originWorkItem);
    if (receipt.jobId !== job.jobId || !original ||
        !Array.isArray(original.paths) || !original.paths.length ||
        !Array.isArray(original.obligations))
      throw Error("Dependent Choice correction lost its originally verified payoff obligations.");
    const { verifyRepairedChoicePayoff } = await import("./interactive-work.js");
    verifyRepairedChoicePayoff(result.report, original.paths, original.obligations);
  }
  return hash({ validator: result.validator, sourceSha, report });
}
function authenticatedSpecialist(workItem: string, original: string) {
  // A single Interactive Turn assignment is executed by two different actual
  // specialists. A Puzzle transcript must never receive a Choice writer grant.
  if (workItem.startsWith("interactive-puzzle-"))
    return "nt-puzzle-design";
  return original;
}
async function reviewAssignment(job: JobStartResult, proposal: DependentCorrectionAssignment,
  paths: string[], commitSha: string): Promise<ReviewAssignment> {
  const turn = await readReviewTurnEvidence(job);
  const author = turn?.assignments.find(a => a.id === proposal.assignmentId);
  if (!turn || turn.digest !== proposal.turnDigest || !author ||
      author.outcome !== proposal.obligation)
    throw Error("Dependent rereview lost the original author goal or specialist authority.");
  return {
    contract: turn.contract, planVersion: proposal.planVersion,
    scopeIds: author.targets, paths: [...new Set([...paths, ...proposal.authorizedPaths])],
    routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    turnGoal: "Independent rereview of a *corrected historically accepted* " +
      "specialist assignment. Evaluate the original obligation: " + author.outcome +
      ". Do not certify by the prior positive reviewer or writer's claim.",
    specialistAssignments: [{
      id: author.id, specialist: proposal.specialist, outcome: author.outcome,
      targets: author.targets,
      authority: { recordTypes: author.authority.recordTypes,
        existingPaths: proposal.authorizedPaths, mayCreate: false },
    }],
    revalidation: { assignmentId: author.id,
      originalCommitSha: proposal.originalCommitSha, correctedHeadSha: commitSha,
      changedPaths: proposal.authorizedPaths },
  };
}
export interface DependentCorrectionOptions {
  job: JobStartResult; proposal: DependentCorrectionAssignment;
  plan: SelectiveRevalidationPlan; point: RecoveryInspection;
  reviewerSnapshot: SkillSnapshot;
  provider: string; model: string; validatorSource?: string;
  sourcePaths: string[];
  findings: Array<{ source: string; message: string }>;
}
/** Must run inside the existing Story writer lock; crashes in a model call
 * are fenced, never automatically replayed. */
export async function advanceDependentCorrection(opts: DependentCorrectionOptions):
  Promise<{ commitSha: string; reviewDigest: string }> {
  const { job, proposal, plan, point } = opts;
  assertDependentCorrection(proposal, plan);
  if (proposal.authorizedPaths.some(p =>
    /^(?:arcs|milestones|creative-direction|narrative-positions)\//.test(p)))
    throw Error("Original owner needs a separate signed field-level or protected decision amendment.");
  const turn = await readReviewTurnEvidence(job);
  const original = turn?.assignments.find(a => a.id === proposal.assignmentId);
  if (!existsSync(join(job.stateDir, "turn-plan.json")) ||
      !turn || turn.source.jobId !== job.jobId ||
      turn.source.verifiedSha !== job.baseSha ||
      turn.digest !== proposal.turnDigest || !point.eligible ||
      point.semanticReview !== "passed" || !point.assurance ||
      point.assurance.jobId !== job.jobId ||
      point.assurance.turnDigest !== turn.digest ||
      point.commitSha !== proposal.originalCommitSha ||
      point.assurance.assignmentId !== proposal.assignmentId ||
      !original || authenticatedSpecialist(point.workItem, original.specialist) !==
        proposal.specialist || original.outcome !== proposal.obligation)
    throw Error("Corrective writer has no original signed, independently passed specialist authority.");
  const prior = await inspectCheckpointReview(job, point);
  if (prior?.status !== "passed" || !prior.result)
    throw Error("Historical positive independent reviewer proof is missing.");
  const path = fileOf(job, proposal);
  let state = await inspectDependentCorrection(job, proposal, plan);
  if (!state) {
    if (await trustedHead(job) !== proposal.sourceSha ||
        git(job, "rev-parse", "HEAD") !== proposal.sourceSha || changed(job).length)
      throw Error("Dependent writer needs the original corrected, clean and trusted source.");
    const origin = await readRejectedRepairOrigin(job, point);
    if (origin.provider !== opts.provider || origin.model !== opts.model)
      throw Error("Dependent writer model differs from original specialist's pinned profile.");
    if (await openSkillSnapshot(opts.reviewerSnapshot.id) !== opts.reviewerSnapshot.path)
      throw Error("Independent dependent reviewer skills are unavailable.");
    state = { version: 1, jobId: job.jobId, threadId: job.threadId,
      turnDigest: proposal.turnDigest, proposal, origin,
      originalCheckpointProofDigest: point.proofDigest,
      originalSessionDigest: await verifiedPiSession(job, origin.sessionFile, origin.sessionFile),
      snapshot: opts.reviewerSnapshot, currentSourceSha: proposal.sourceSha,
      phase: "ready", attempts: [] };
    await atomic(path, state);
  }
  // An existing private receipt is a crash fence, not authority. Re-authenticate
  // its original specialist, exact checkpoint and reviewer snapshot on every
  // resume BEFORE giving Pi any writable tools.
  const authenticOrigin = await readRejectedRepairOrigin(job, point);
  if (state.originalCheckpointProofDigest !== point.proofDigest ||
      JSON.stringify(state.origin) !== JSON.stringify(authenticOrigin) ||
      state.snapshot.id !== opts.reviewerSnapshot.id ||
      state.snapshot.path !== opts.reviewerSnapshot.path ||
      state.origin.provider !== opts.provider || state.origin.model !== opts.model)
    throw Error("Recovered dependent correction substituted its original owner, session or reviewer.");
  if (state.phase === "writing" || state.phase === "reviewing")
    throw Error("Interrupted original-owner writer/reviewer has a preserved session; inspect before replay.");
  if (state.phase === "blocked") throw Error(state.failure ?? "Dependent correction exhausted");
  if (state.phase === "verified") {
    const last = state.attempts.at(-1);
    if (!last || last.review.verdict !== "pass")
      throw Error("Dependent correction has no independently passed successor.");
    await publishDependentHead(job, proposal.sourceSha, last.commitSha);
    return { commitSha: last.commitSha, reviewDigest: last.reviewDigest };
  }
  const s = state;
  for (let i = s.attempts.length; i < MAX_LOCAL_CORRECTIONS; i++) {
    const source = s.currentSourceSha;
    if (s.phase === "ready") {
      if (git(job, "rev-parse", "HEAD") !== source || changed(job).length ||
          (i === 0 && await trustedHead(job) !== source))
        throw Error("Original-owner correction source moved or contains uncommitted edits.");
      await preflightPiAssignment(job, "dependent-correction:" + proposal.digest + ":" + i,
        { provider: s.origin.provider, model: s.origin.model, thinking: s.origin.thinking });
      s.phase = "writing"; await atomic(path, s);
      const { authorDependentCorrection } = await import("./dependent-correction-specialist.js");
      const originSession = s.attempts.at(-1)?.writerSession ?? s.origin.sessionFile;
      const feedback = i === 0 ? JSON.stringify(opts.findings) :
        JSON.stringify(s.attempts.at(-1)?.review.findings);
      const file = await authorDependentCorrection({
        job, proposal, origin: s.origin, originalPaths: opts.sourcePaths,
        sourceSession: originSession, feedback,
        onSession: async file => { s.writerSession = file; await atomic(path, s); },
        audit: async () => { await auditDependentCorrectionDraft(job, proposal, source); },
      });
      const paths = await auditDependentCorrectionDraft(job, proposal, source);
      s.writerSession = file;
      s.writerSessionDigest = await verifiedPiSession(job, file, s.origin.sessionFile);
      s.draftPaths = paths;
      s.draftDigest = hash(paths.map(p => [p, git(job, "diff", "--binary", "--", repoPath(job, p))]));
      s.phase = "authored"; await atomic(path, s);
    }
    if (s.phase === "authored") {
      const paths = await auditDependentCorrectionDraft(job, proposal, source);
      if (JSON.stringify(paths) !== JSON.stringify(s.draftPaths) ||
          s.draftDigest !== hash(paths.map(p => [p,
            git(job, "diff", "--binary", "--", repoPath(job, p))])))
        throw Error("Dependent writer changed its submitted source after audit.");
      s.validationDigest = await native(job, source, s.origin.workItem,
        opts.validatorSource);
      await submitRepairCorrection(job, {
        turnDigest: proposal.turnDigest, rootFailureSha: proposal.originalCommitSha,
        sourceSha: source, changedPaths: paths,
      });
      git(job, "add", "--", ...paths.map(p => repoPath(job, p)));
      git(job, "-c", "user.name=NovelTea Generator",
        "-c", "user.email=noveltea-gen@users.noreply.github.com",
        "commit", "-m", "Correct previously reviewed dependent [" + job.jobId + "]\n\n" +
          "NovelTea-Job: " + job.jobId + "\n" +
          "NovelTea-Work-Item: dependent-repair-" + proposal.originalCommitSha + "\n" +
          "NovelTea-Plan-Version: " + proposal.planVersion + "\n" +
          "NovelTea-Dependent-Native: " + s.validationDigest + "\n" +
          "NovelTea-Dependent-Correction: " + proposal.digest);
      s.commitSha = git(job, "rev-parse", "HEAD");
      s.phase = "committed"; await atomic(path, s);
    }
    if (s.phase === "committed") {
      if (!s.commitSha || git(job, "rev-parse", s.commitSha + "^") !== source ||
          git(job, "rev-parse", "HEAD") !== s.commitSha || changed(job).length)
        throw Error("Dependent correction commit changed its original source or is dirty.");
      s.phase = "reviewing"; await atomic(path, s);
      const assignment = await reviewAssignment(job, proposal, s.draftPaths!, s.commitSha);
      s.review = await reviewNarrative({ ...job, headSha: s.commitSha },
        s.snapshot, assignment, opts.provider, opts.model, undefined,
        async file => { s.reviewerSession = file; await atomic(path, s); });
      s.reviewerSessionDigest = await reviewTranscript(job, s.reviewerSession!);
      s.reviewDigest = hash({ proposal: proposal.digest, source: s.commitSha,
        transcript: s.reviewerSessionDigest, review: s.review });
      s.phase = "reviewed"; await atomic(path, s);
    }
    if (s.phase === "reviewed") {
      if (!s.commitSha || !s.review || !s.reviewDigest || !s.draftPaths ||
          !s.draftDigest || !s.validationDigest || !s.writerSession ||
          !s.writerSessionDigest || !s.reviewerSession || !s.reviewerSessionDigest ||
          s.writerSessionDigest !== await verifiedPiSession(job,
            s.writerSession, s.origin.sessionFile) ||
          s.reviewerSessionDigest !== await reviewTranscript(job, s.reviewerSession) ||
          s.reviewDigest !== hash({ proposal: proposal.digest, source: s.commitSha,
            transcript: s.reviewerSessionDigest, review: s.review }))
        throw Error("Independent dependent rereview or validated writer receipt is missing.");
      await settleRepairReview(job, {
        turnDigest: proposal.turnDigest, rootFailureSha: proposal.originalCommitSha,
        sourceSha: source, successorSha: s.commitSha, reviewDigest: s.reviewDigest,
        assignmentId: proposal.assignmentId, obligation: proposal.obligation,
        status: s.review.verdict === "pass" ? "passed" : "failed",
        findings: s.review.verdict === "block"
          ? s.review.findings.filter(f => f.severity === "blocking").map(f => ({
              path: f.source.split(":")[0]!, kind: "continuity" as const,
              message: f.message, requiredCorrection: "Correct the original reviewed obligation.",
              affectedPaths: [f.source.split(":")[0]!],
            })) : [],
      });
      s.attempts.push({ sourceSha: source, commitSha: s.commitSha,
        paths: s.draftPaths, draftDigest: s.draftDigest,
        validationDigest: s.validationDigest, writerSession: s.writerSession,
        writerSessionDigest: s.writerSessionDigest, reviewerSession: s.reviewerSession,
        reviewerSessionDigest: s.reviewerSessionDigest, reviewDigest: s.reviewDigest,
        review: s.review });
      if (s.review.verdict === "pass") {
        s.phase = "verified";
        s.currentSourceSha = s.commitSha;
        await atomic(path, s);
        await publishDependentHead(job, proposal.sourceSha, s.commitSha);
        return { commitSha: s.commitSha, reviewDigest: s.reviewDigest };
      }
      if (s.review.findings.some(f => f.severity === "blocking" &&
          !proposal.authorizedPaths.includes(f.source.split(":")[0]!))) {
        s.phase = "blocked";
        s.failure = "Independent rereview requires another owner's source; correction refused.";
      } else if (s.attempts.length >= MAX_LOCAL_CORRECTIONS) {
        s.phase = "blocked";
        s.failure = "Original-owner dependent correction exhausted the local repair ceiling.";
      } else {
        await admitCausalRevalidationFinding(job, {
          turnDigest: proposal.turnDigest, rootFailureSha: proposal.originalCommitSha,
          sourceSha: s.commitSha, causedBy: s.commitSha,
          reviewDigest: s.reviewDigest, assignmentId: proposal.assignmentId,
          obligation: proposal.obligation,
          findings: s.review.findings.filter(f => f.severity === "blocking").map(f => ({
            path: f.source.split(":")[0]!, kind: "continuity" as const,
            message: f.message, affectedPaths: [f.source.split(":")[0]!],
          })),
        });
        s.currentSourceSha = s.commitSha;
        s.phase = "ready";
      }
      s.writerSession = undefined;
      s.writerSessionDigest = undefined;
      s.draftDigest = undefined;
      s.draftPaths = undefined;
      s.validationDigest = undefined;
      s.commitSha = undefined;
      s.reviewerSession = undefined;
      s.reviewerSessionDigest = undefined;
      s.review = undefined;
      s.reviewDigest = undefined;
      await atomic(path, s);
      if (s.phase === "blocked") throw Error(s.failure);
    }
  }
  throw Error("Dependent correction did not acquire an independent positive verdict.");
}
async function publishDependentHead(job: JobStartResult, expected: string, commit: string) {
  const head = join(job.stateDir, "revisions", "verified-head.json");
  // The Git branch is at the NEW commit while the trusted-head receipt still
  // pins the OLD independently accepted commit. trustedHead() intentionally
  // rejects that gap, so inspect the pinned prior receipt atomically instead.
  const before = JSON.parse(await readFile(head, "utf8")) as {
    version?: number; jobId?: string; headSha?: string;
  };
  if (before.version !== 1 || before.jobId !== job.jobId)
    throw Error("Dependent correction lost its trusted revision identity.");
  if (before.headSha === commit) return;
  if (before.headSha !== expected || git(job, "rev-parse", "HEAD") !== commit ||
      changed(job).length)
    throw Error("Independent dependent successor cannot publish from a moved trusted HEAD.");
  const temp = head + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify({ version: 1, jobId: job.jobId,
    headSha: commit, workItemId: "dependent-repair" }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  await rename(temp, head);
}
/** Existing verified Narrative chain calls this for exact, privately sealed
 * corrective successor commits; an arbitrary trailer cannot authorize edits. */
export async function verifyDependentCorrectionSuccessor(job: JobStartResult,
  commit: string, parent: string, paths: string[], trailers: string[]) {
  const root = trailers.find(t => /^NovelTea-Work-Item: dependent-repair-[a-f0-9]{40}$/.test(t))
    ?.slice("NovelTea-Work-Item: dependent-repair-".length);
  const digest = trailers.find(t => /^NovelTea-Dependent-Correction: [a-f0-9]{64}$/.test(t))
    ?.slice("NovelTea-Dependent-Correction: ".length);
  if (!root || !digest || !trailers.includes("NovelTea-Job: " + job.jobId))
    throw Error("Unrecognized previously reviewed dependent successor.");
  const file = join(job.stateDir, "dependent-corrections", digest + ".json");
  if (!existsSync(file)) throw Error("Dependent successor lacks original correction receipt.");
  const state = JSON.parse(await readFile(file, "utf8")) as DependentCorrectionReceipt;
  if (state.proposal?.originalCommitSha !== root ||
      state.proposal?.digest !== digest || state.jobId !== job.jobId ||
      state.phase !== "verified" || !state.attempts?.length)
    throw Error("Dependent successor is not independently approved or has wrong original owner.");
  const plan = (await readFile(join(job.stateDir, "revalidation-items",
    state.proposal.causalCorrectionSha + ".json"), "utf8"));
  const pinned = JSON.parse(plan) as { proposal: SelectiveRevalidationPlan };
  const valid = await inspectDependentCorrection(job, state.proposal, pinned.proposal);
  const original = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === state.proposal.originalCommitSha &&
    p.proofDigest === valid?.originalCheckpointProofDigest);
  const prior = original && await inspectCheckpointReview(job, original);
  const turn = await readReviewTurnEvidence(job);
  if (!existsSync(join(job.stateDir, "turn-plan.json")) ||
      !original?.assurance || prior?.status !== "passed" || !prior.result ||
      original.assurance.jobId !== job.jobId ||
      turn?.source.jobId !== job.jobId ||
      original.assurance.assignmentId !== state.proposal.assignmentId ||
      original.assurance.turnDigest !== state.proposal.turnDigest ||
      turn?.digest !== state.proposal.turnDigest ||
      !turn.assignments.some(a => a.id === state.proposal.assignmentId &&
        authenticatedSpecialist(original.workItem, a.specialist) ===
          state.proposal.specialist && a.outcome === state.proposal.obligation))
    throw Error("Previously accepted dependent source lost its sealed original assignment or reviewer.");
  const trustedOrigin = await readRejectedRepairOrigin(job, original);
  if (JSON.stringify(valid?.origin) !== JSON.stringify(trustedOrigin))
    throw Error("Dependent corrective writer changed its authenticated original Pi context.");
  const attempt = valid?.attempts.find(a => a.commitSha === commit);
  if (!attempt || attempt.sourceSha !== parent ||
      JSON.stringify(paths.slice().sort()) !== JSON.stringify(
        attempt.paths.map(p => repoPath(job, p)).sort()) ||
      (attempt.review.verdict !== "pass" && commit === valid!.attempts.at(-1)?.commitSha))
    throw Error("Dependent successor changed protected/other-owner files or has no passed proof.");
  if (!valid!.attempts.some(a => a.review.verdict === "pass"))
    throw Error("Dependent chain never achieved independent correction review.");
  const ledger = await inspectRepairLedger(job, state.proposal.turnDigest);
  if (!valid!.attempts.every(a => ledger.corrections.some(c =>
    c.rootFailureSha === state.proposal.originalCommitSha &&
    c.sourceSha === a.sourceSha &&
    c.result?.successorSha === a.commitSha &&
    c.result.reviewDigest === a.reviewDigest &&
    c.result.status === (a.review.verdict === "pass" ? "passed" : "failed"))))
    throw Error("Dependent successor lacks its independently settled shared Repair ledger entries.");
}
