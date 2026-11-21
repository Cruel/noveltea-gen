import { EVENT_CAUSAL_GROUNDING } from "./event-causal-grounding.js";
import { readEventMilestoneRepairGrant } from "./event-milestone-repair.js";
import { assertMilestoneFulfillmentOnly } from "./milestone-field-scope.js";
import { auditEventParticipantCorrection } from "./event-participant-correction.js";
import { CHOICE_PAYOFF_REPAIR } from "./choice-payoff-guidance.js";
import { assertOriginalChoiceRepairEvidence } from "./choice-repair-origin.js";
import { PUZZLE_GOAL_REPAIR } from "./puzzle-goal-fidelity.js";
import { eventConsequenceProofDigest,
  type EventConsequenceProof } from "./event-consequence-proof.js";
import { rejectedRepairContext } from "./review-repair-context.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { reportControllerReviewPhase } from "./controller-review-phase.js";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectRecoveryCheckpoints, finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectCheckpointReview, readIndependentReview, readRepairCommitProof, repairReviewAssignment,
  type IndependentReviewResult, type RepairCommitProof } from "./checkpoint-assurance.js";
import { type TurnAssignmentEvidence } from "./turn-plan-evidence.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { inspectSpecialistChoice, recordSpecialistChoice, claimSpecialistChoice,
  completeSpecialistChoice, authorChoiceDirection, type SpecialistChoiceQuestion } from "./specialist-choice.js";
import { verifyJobPiSession } from "./job-session.js";
import { validateStoryJob } from "./validator.js";
import { trustedHead } from "./revision.js";
import { openSkillSnapshot, pinnedSkillReferences, type SkillSnapshot } from "./snapshot.js";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJobModelRuntime } from "./model-runtime.js";
import { resolvePiModel, guardPiBudget } from "./job-pi-policy.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { createStoryValidateTool } from "./validator.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot } from "./snapshot.js";
import { runPiAssignmentReview } from "./semantic-assignment-review.js";
import { inspectPostcommitReviewCycle } from "./postcommit-review-cycle.js";
import { postcommitDiagnosticReason, readPostcommitDiagnosis } from "./postcommit-repair-diagnostic.js";
import { assertReviewCycleSession } from "./review-cycle.js";
import { activeStoryWriter, withStoryJobLock } from "./job-lock.js";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";
import { currentSteeringBoundary } from "./steering-boundary.js";
import { steeringForAssignment } from "./steering-amendments.js";
import { driveRejectedRepairCycle } from "./rejected-repair-controller.js";
import { deriveReviewRepairAmendment, deriveReviewDependencyRequest, reviewNeedsDependency,
  type ReviewDependencyRequest, type ReviewRepairPlanAmendment } from "./review-repair-amendment.js";
import { inspectReviewEventSupport, recordReviewDependency } from "./dependency-state.js";
import { admitRepairFinding, inspectRepairLedger, submitRepairCorrection,
  settleRepairReview } from "./repair-ledger.js";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");

/** A sealed failure that needs a NEW typed assignment is not a retryable
 * original-session repair. The shared dependency ledger records a pending,
 * non-authorizing work-plan request; no author approval is implied by routine
 * full-Story support, and the original review stays failed. */
export class ReviewDependencyRequiredError extends Error {
  readonly name = "ReviewDependencyRequiredError";
  constructor(readonly request: ReviewDependencyRequest) {
    const sources = request.findings.map(f =>
      f.path + ":" + f.line + " — " + f.requiredCorrection).join("; ");
    super("Independent review " + request.sourceSha + " requires a " +
      (request.action === "author-approval-required"
        ? "trusted author-approved scope/protected amendment"
        : "controller-verified typed supporting-work amendment") +
      " before another specialist can write. Original review and Pi transcript are preserved; " +
      "no path, new Character ID, Arc edit, owner or approval has been granted. " +
      "Source-bound findings: " + sources);
  }
}
const pathFor = (job: JobStartResult, sha: string) => join(job.stateDir, "review-repairs", sha + ".json");
const repoPath = (job: JobStartResult, path: string) =>
  job.storyRelativePath ? job.storyRelativePath + "/" + path : path;
function gitRaw(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
const git = (job: JobStartResult, ...args: string[]) => gitRaw(job, ...args).trim();
function isAncestor(job: JobStartResult, ancestor: string, descendant: string) {
  try { git(job, "merge-base", "--is-ancestor", ancestor, descendant); return true; }
  catch { return false; }
}
async function save(job: JobStartResult, state: RepairReceipt) {
  const file = pathFor(job, state.sourceCommitSha);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
export interface RepairOrigin {
  workItem: string;
  sessionFile: string;
  sessionId: string;
  provider: string;
  model: string;
  thinking?: "low" | "medium" | "high";
  snapshot: SkillSnapshot;
}
export interface RepairRevision {
  version: number;
  assignment: TurnAssignmentEvidence;
  choiceId: string;
  proposalSha256: string;
  principal: string;
  direction: string;
  digest: string;
}
interface RepairCommitIntent {
  version: 1;
  beforeHead: string;
  proofDigest: string;
  planVersion: number;
  sessionSha256: string;
  paths: string[];
  /** Exact validated canonical bytes staged for the original commit. */
  fileHashes: Record<string, string>;
}
export type RepairPhase = "ready" | "prepared" | "repairing" | "awaiting-author" | "needs-plan" | "disputing" | "adjudicating" | "validating" |
  "awaiting-checkpoint" | "reviewing" | "passed" | "failed" | "blocked";
export interface RepairReceipt {
  version: 1;
  jobId: string;
  threadId: string;
  sourceCommitSha: string;
  rootFailureSha: string;
  sourceReviewDigest: string;
  originalReviewDigest: string;
  originalSource: IndependentReviewResult["source"];
  source: IndependentReviewResult["source"];
  findings: IndependentReviewResult["findings"];
  /** New verdict on repairedCommitSha; never replaces the rejected source findings. */
  successorFindings?: IndependentReviewResult["findings"];
  planAmendment: ReviewRepairPlanAmendment;
  assignment: TurnAssignmentEvidence;
  allowedPaths: string[];
  origin: RepairOrigin;
  sessionSha256: string;
  /** Exact Pi transcript prefix at the one-way writer claim (not a new session). */
  sessionBytesBeforeRepair?: number;
  /** Submitted correction attests the completed Pi transcript independently of Git. */
  submittedSessionSha256?: string;
  /** Publication fence written before Git changes HEAD; no separate state owner. */
  commitIntent?: RepairCommitIntent;
  phase: RepairPhase;
  attempts: number;
  revision?: RepairRevision;
  reviewer?: {
    snapshot: SkillSnapshot; source: string | null; provider: string; model: string;
    thinking?: "low" | "high"; sessionFiles: string[];
  };
  choiceId?: string;
  /** Verified read-only dependency that this specialist cannot change. */
  outOfAuthority?: { path: string; sourceSha: string; reviewDigest: string };
  /** A writer claim cannot alter the sealed verdict. One distinct read-only
   * adjudication may be requested and is fenced before its Pi turn. */
  dispute?: { path: string; line: number; claim: string;
    adjudication?: { sessionFile: string; packetDigest: string;
      verdict: "pass" | "fail"; findingsDigest: string } };
  baselineHead: string;
  draftDigest?: string;
  paths?: string[];
  validationProof?: string;
  repairedCommitSha?: string;
  failure?: string;
}
function specialistSource(job: JobStartResult, workItem: string) {
  if (workItem === "foundation") return join(job.stateDir, "foundation.json");
  if (workItem.startsWith("event-"))
    return join(job.stateDir, "event-items", workItem.slice(6) + ".json");
  if (workItem.startsWith("composition-"))
    return join(job.stateDir, "composition-items", workItem.slice(12) + ".json");
  const interactive = workItem.match(/^interactive-(choice|puzzle)-([a-z][a-z0-9-]*)$/);
  if (interactive) return join(job.stateDir, "interactive-items", interactive[2] + ".json");
  const focus = workItem.match(/^focus:([a-z][a-z0-9.-]*)$/);
  if (focus) return join(job.stateDir, "focused-items", focus[1] + ".json");
  if (["world-foundations", "character-foundations"].includes(workItem))
    return join(job.stateDir, "character-world.json");
  return null;
}
/** Establish origin from the *committed writer receipt*, not model-supplied
 * instructions. A missing or unsafe session is a recoverable blocker. */
export async function readRejectedRepairOrigin(job: JobStartResult, point: RecoveryCheckpoint): Promise<RepairOrigin> {
  if (point.workItem.startsWith("repair-")) {
    const previous = await inspectRejectedRepair(job, point.workItem.slice(7));
    if (previous.repairedCommitSha !== point.commitSha ||
        !["failed", "blocked", "passed"].includes(previous.phase))
      throw Error("The rejected repair does not have a closed original-session receipt.");
    return previous.origin;
  }
  const source = specialistSource(job, point.workItem);
  if (!source) throw Error("This specialist has no registered original-session repair adapter; preserve the rejected checkpoint.");
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000)
    throw Error("Unsafe original specialist receipt.");
  const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, any>;
  const foundation = point.workItem === "foundation";
  const unit = raw.units ? raw.units.find((u: { id: string }) => u.id === point.workItem) : raw;
  if (raw.jobId !== job.jobId || (foundation ? raw.workerMode !== "pi" ||
      !!raw.chatApprovalDigest || raw.stage !== "committed" ||
      raw.validation !== "passed" ||
      JSON.stringify([raw.target]) !== JSON.stringify(point.assurance?.changedPaths) :
      raw.worker !== "pi") || !unit ||
      (foundation ? unit.stage : unit.phase) !== "committed" ||
      unit.commitSha !== point.commitSha ||
      !raw.snapshot || !raw.provider || !raw.model)
    throw Error("Failed review cannot be repaired without the original committed Pi writer identity.");
  const sessionFile: string | undefined = unit.piSessionFile ?? unit.sessionFile;
  let sessionId: string | undefined = unit.piSessionId ?? unit.sessionId;
  const sessionDir = foundation
    ? join(job.stateDir, "foundation-sessions") + sep
    : point.workItem.startsWith("event-")
      ? join(job.stateDir, "event-sessions", point.workItem) + sep
    : point.workItem.startsWith("composition-")
      ? join(job.stateDir, "composition-sessions", point.workItem, "write") + sep
      : point.workItem.startsWith("interactive-")
        ? join(job.stateDir, "interactive-sessions", "interactive-" +
          point.workItem.split("-").slice(2).join("-"), point.workItem.split("-")[1]!) + sep
        : point.workItem.startsWith("focus:")
          ? join(job.stateDir, "focused-sessions", point.workItem.slice(6)) + sep
          : join(job.stateDir, "character-world-sessions",
            point.workItem === "world-foundations" ? "world" : "character") + sep;
  if (!sessionFile?.startsWith(sessionDir) ||
      !existsSync(sessionFile) || await realpath(sessionFile) !== sessionFile ||
      !(await lstat(sessionFile)).isFile())
    throw Error("Original specialist transcript is absent or outside its pinned session directory.");
  const lines = (await readFile(sessionFile, "utf8")).trim().split("\n");
  const header = JSON.parse(lines[0]!) as { type?: string; id?: string };
  sessionId ??= header.id;
  if (!sessionId || header.type !== "session" || header.id !== sessionId)
    throw Error("Original Pi session header is inconsistent with the writer receipt.");
  if (foundation)
    await verifyJobPiSession(job, "foundation", sessionFile, sessionId);
  else if (point.workItem.startsWith("event-"))
    await verifyJobPiSession(job, "event", sessionFile, sessionId, point.workItem);
  else if (point.workItem.endsWith("-foundations"))
    await verifyJobPiSession(job, point.workItem === "world-foundations" ? "world" : "character",
      sessionFile, sessionId);
  return { workItem: point.workItem, sessionFile, sessionId, provider: raw.provider,
    model: raw.model, thinking: raw.thinking, snapshot: raw.snapshot };
}
function sourceOf(result: IndependentReviewResult) {
  return hash(result);
}
async function verifiedFailure(job: JobStartResult, point: RecoveryCheckpoint) {
  const saved = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === point.commitSha && p.proofDigest === point.proofDigest);
  if (!saved || !saved.assurance || JSON.stringify(saved.assurance) !==
      JSON.stringify(point.assurance)) throw Error("Rejected checkpoint no longer matches sealed evidence.");
  const review = await inspectCheckpointReview(job, saved);
  if (review?.status !== "failed" || !review.result)
    throw Error("Only a source-linked sealed independent review failure can start repair.");
  return review.result;
}
export async function beginRejectedRepair(job: JobStartResult, point: RecoveryCheckpoint) {
  if (!SHA.test(point.commitSha)) throw Error("Invalid rejected commit.");
  if (existsSync(pathFor(job, point.commitSha))) return inspectRejectedRepair(job, point.commitSha);
  const failure = await verifiedFailure(job, point);
  const plan = await readReviewTurnEvidence(job);
  const original = plan?.assignments.find(a => a.id === point.assurance?.assignmentId);
  const assignment = original ? await repairReviewAssignment(job, point.workItem, original) : null;
  if (!assignment || point.assurance?.assignmentDigest !== hash(assignment))
    throw Error("Rejected specialist assignment is not pinned to the original Turn.");
  const head = await trustedHead(job);
  if (!isAncestor(job, point.commitSha, head) ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Repair needs a clean verified descendant of the failed checkpoint.");
  const previous = point.workItem.startsWith("repair-")
    ? await inspectRejectedRepair(job, point.workItem.slice(7)) : null;
  const originWorkItem = previous?.origin.workItem ?? point.workItem;
  const eventMilestone = point.workItem.startsWith("event-") &&
      point.assurance!.changedPaths.some(p => p.startsWith("milestones/"))
    ? await readEventMilestoneRepairGrant(job, point, assignment)
    : previous?.planAmendment.eventMilestone &&
        point.assurance!.changedPaths.includes(previous.planAmendment.eventMilestone.path)
      ? previous.planAmendment.eventMilestone : undefined;
  // The original Event owner can correct its Event only after a separate
  // Character specialist has committed and passed independent source review.
  const eventCharacter = originWorkItem.startsWith("event-")
    ? await inspectReviewEventSupport(job, previous?.rootFailureSha ?? point.commitSha)
    : null;
  if (reviewNeedsDependency(point.assurance!, failure, originWorkItem, eventMilestone) &&
      !eventCharacter) {
    const request = deriveReviewDependencyRequest({
      assurance: point.assurance!, review: failure, original: assignment,
      turn: plan!, planVersion: point.planVersion ?? plan!.version,
      originWorkItem, eventMilestone,
    });
    await withStoryJobLock(job, "review-dependency-request", () =>
      recordReviewDependency(job, request));
    throw new ReviewDependencyRequiredError(request);
  }
  const origin = await readRejectedRepairOrigin(job, point);
  const planAmendment = deriveReviewRepairAmendment({ assurance: point.assurance!,
    review: failure, original: assignment, planVersion: point.planVersion ?? plan!.version,
    originWorkItem: origin.workItem,
    ...(eventCharacter ? { eventCharacter } : { eventMilestone }) });
  const root = previous?.rootFailureSha ?? point.commitSha;
  const rootReview = previous?.originalReviewDigest ?? sourceOf(failure);
  const rootSource = previous?.originalSource ?? failure.source;
  // Admission is one serialized controller mutation: checking the old receipt,
  // charging/creating the Turn finding and publishing the repair state must
  // not race another resume or specialist writer. The next-failure caller
  // already owns this same Story lease, so it must not acquire it recursively.
  const admit = async () => {
    if (existsSync(pathFor(job, point.commitSha)))
      return inspectRejectedRepair(job, point.commitSha);
    if (await trustedHead(job) !== head ||
        git(job, "status", "--porcelain=v1", "--untracked-files=all"))
      throw Error("Repair source changed before serialized admission.");
    const ledger = await inspectRepairLedger(job, point.assurance!.turnDigest);
    if (previous?.attempts &&
        ledger.corrections.filter(c => c.rootFailureSha === root).length < previous.attempts)
      throw Error("Existing pre-ledger correction receipts require explicit reconciliation; do not reset prior budgets.");
    await admitRepairFinding(job, {
      turnDigest: point.assurance!.turnDigest, rootFailureSha: root,
      sourceSha: point.commitSha, reviewDigest: sourceOf(failure),
      assignmentId: assignment.id, obligation: assignment.outcome,
      findings: failure.findings,
    });
    const state: RepairReceipt = {
      version: 1, jobId: job.jobId, threadId: job.threadId,
      sourceCommitSha: point.commitSha, rootFailureSha: root,
      sourceReviewDigest: sourceOf(failure), originalReviewDigest: rootReview,
      originalSource: rootSource, source: failure.source,
      findings: structuredClone(failure.findings), planAmendment, assignment,
      allowedPaths: [...planAmendment.assignment.authority.existingPaths], origin,
      sessionSha256: hash(await readFile(origin.sessionFile)),
      phase: "ready", attempts: previous?.attempts ?? 0, baselineHead: head,
      ...(previous?.revision ? { revision: previous.revision } : {}),
      ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}),
    };
    await save(job, state);
    return state;
  };
  const owner = activeStoryWriter();
  if (owner?.active && owner.job.jobId === job.jobId &&
      owner.job.stateDir === job.stateDir) return admit();
  return withStoryJobLock(job, "rejected-review-admission", admit);
}
export async function inspectRejectedRepair(job: JobStartResult, sha: string): Promise<RepairReceipt> {
  if (!SHA.test(sha)) throw Error("Invalid repair source SHA.");
  const file = pathFor(job, sha), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw Error("Unsafe repair receipt.");
  const state = JSON.parse(await readFile(file, "utf8")) as RepairReceipt;
  if (state.version !== 1 || state.jobId !== job.jobId || state.threadId !== job.threadId ||
      state.sourceCommitSha !== sha || !SHA.test(state.rootFailureSha) ||
      !HASH.test(state.sourceReviewDigest) || !HASH.test(state.originalReviewDigest) ||
      !HASH.test(state.sessionSha256) ||
      (state.sessionBytesBeforeRepair !== undefined &&
        (!Number.isSafeInteger(state.sessionBytesBeforeRepair) || state.sessionBytesBeforeRepair < 1)) ||
      (state.submittedSessionSha256 !== undefined && !HASH.test(state.submittedSessionSha256)) ||
      (state.commitIntent !== undefined && (state.commitIntent.version !== 1 ||
        !SHA.test(state.commitIntent.beforeHead) ||
        !HASH.test(state.commitIntent.proofDigest) ||
        !HASH.test(state.commitIntent.sessionSha256) ||
        !Number.isSafeInteger(state.commitIntent.planVersion) ||
        state.commitIntent.planVersion < 1 ||
        !Array.isArray(state.commitIntent.paths) ||
        !state.commitIntent.paths.length ||
        state.commitIntent.paths.some(path => !originalSafePath(path)) ||
        !state.commitIntent.fileHashes ||
        Object.keys(state.commitIntent.fileHashes).sort().join("\\0") !==
          [...state.commitIntent.paths].sort().join("\\0") ||
        Object.values(state.commitIntent.fileHashes).some(value => !HASH.test(value)))) ||
      !Array.isArray(state.allowedPaths) || !state.allowedPaths.length ||
      state.allowedPaths.some(path => !originalSafePath(path) ||
        (path.startsWith("creative-direction/") && state.origin?.workItem !== "foundation")) ||
      (state.origin?.workItem === "foundation" &&
        (state.allowedPaths.length !== 1 || !state.allowedPaths[0]?.startsWith("creative-direction/"))) ||
      !Number.isSafeInteger(state.attempts) || state.attempts < 0 ||
      !["ready", "prepared", "repairing", "awaiting-author", "needs-plan", "disputing",
        "adjudicating", "validating", "awaiting-checkpoint", "reviewing", "passed", "failed", "blocked"].includes(state.phase) ||
      (state.outOfAuthority && (state.phase !== "needs-plan" ||
        !originalSafePath(state.outOfAuthority.path) ||
        !state.planAmendment.readOnlyDependencies.includes(state.outOfAuthority.path) ||
        state.outOfAuthority.sourceSha !== state.sourceCommitSha ||
        state.outOfAuthority.reviewDigest !== state.sourceReviewDigest)) ||
      (state.dispute && (!originalSafePath(state.dispute.path) ||
        !Number.isSafeInteger(state.dispute.line) || state.dispute.line < 1 ||
        !state.dispute.claim.trim() || state.dispute.claim.length > 1000 ||
        !state.findings.some(f => f.path === state.dispute!.path && f.line === state.dispute!.line) ||
        !["disputing", "adjudicating", "blocked"].includes(state.phase))))
    throw Error("Repair receipt identity or state is invalid.");
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const original = checkpoints.find(p => p.eligible && p.commitSha === state.rootFailureSha);
  const current = checkpoints.find(p => p.eligible && p.commitSha === state.sourceCommitSha);
  if (!original || !current ||
      sourceOf(await verifiedFailure(job, original)) !== state.originalReviewDigest ||
      sourceOf(await verifiedFailure(job, current)) !== state.sourceReviewDigest ||
      JSON.stringify((await verifiedFailure(job, current)).source) !== JSON.stringify(state.source) ||
      JSON.stringify(original.assurance && {
        jobId: original.assurance.jobId, commitSha: original.assurance.commitSha,
        turnDigest: original.assurance.turnDigest, assignmentId: original.assurance.assignmentId,
        assignmentDigest: original.assurance.assignmentDigest,
        diffDigest: original.assurance.diffDigest,
        validationProofDigest: original.assurance.validationProofDigest }) !== JSON.stringify(state.originalSource))
    throw Error("Repair no longer matches the original, immutable failure.");
  if (state.phase === "passed" && !state.repairedCommitSha)
    throw Error("Repair cannot pass without a reviewed successor checkpoint.");
  const sealed = await verifiedFailure(job, current);
  const turn = await readReviewTurnEvidence(job);
  if (!turn) throw Error("Repair lost its pinned original Turn plan.");
  const origin = await readRejectedRepairOrigin(job, current);
  const previous = current.workItem.startsWith("repair-")
    ? await inspectRejectedRepair(job, current.workItem.slice(7)) : null;
  const eventMilestone = current.workItem.startsWith("event-") &&
      current.assurance!.changedPaths.some(p => p.startsWith("milestones/"))
    ? await readEventMilestoneRepairGrant(job, current, state.assignment)
    : previous?.planAmendment.eventMilestone &&
        current.assurance!.changedPaths.includes(previous.planAmendment.eventMilestone.path)
      ? previous.planAmendment.eventMilestone : undefined;
  const eventCharacter = origin.workItem.startsWith("event-")
    ? await inspectReviewEventSupport(job, previous?.rootFailureSha ?? sha)
    : null;
  const expectedAmendment = deriveReviewRepairAmendment({ assurance: current.assurance!,
    review: sealed, original: state.assignment,
    planVersion: current.planVersion ?? turn.version,
    originWorkItem: origin.workItem,
    ...(eventCharacter ? { eventCharacter } : { eventMilestone }) });
  if (JSON.stringify(state.origin) !== JSON.stringify(origin) ||
      JSON.stringify(state.findings) !== JSON.stringify(sealed.findings) ||
      JSON.stringify(state.planAmendment) !== JSON.stringify(expectedAmendment) ||
      JSON.stringify([...state.allowedPaths].sort()) !==
      JSON.stringify([...expectedAmendment.assignment.authority.existingPaths].sort()))
    throw Error("Review repair plan amendment is stale, widened or differs from sealed findings.");
  if (state.repairedCommitSha) {
    const proof = await readRepairCommitProof(job, "repair-" + sha);
    if (proof.repairPlanDigest && proof.repairPlanDigest !== expectedAmendment.digest)
      throw Error("Repair commit proof differs from the source-bound correction plan.");
    const next = checkpoints.find(p => p.eligible && p.commitSha === state.repairedCommitSha);
    if (!next || next.workItem !== "repair-" + sha ||
        next.assurance?.assignmentId !== state.assignment.id)
      throw Error("Repaired commit is not a verified successor of this rejected source.");
    if (["passed", "failed", "blocked"].includes(state.phase)) {
      const sealed = await inspectCheckpointReview(job, next);
      if (sealed?.status !== (state.phase === "passed" ? "passed" : "failed") ||
          (state.successorFindings !== undefined &&
            JSON.stringify(state.successorFindings) !== JSON.stringify(sealed.result?.findings)))
        throw Error("Repair terminal state conflicts with the immutable successor verdict.");
    }
  }
  if (state.revision && (state.revision.version !== 2 ||
      state.revision.assignment.id !== state.assignment.id ||
      JSON.stringify(state.revision.assignment.authority) !== JSON.stringify(state.assignment.authority) ||
      JSON.stringify(state.revision.assignment.targets) !== JSON.stringify(state.assignment.targets) ||
      state.revision.digest !== hash({ version: state.revision.version,
        assignment: state.revision.assignment, choiceId: state.revision.choiceId,
        proposalSha256: state.revision.proposalSha256,
        principal: state.revision.principal, direction: state.revision.direction })))
    throw Error("Author-revised assignment receipt is invalid.");
  return state;
}
const originalSafePath = (path: string) => /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(path) &&
  !path.split("/").some(segment => !segment || segment === "." || segment === "..");
export function repairFeedback(state: RepairReceipt) {
  // The independent verdict cannot be edited or argued away.
  return {
    source: state.source, reviewDigest: state.sourceReviewDigest,
    assignment: state.revision?.assignment ?? state.assignment,
    findings: state.findings, amendment: state.planAmendment,
    allowedPaths: state.planAmendment?.assignment.authority.existingPaths ?? state.allowedPaths,
    attempt: state.attempts + 1,
  };
}
type EventRepairSources = Pick<import("./event-specialist.js").EventAssignment, "sourcePaths">;
/** Build actionable feedback before claiming a paid turn or touching the writer
 * transcript. The failed source and adjacent records remain immutable. */
export async function prepareRejectedRepairFeedback(job: JobStartResult, state: RepairReceipt) {
  // Attempt numbers are execution history, not a per-finding semantic limit.
  // Reviewer judgments own progress, not category/path identity matching.
  const turn = state.originalSource?.turnDigest;
  const ledger = turn && HASH.test(turn) ? await inspectRepairLedger(job, turn) : null;
  const submitted = ledger?.corrections.filter(c =>
    c.rootFailureSha === state.rootFailureSha).length ?? state.attempts;
  const guidance = ledger?.authorGrants?.filter(grant =>
    grant.rootFailureSha === state.rootFailureSha).at(-1);
  const steering = turn
    ? await steeringForAssignment(job, turn, state.assignment.id, await trustedHead(job))
    : "";
  const feedback = { ...repairFeedback(state),
    ...(guidance ? { authorGuidance: {
      direction: guidance.guidance, grantId: guidance.id,
      warning: "Author guidance does not change the original protected canon, approved objective, or write scope. Obtain separate exact approval for any such change.",
    } } : {}),
    ...(steering ? { authenticatedSafeBoundarySteering: steering } : {}),
    attempt: Math.max(submitted, state.attempts) + 1 };
  const event = state.origin.workItem.startsWith("event-");
  let sourcePaths: string[] = [];
  if (event) {
    // The original committed Event receipt was verified by inspectRejectedRepair.
    // Its selected Milestone/Arc/Character/Fact/earlier-Event sources matter even
    // when a finding only names the offending Event. Read their rejected-SHA
    // blobs, not their potentially newer worktree versions.
    const file = specialistSource(job, state.origin.workItem)!;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000)
      throw Error("Unsafe original Event source receipt.");
    const receipt = JSON.parse(await readFile(file, "utf8")) as {
      assignment?: EventRepairSources; commitSha?: string; consequenceProof?: EventConsequenceProof };
    const paths = receipt.assignment?.sourcePaths;
    if (!Array.isArray(paths) || paths.some(p => typeof p !== "string"))
      throw Error("Original Event assignment has no pinned causal sources.");
    const sealedProof = receipt.commitSha === state.sourceCommitSha &&
      receipt.consequenceProof?.version === 1 &&
      git(job, "log", "-1", "--format=%B", state.sourceCommitSha).split("\n")
        .includes("NovelTea-Event-Consequence: " +
          eventConsequenceProofDigest(receipt.consequenceProof)) &&
      Array.isArray(receipt.consequenceProof.sourceHashes)
      ? receipt.consequenceProof : undefined;
    // Include other authored Events from the exact sealed cluster. A finding
    // on one Event may depend on a sibling branch; all remain read-only unless
    // the separately authorized repair path explicitly allows a write.
    sourcePaths = [...new Set([...paths, ...(sealedProof?.sourceHashes.map(s => s.path) ?? [])])];
    const context = rejectedRepairContext(job, state, sourcePaths);
    const proof = sealedProof?.sourceHashes.every(source =>
      context.context.some(record => record.path === source.path &&
        hash(record.content) === source.sha256)) ? sealedProof : undefined;
    // The original typed slots are read-only comparison evidence. The exact
    // committed offending line and original independent finding remain primary.
    const citedEffects = proof ? state.findings.map(finding => ({
      path: finding.path, line: finding.line,
      effects: proof.events.filter(e => e.path === finding.path).flatMap(e =>
        e.outcomes.flatMap(outcome => outcome.effects.filter(effect =>
          effect.line === finding.line))),
    })) : [];
    return { ...feedback, ...context, causalGrounding: EVENT_CAUSAL_GROUNDING,
      ...(proof ? { originalConsequenceProof: proof, citedEffects } : {}) };
  }
  return { ...feedback, ...rejectedRepairContext(job, state, sourcePaths) };
}
export async function claimRejectedRepair(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "ready")
    throw Error("No safe repair attempt is ready; preserve the original session and draft.");
  if (await trustedHead(job) !== state.baselineHead ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Repair source moved or worktree contains a draft; never overwrite it.");
  const originalTranscript = await readFile(state.origin.sessionFile);
  if (hash(originalTranscript) !== state.sessionSha256)
    throw Error("Original Pi transcript changed; do not silently start a new session.");
  state.sessionBytesBeforeRepair = originalTranscript.length;
  // Preparing has no model or writing side effects. A second, durable
  // dispatch marker is mandatory before the first external Pi prompt.
  state.phase = "prepared";
  await save(job, state);
  return state;
}

/** A prepared claim is proven unstarted only by the durable pre-dispatch
 * phase AND the unchanged pinned session, Git source and attempt ledger.
 * Clean Git by itself is never evidence that a writer did not run. */
export async function inspectPreparedRepairDispatch(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "prepared") throw Error("Repair has no unstarted dispatch to reconcile.");
  if (state.sessionBytesBeforeRepair === undefined ||
      state.sessionBytesBeforeRepair < 1 ||
      await trustedHead(job) !== state.baselineHead ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw new ProtocolIntegrityBlockedError("Prepared repair lost its unchanged source or writer fence");
  let transcript: Buffer;
  try {
    const stat = await lstat(state.origin.sessionFile);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        await realpath(state.origin.sessionFile) !== state.origin.sessionFile ||
        stat.size !== state.sessionBytesBeforeRepair)
      throw Error("Untrusted original session");
    transcript = await readFile(state.origin.sessionFile);
  } catch {
    throw new ProtocolIntegrityBlockedError("Prepared repair transcript is missing or changed");
  }
  if (hash(transcript) !== state.sessionSha256)
    throw new ProtocolIntegrityBlockedError("Prepared repair transcript is missing or changed");
  const ledger = await inspectRepairLedger(job, state.originalSource.turnDigest);
  if (ledger.corrections.some(c => c.rootFailureSha === state.rootFailureSha &&
      c.sourceSha === sha))
    throw new ProtocolIntegrityBlockedError("Prepared repair already has a submitted correction");
  return state;
}

/** Persist 'started' BEFORE any Pi prompt. A crash after this marker is
 * uncertain even if the transcript and Git happen to be clean; never replay. */
export async function markRejectedRepairStarted(job: JobStartResult, sha: string) {
  const state = await inspectPreparedRepairDispatch(job, sha);
  state.phase = "repairing";
  await save(job, state);
  return state;
}
/** A crash after Pi finished but before draft submission has an append-only
 * original-session transcript. An incomplete turn is never treated as a
 * submitted semantic correction. This inspection does not call Pi. */
export async function inspectCompletedRepairPiTurn(sessionFile: string,
  beforeBytes: number, originalSha256: string): Promise<"completed" | "incomplete"> {
  if (!Number.isSafeInteger(beforeBytes) || beforeBytes < 1 || !HASH.test(originalSha256))
    throw new ProtocolIntegrityBlockedError("Repair claim has no exact pre-prompt transcript fence");
  const stat = await lstat(sessionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(sessionFile) !== sessionFile ||
      stat.size > 64 * 1024 * 1024)
    throw new ProtocolIntegrityBlockedError("Original repair Pi transcript is unsafe");
  const bytes = await readFile(sessionFile);
  if (bytes.length < beforeBytes || hash(bytes.subarray(0, beforeBytes)) !== originalSha256)
    throw new ProtocolIntegrityBlockedError("Original repair Pi session prefix changed");
  const delta = bytes.subarray(beforeBytes).toString("utf8");
  if (!delta.trim()) return "incomplete";
  let records: Array<{ type?: string; message?: {
    role?: string; stopReason?: string;
    content?: Array<{ type: string; name?: string; text?: string }> } }>;
  try {
    records = delta.trim().split("\n").map(line => JSON.parse(line));
  } catch { throw new ProtocolIntegrityBlockedError("Interrupted repair transcript contains partial entries"); }
  const messages = records.filter(record => record.type === "message").map(record => record.message);
  const users = messages.filter(message => message?.role === "user");
  const finals = messages.filter(message => message?.role === "assistant" &&
    message.stopReason === "stop");
  if (users.length !== 1 || finals.length > 1 ||
      messages.some(message => message?.role === "assistant" &&
        ["error", "aborted"].includes(message.stopReason ?? "")))
    throw new ProtocolIntegrityBlockedError("Repair continuation has multiple or unsuccessful model turns");
  if (!finals.length) return "incomplete";
  if (messages.at(-1)?.role !== "assistant" ||
      messages.at(-1)?.stopReason !== "stop" ||
      !Array.isArray(finals[0]?.content) ||
      finals[0].content.some(c => c.type === "toolCall"))
    throw new ProtocolIntegrityBlockedError("Repair transcript did not complete one bounded writer response");
  return "completed";
}

/** Only the existing controller writer lease may recover a completed original
 * Pi call. Without an attributable completed response and owned Git diff,
 * preserve the dirty draft instead of replaying or clearing it. */
export async function reconcileCompletedRepairWriter(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "repairing") return state;
  if (state.sessionBytesBeforeRepair === undefined) return state;
  if (await inspectCompletedRepairPiTurn(state.origin.sessionFile,
      state.sessionBytesBeforeRepair, state.sessionSha256) !== "completed")
    return state;
  if (await trustedHead(job) !== state.baselineHead)
    throw new ProtocolIntegrityBlockedError("Repair writer HEAD differs from its claimed source");
  const paths = changedRepairPaths(job, state);
  if (!paths.length) return state;
  return finishRejectedRepairDraft(job, sha);
}

export function changedRepairPaths(job: JobStartResult, state: RepairReceipt) {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const entries = gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .split("\0").filter(Boolean);
  if (entries.some(s => s.slice(0, 2) !== " M" && s.slice(0, 2) !== "??"))
    throw Error("Repair produced staged, renamed, deleted or otherwise unsafe files.");
  const paths = entries.map(e => e.slice(3)).map(path => {
    if (!path.startsWith(prefix)) throw Error("Repair wrote outside this Story.");
    return path.slice(prefix.length);
  }).sort();
  const allowed = state.allowedPaths;
  const milestonePath = state.planAmendment?.eventMilestone?.path;
  if (paths.some(path => !allowed.includes(path) ||
      (path.startsWith("creative-direction/") && state.origin.workItem !== "foundation") ||
      path.startsWith("arcs/") || path.startsWith("narrative-positions/") ||
      path.startsWith("milestones/") && path !== milestonePath))
    throw Error("Review feedback never authorizes unrelated or protected Story changes.");
  const eventCharacter = state.planAmendment?.eventCharacter;
  if (eventCharacter) {
    if (paths.length !== 1 || paths[0] !== eventCharacter.path)
      throw Error("Event Character correction may modify only the cited, owned Event.");
    const target = join(job.worktreeStoryRoot, eventCharacter.path);
    if (realpathSync(target) !== target || !lstatSync(target).isFile())
      throw Error("Unsafe or symlinked Event correction path.");
    auditEventParticipantCorrection(
      gitRaw(job, "show", state.baselineHead + ":" + repoPath(job, eventCharacter.path)),
      readFileSync(target, "utf8"), eventCharacter.id,
      state.sourceCommitSha !== eventCharacter.failedSourceSha);
  }
  if (milestonePath && paths.includes(milestonePath)) {
    const target = join(job.worktreeStoryRoot, milestonePath);
    if (realpathSync(target) !== target || !lstatSync(target).isFile())
      throw Error("Unsafe or symlinked Milestone repair path.");
    assertMilestoneFulfillmentOnly(
      gitRaw(job, "show", state.baselineHead + ":" + repoPath(job, milestonePath)),
      readFileSync(target, "utf8"));
  }
  return paths;
}
export function disagreementQuestion(state: RepairReceipt): SpecialistChoiceQuestion {
  return {
    kind: "alternatives",
    question: "The specialist did not produce a file correction for the rejected assignment. Which direction should be followed?",
    options: [
      { id: "correct", title: "Require the original correction",
        approach: "Continue the same specialist session and correct each source-linked finding within the existing assignment.",
        benefits: "Preserves the authorized scope and original requirements.",
        tradeoffs: "May need another bounded attempt." },
      { id: "revise", title: "Revise the assignment",
        approach: "Provide a new, explicit outcome in the optional note, limited to the same authorized files and targets.",
        benefits: "Allows the author to resolve a genuine creative disagreement.",
        tradeoffs: "Requires a new source-bound assignment version and independent re-review." },
    ],
    recommendedId: "correct",
    recommendationReason: "The independent reviewer identified a concrete missing or incorrect change; a real file correction is the normal resolution.",
    context: state.findings.slice(0, 8).flatMap(f => {
      const m = f.message.match(/^.+:([1-9]\d*) /);
      return m ? [{ path: f.path, line: Number(m[1]), description: f.message.slice(0, 400) }] : [];
    }),
  };
}
/** The writer's text response is irrelevant: only actual owned Git modifications
 * can move a failed review into native validation. */
export async function finishRejectedRepairDraft(job: JobStartResult, sha: string,
  reportedOutOfAuthority?: string,
  reportedDispute?: { path: string; line: number; claim: string }) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "repairing") throw Error("Repair was not claimed in this process.");
  if (await trustedHead(job) !== state.baselineHead)
    throw Error("Repair changed verified Git HEAD; preserve draft and investigate.");
  const paths = changedRepairPaths(job, state);
  if (!paths.length) {
    if (reportedOutOfAuthority && originalSafePath(reportedOutOfAuthority) &&
        !state.allowedPaths.includes(reportedOutOfAuthority) &&
        state.planAmendment.readOnlyDependencies.includes(reportedOutOfAuthority)) {
      state.phase = "needs-plan";
      state.outOfAuthority = { path: reportedOutOfAuthority,
        sourceSha: state.sourceCommitSha, reviewDigest: state.sourceReviewDigest };
      state.failure = "The original specialist requires other-owner work at " +
        reportedOutOfAuthority + ". Return to controller planning; the original writer has no authority to edit this record.";
      state.sessionSha256 = hash(await readFile(state.origin.sessionFile));
      await save(job, state);
      return state;
    }
    if (reportedDispute && originalSafePath(reportedDispute.path) &&
        Number.isSafeInteger(reportedDispute.line) && reportedDispute.line > 0 &&
        reportedDispute.claim.trim() && reportedDispute.claim.length <= 1000 &&
        state.findings.some(f => f.path === reportedDispute.path &&
          f.line === reportedDispute.line)) {
      state.phase = "disputing";
      state.dispute = reportedDispute;
      state.sessionSha256 = hash(await readFile(state.origin.sessionFile));
      await save(job, state);
      return state;
    }
    state.phase = "awaiting-author";
    state.sessionSha256 = hash(await readFile(state.origin.sessionFile));
    const choice = await recordSpecialistChoice(job, "repair-" + sha,
      disagreementQuestion(state), state.origin.sessionId, state.origin.sessionFile);
    state.choiceId = choice.id;
    await save(job, state);
    return state;
  }
  // A claimed/incomplete Pi turn is NOT a completed correction. Charge once
  // when actual owned file changes are submitted for native verification.
  await submitRepairCorrection(job, {
    turnDigest: state.originalSource.turnDigest,
    rootFailureSha: state.rootFailureSha, sourceSha: sha, changedPaths: paths,
  });
  state.attempts++;
  state.paths = paths;
  state.draftDigest = hash(paths.map(path =>
    ({ path, diff: git(job, "diff", "--binary", "--", repoPath(job, path)) })));
  state.submittedSessionSha256 = hash(await readFile(state.origin.sessionFile));
  state.phase = "validating";
  await save(job, state);
  return state;
}
/** Native validation is mandatory; the writer's story_validate output does not
 * stand in for this controller run. Do not discard a failing draft. */
export async function validateRejectedRepairDraft(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "validating" || await trustedHead(job) !== state.baselineHead ||
      JSON.stringify(changedRepairPaths(job, state)) !== JSON.stringify(state.paths))
    throw Error("Repair draft or verified baseline differs from the pinned correction.");
  const digest = hash(state.paths!.map(path =>
    ({ path, diff: git(job, "diff", "--binary", "--", repoPath(job, path)) })));
  if (digest !== state.draftDigest) throw Error("Repair files changed after the writer returned.");
  const result = await validateStoryJob(job, undefined, { baseSha: state.baselineHead,
    worktreeRoot: job.worktreeRoot, worktreeStoryRoot: job.worktreeStoryRoot });
  const report = result.report as { diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (result.status !== "passed" || !report || !Array.isArray(report.diagnostics) ||
      report.diagnostics.length || report.protection?.status !== "checked" ||
      report.protection.base !== state.baselineHead ||
      report.protection.changes?.length || report.protection.warnings?.length)
    throw Error("Native validation/protected-canon gate rejected the repaired draft; preserve its bytes.");
  if (state.origin.workItem.startsWith("interactive-choice-")) {
    // Native structure and a prose-focused independent reviewer can both
    // approve a superficially convincing correction that deletes the ONLY
    // typed payoff for a Choice branch. Recheck the same executable Choice
    // contract used by the original specialist before sealing a new repair.
    // This merely checks the original immutable Choice unit; it never gives
    // the repair new writable paths or permission to invent an effect.
    const slug = state.origin.workItem.slice("interactive-choice-".length);
    if (!/^[a-z][a-z0-9-]*$/.test(slug))
      throw Error("Original repaired Choice identity is malformed.");
    const source = JSON.parse(await readFile(
      join(job.stateDir, "interactive-items", slug + ".json"), "utf8")) as {
      units?: Array<{ id: string; phase: string; commitSha?: string;
        paths?: string[]; obligations?: string[] }> };
    const choice = source.units?.find(unit => unit.id === state.origin.workItem);
    // A second bounded correction is anchored to the ORIGINAL Choice writer,
    // not the first repair commit. inspectRejectedRepair has already sealed
    // both negative verdicts and the exact repair-<SHA> successor chain.
    // Comparing the original unit to sourceCommitSha incorrectly rejects a
    // legitimate second correction, even though its rootFailureSha remains
    // the original independently reviewed Choice commit.
    assertOriginalChoiceRepairEvidence(choice, state.rootFailureSha);
    const { verifyRepairedChoicePayoff } = await import("./interactive-work.js");
    try {
      verifyRepairedChoicePayoff(result.report, choice.paths, choice.obligations);
    } catch (error) {
      throw Error("Repaired Choice would invalidate its previously verified causal outcome payoff: " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  state.validationProof = hash({ validator: result.validator, base: state.baselineHead,
    draft: digest, report });
  state.phase = "awaiting-checkpoint";
  await save(job, state);
  return state;
}
/** Only a separately finalized native checkpoint, built from these exact
 * validated draft bytes, can advance to independent rereview. */
export async function acceptRejectedRepairCheckpoint(job: JobStartResult,
  sha: string, point: RecoveryCheckpoint) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "awaiting-checkpoint" || !state.validationProof ||
      point.parentSha !== state.baselineHead || point.commitSha === sha ||
      !point.assurance || point.assurance.assignmentId !== state.assignment.id ||
      !point.assurance.reviewSelection.reasons.includes("previous-review-failure"))
    throw Error("A repair requires a new independently validated, review-required checkpoint.");
  const saved = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === point.commitSha &&
    p.proofDigest === point.proofDigest &&
    JSON.stringify(p.assurance) === JSON.stringify(point.assurance));
  if (!saved || JSON.stringify(saved.assurance?.changedPaths) !== JSON.stringify(state.paths))
    throw Error("Repair checkpoint must match the controller-validated changed files.");
  if (!isAncestor(job, state.sourceCommitSha, point.commitSha))
    throw Error("Repair is not descended from the original rejected work.");
  state.repairedCommitSha = point.commitSha;
  state.phase = "reviewing";
  await save(job, state);
  return state;
}
/** A correction with no changed previously rejected source, or one which
 * restores all such sources to their original rejected bytes, cannot claim
 * material source progress. This checks committed Git blobs only, never
 * matches semantic issue identities or overrules independent review. */
export function detectRepairStagnation(job: JobStartResult, state: RepairReceipt,
  review: IndependentReviewResult): "no-progress" | "oscillation" | null {
  if (review.status !== "failed" || !state.repairedCommitSha) return null;
  // The prior reviewer may accept one corrected concern while exposing a
  // different same-file or downstream issue. Do not count issues by matching
  // their type, category or targets; check whether *any* previously rejected
  // owned source materially changed before declaring complete stagnation.
  const rejectedPaths = [...new Set(state.findings.map(f => f.path))];
  if (!rejectedPaths.length) return null;
  const sameAs = (previousSha: string) => rejectedPaths.every(path =>
    gitRaw(job, "show", previousSha + ":" + repoPath(job, path)) ===
      gitRaw(job, "show", state.repairedCommitSha! + ":" + repoPath(job, path)));
  if (sameAs(state.sourceCommitSha)) return "no-progress";
  if (state.rootFailureSha !== state.sourceCommitSha && sameAs(state.rootFailureSha))
    return "oscillation";
  return null;
}
/** Pure terminal transition after the controller has verified the independent
 * successor receipt. Keeping both verdicts separate makes restart validation
 * against the original source possible after a second negative finding. */
export function repairReviewOutcome(state: RepairReceipt, review: IndependentReviewResult,
  stopForNonconvergence = false): RepairReceipt {
  if (state.phase !== "reviewing" || !state.repairedCommitSha ||
      review.source.commitSha !== state.repairedCommitSha)
    throw Error("Repair verdict must refer to its reviewed successor.");
  const failed = review.status === "failed";
  const phase = !failed ? "passed" : stopForNonconvergence ? "blocked" : "failed";
  return { ...state, phase, successorFindings: structuredClone(review.findings),
    ...(failed ? { baselineHead: state.repairedCommitSha,
      failure: phase === "blocked"
        ? "Correction did not converge; inspect the preserved source, sessions and independent findings."
        : undefined } : {}),
  };
}
export async function finishRejectedRepairReview(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "reviewing" || !state.repairedCommitSha)
    throw Error("Repair has no independently reviewed successor.");
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === state.repairedCommitSha);
  if (!point) throw Error("Repair successor checkpoint is unavailable.");
  const review = await inspectCheckpointReview(job, point);
  if (!review || !["passed", "failed"].includes(review.status) || !review.result)
    throw Error("A new independent semantic verdict is mandatory after repaired file changes.");
  await settleRepairReview(job, {
    turnDigest: state.originalSource.turnDigest,
    rootFailureSha: state.rootFailureSha, sourceSha: sha,
    successorSha: state.repairedCommitSha, reviewDigest: sourceOf(review.result),
    assignmentId: state.assignment.id, obligation: state.assignment.outcome,
    status: review.result.status, findings: review.result.findings,
  });
  // The ledger seals one completed submission and its verdict. Whether the
  // correction improved the narrative belongs to the independent Review cycle,
  // never a numerical local/Turn retry allowance.
  const finished = repairReviewOutcome(state, review.result);
  if (review.status === "failed" && point.assurance) {
    const cycle = await inspectPostcommitReviewCycle(job,
      state.rootFailureSha, point.assurance.assignmentDigest);
    if (cycle && postcommitDiagnosticReason(cycle.rounds.length)) {
      const diagnosis = await readPostcommitDiagnosis(job, cycle, state.repairedCommitSha);
      if (!diagnosis)
        throw Error("Postcommit Diagnostic source-bound review is missing; reconcile its immutable Pi transcript.");
      if (diagnosis.diagnosis.action !== "continue") {
        finished.phase = "blocked";
        finished.failure = "Independent Diagnostic requested " +
          diagnosis.diagnosis.action + " after review of the same verified source: " +
          diagnosis.diagnosis.explanation + ". Preserve the negative verdict; obtain " +
          "controller-authorized reviewer replacement, plan amendment or author escalation.";
      }
    }
  }
  const stagnation = detectRepairStagnation(job, state, review.result);
  if (stagnation) {
    finished.phase = "blocked";
    finished.failure = stagnation === "oscillation"
      ? "Correction restored previously rejected source bytes; stop oscillation and request a new bounded strategy."
      : "Correction did not change the source records still rejected by independent review; stop ineffective same-writer retries.";
  }
  if (review.status === "failed")
    finished.sessionSha256 = hash(await readFile(state.origin.sessionFile));
  await save(job, finished);
  return finished;
}
/** The authenticated Author Choice is kept separate from protected approval.
 * An author revision may narrow/rephrase the outcome but never grant new paths,
 * record kinds or protected-canon authority. */
export async function consumeRejectedRepairChoice(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (!state.choiceId || !["awaiting-author", "ready"].includes(state.phase))
    throw Error("No pending rejected-work choice.");
  const choice = await inspectSpecialistChoice(job, state.choiceId);
  if (state.phase === "ready") {
    // The controller saved the revised assignment before consuming the
    // separately signed choice. A crash at that boundary is idempotent.
    if (!["resuming", "consumed"].includes(choice.phase))
      throw Error("A ready repair has an unconsumed, inconsistent author choice.");
    if (choice.phase === "resuming") await completeSpecialistChoice(job, state.choiceId);
    return state;
  }
  if (!["answered", "resuming"].includes(choice.phase) || !choice.answer)
    throw Error("Only an exact authenticated answered choice can revise repair.");
  if (await trustedHead(job) !== state.baselineHead)
    throw Error("Author choice is stale for the repaired baseline.");
  const selected = choice.answer.kind === "option" ? choice.answer.optionId : "revise";
  if (!["correct", "revise"].includes(selected))
    throw Error("Unknown author repair choice.");
  const revisionText = choice.answer.kind === "custom"
    ? choice.answer.text : choice.answer.note;
  if (selected === "revise" && !revisionText?.trim() && choice.answer.kind === "option") {
    // The alternative is meaningful even if the author did not enter an
    // optional note. Request the required outcome through a new authenticated
    // free-text step rather than trapping a consumed answer in an error state.
    if (choice.phase === "answered") await claimSpecialistChoice(job, state.choiceId);
    await completeSpecialistChoice(job, state.choiceId);
    const followup = await recordSpecialistChoice(job, "repair-" + sha, {
      kind: "free-text",
      question: "What exact revised outcome should the specialist deliver within the existing authorized files and targets? Protected canon requires separate approval.",
      context: disagreementQuestion(state).context,
    }, state.origin.sessionId, state.origin.sessionFile);
    state.choiceId = followup.id;
    await save(job, state);
    return state;
  }
  if (selected === "revise" && (!revisionText?.trim() || revisionText.length > 2000))
    throw Error("Assignment revision requires a precise author-written new outcome.");
  if (choice.phase === "answered") await claimSpecialistChoice(job, state.choiceId);
  if (selected === "revise") {
    const assignment = { ...state.assignment, outcome: revisionText.trim() };
    const revision = { version: 2, assignment, choiceId: choice.id,
      proposalSha256: choice.proposalSha256, principal: choice.answer.principal,
      direction: authorChoiceDirection(choice.question, choice.answer, choice.delegationAllowed === true) };
    state.revision = { ...revision, digest: hash(revision) };
  }
  state.phase = "ready";
  state.sessionSha256 = hash(await readFile(state.origin.sessionFile));
  await save(job, state);
  await completeSpecialistChoice(job, state.choiceId);
  return state;
}

/** Foundation-only bootstrap: an initial standalone Foundation is trusted
 * from its committed writer receipt before there is any revision ledger.
 * Attest that exact sealed checkpoint and create the ledger BEFORE publishing
 * a correction, so a missing ledger can never strand an already-made commit. */
async function ensureRepairLedger(job: JobStartResult, state: RepairReceipt) {
  const file = join(job.stateDir, "revisions", "verified-head.json");
  if (!existsSync(file)) {
    const source = (await inspectRecoveryCheckpoints(job)).find(point =>
      point.eligible && point.commitSha === state.sourceCommitSha &&
      point.workItem === "foundation" && point.semanticReview === "failed");
    if (state.origin.workItem !== "foundation" ||
        state.baselineHead !== state.sourceCommitSha || !source ||
        await trustedHead(job) !== state.sourceCommitSha)
      throw Error("Repair requires an existing trusted verified-head ledger.");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, jobId: job.jobId,
      headSha: state.sourceCommitSha, workItemId: "foundation" }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
  }
  const prior = JSON.parse(await readFile(file, "utf8")) as {
    version: number; jobId: string; headSha: string };
  if (prior.version !== 1 || prior.jobId !== job.jobId ||
      prior.headSha !== state.baselineHead)
    throw Error("The verified-head ledger moved before repair publication.");
  return file;
}

/** Identical from pre-commit intent through recovered proof. */
function repairPublicationDigest(sha: string, state: RepairReceipt) {
  return hash({
    workItemId: "repair-" + sha, sourceCommitSha: sha,
    rootFailureSha: state.rootFailureSha, sourceReviewDigest: state.sourceReviewDigest,
    assignmentId: state.assignment.id, assignmentRevision: state.revision?.digest ?? null,
    nativeProof: state.validationProof, draft: state.draftDigest,
    paths: state.paths, repairPlanDigest: state.planAmendment.digest,
  });
}

function repairPublicationProof(job: JobStartResult, sha: string, state: RepairReceipt,
  commitSha: string, intent: RepairCommitIntent): RepairCommitProof {
  return {
    version: 1, jobId: job.jobId, threadId: job.threadId, branch: job.branch,
    baseSha: job.baseSha, phase: "committed", worker: "pi", workItemId: "repair-" + sha,
    sourceCommitSha: sha, rootFailureSha: state.rootFailureSha,
    sourceReviewDigest: state.sourceReviewDigest, originalReviewDigest: state.originalReviewDigest,
    assignmentId: state.assignment.id,
    assignmentDigest: hash(state.revision?.assignment ?? state.assignment),
    ...(state.revision ? { assignmentRevision: state.revision } : {}),
    beforeHead: intent.beforeHead, commitSha, paths: [...intent.paths],
    digest: intent.proofDigest,
    validation: { status: "passed", validatorVersion: job.validatorVersion,
      proofDigest: state.validationProof! },
    sessionFile: state.origin.sessionFile, sessionId: state.origin.sessionId,
    sessionSha256: intent.sessionSha256,
    provider: state.origin.provider, model: state.origin.model,
    snapshot: state.origin.snapshot, planVersion: intent.planVersion,
    repairPlanDigest: state.planAmendment.digest,
  };
}

/** Recover the narrow crash boundary where Git and its immutable native
 * proof were committed but the verified-head ledger was not yet published.
 * Reconstruct only from the exact Foundation source and fully bound proof;
 * never infer success from a draft, writer assertion or arbitrary moving HEAD.
 * This must happen before ordinary checkpoint inspection, which correctly
 * refuses an unpublished commit. No Pi call is replayed. */
async function recoverInterruptedFoundationRepair(job: JobStartResult, sha: string) {
  const ledger = join(job.stateDir, "revisions", "verified-head.json");
  const proofPath = join(job.stateDir, "review-repairs", "proofs", sha + ".json");
  if (existsSync(ledger) || !existsSync(proofPath)) return;
  const statePath = pathFor(job, sha);
  const stat = await lstat(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw Error("Unsafe interrupted Foundation repair state.");
  const state = JSON.parse(await readFile(statePath, "utf8")) as RepairReceipt;
  const proof = await readRepairCommitProof(job, "repair-" + sha);
  const foundation = JSON.parse(await readFile(join(job.stateDir, "foundation.json"), "utf8")) as {
    jobId?: string; stage?: string; workerMode?: string; commitSha?: string; validation?: string;
  };
  const commitPaths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", proof.commitSha)
    .split("\n").filter(Boolean).sort();
  const expectedPaths = proof.paths.map(path => repoPath(job, path)).sort();
  const requiredDigest = hash({
    workItemId: "repair-" + sha, sourceCommitSha: sha,
    rootFailureSha: state.rootFailureSha, sourceReviewDigest: state.sourceReviewDigest,
    assignmentId: state.assignment?.id, assignmentRevision: state.revision?.digest ?? null,
    nativeProof: state.validationProof, draft: state.draftDigest,
    paths: state.paths, repairPlanDigest: state.planAmendment?.digest,
  });
  if (state.jobId !== job.jobId || state.threadId !== job.threadId ||
      state.phase !== "awaiting-checkpoint" || state.sourceCommitSha !== sha ||
      state.rootFailureSha !== sha || state.origin?.workItem !== "foundation" ||
      state.baselineHead !== sha || foundation.jobId !== job.jobId ||
      foundation.stage !== "committed" || foundation.workerMode !== "pi" ||
      foundation.commitSha !== sha || foundation.validation !== "passed" ||
      proof.beforeHead !== sha || proof.sourceCommitSha !== sha ||
      proof.repairPlanDigest !== state.planAmendment?.digest ||
      proof.sourceReviewDigest !== state.sourceReviewDigest ||
      proof.validation.proofDigest !== state.validationProof ||
      proof.digest !== requiredDigest ||
      proof.sessionFile !== state.origin.sessionFile ||
      proof.sessionId !== state.origin.sessionId ||
      proof.sessionSha256 !== hash(await readFile(proof.sessionFile)) ||
      git(job, "rev-parse", "HEAD") !== proof.commitSha ||
      git(job, "rev-parse", "HEAD^") !== sha ||
      git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all") ||
      JSON.stringify(commitPaths) !== JSON.stringify(expectedPaths) ||
      !git(job, "log", "-1", "--format=%B", proof.commitSha)
        .split("\n").includes("NovelTea-Review-Repair: " + proof.digest))
    throw Error("Interrupted repair proof cannot authorize restoration of a verified HEAD.");
  await mkdir(dirname(ledger), { recursive: true, mode: 0o700 });
  await writeFile(ledger, JSON.stringify({ version: 1, jobId: job.jobId,
    headSha: proof.commitSha, workItemId: "repair-" + sha }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
}

/** Reconcile an original repair commit made immediately before process death.
 * This only publishes missing receipts for an exact, already validated Git
 * tree. It never runs a validator, replays Pi or advances another branch.
 * Caller must hold the existing Story job lease. */
export async function reconcileUnpublishedRepairCommit(job: JobStartResult, sha: string) {
  if (!SHA.test(sha)) throw new ProtocolIntegrityBlockedError("Invalid rejected source SHA");
  const file = pathFor(job, sha);
  if (!existsSync(file)) return null;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw new ProtocolIntegrityBlockedError("Untrusted repair controller receipt");
  let state: RepairReceipt;
  try { state = JSON.parse(await readFile(file, "utf8")) as RepairReceipt; }
  catch { throw new ProtocolIntegrityBlockedError("Unreadable repair controller receipt"); }
  if (state.jobId !== job.jobId || state.threadId !== job.threadId ||
      state.sourceCommitSha !== sha)
    throw new ProtocolIntegrityBlockedError("Repair source does not match this job");
  if (state.phase !== "awaiting-checkpoint") return null;
  const head = git(job, "rev-parse", "HEAD");
  if (head === state.baselineHead) return null; // A draft has not crossed Git yet.
  const intent = state.commitIntent;
  if (!intent || intent.version !== 1 || !state.validationProof ||
      !state.submittedSessionSha256 || !state.draftDigest ||
      intent.beforeHead !== state.baselineHead ||
      intent.sessionSha256 !== state.submittedSessionSha256 ||
      intent.proofDigest !== repairPublicationDigest(sha, state) ||
      !Array.isArray(state.paths) || !state.paths.length ||
      JSON.stringify(state.paths) !== JSON.stringify(intent.paths) ||
      !intent.paths.every(p => originalSafePath(p) && state.allowedPaths.includes(p)) ||
      !intent.fileHashes ||
      Object.keys(intent.fileHashes).sort().join("|") !== [...intent.paths].sort().join("|") ||
      Object.values(intent.fileHashes).some(value => !HASH.test(value)) ||
      !Number.isSafeInteger(intent.planVersion) || intent.planVersion < 1)
    throw new ProtocolIntegrityBlockedError("Unpublished commit lacks an exact validated source intent");
  if (git(job, "rev-parse", "HEAD^") !== intent.beforeHead ||
      git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw new ProtocolIntegrityBlockedError("Repair branch, parent or dirty worktree differs");
  const commitPaths = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", head)
    .split("\n").filter(Boolean).sort();
  const expectedPaths = intent.paths.map(path => repoPath(job, path)).sort();
  const trailers = git(job, "log", "-1", "--format=%B", head).split("\n");
  if (JSON.stringify(commitPaths) !== JSON.stringify(expectedPaths) ||
      !trailers.includes("NovelTea-Job: " + job.jobId) ||
      !trailers.includes("NovelTea-Work-Item: repair-" + sha) ||
      !trailers.includes("NovelTea-Plan-Version: " + intent.planVersion) ||
      !trailers.includes("NovelTea-Review-Repair: " + intent.proofDigest))
    throw new ProtocolIntegrityBlockedError("Git commit provenance or inventory differs from validated intent");
  for (const path of intent.paths) {
    if (hash(gitRaw(job, "show", head + ":" + repoPath(job, path))) !== intent.fileHashes[path])
      throw new ProtocolIntegrityBlockedError("Committed canonical bytes differ from validated draft");
  }
  const sourceFile = join(job.stateDir, "recovery-checkpoints", sha + ".json");
  const source = JSON.parse(await readFile(sourceFile, "utf8")) as RecoveryCheckpoint;
  if (source.jobId !== job.jobId || source.commitSha !== sha ||
      !source.assurance || source.assurance.assignmentId !== state.assignment?.id ||
      (source.planVersion ?? state.planAmendment.basePlanVersion) !== intent.planVersion ||
      !isAncestor(job, sha, intent.beforeHead))
    throw new ProtocolIntegrityBlockedError("Rejected checkpoint or source grant has changed");
  const failed = await readIndependentReview(job, source.assurance);
  if (failed.status !== "failed" || !failed.result ||
      sourceOf(failed.result) !== state.sourceReviewDigest)
    throw new ProtocolIntegrityBlockedError("Original independent failed review is missing or changed");
  const transcriptStat = await lstat(state.origin.sessionFile);
  if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink() ||
      await realpath(state.origin.sessionFile) !== state.origin.sessionFile ||
      hash(await readFile(state.origin.sessionFile)) !== intent.sessionSha256)
    throw new ProtocolIntegrityBlockedError("Original submitted Pi transcript has changed");
  const proofPath = join(job.stateDir, "review-repairs", "proofs", sha + ".json");
  if (!existsSync(proofPath)) {
    await mkdir(dirname(proofPath), { recursive: true, mode: 0o700 });
    const proof = repairPublicationProof(job, sha, state, head, intent);
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
  }
  const proof = await readRepairCommitProof(job, "repair-" + sha);
  if (proof.commitSha !== head || proof.beforeHead !== intent.beforeHead ||
      proof.digest !== intent.proofDigest || proof.sessionSha256 !== intent.sessionSha256 ||
      proof.validation.proofDigest !== state.validationProof ||
      JSON.stringify(proof.paths) !== JSON.stringify(intent.paths))
    throw new ProtocolIntegrityBlockedError("Recovered immutable repair proof conflicts with pre-commit intent");
  await recoverInterruptedFoundationRepair(job, sha);
  const verifiedFile = join(job.stateDir, "revisions", "verified-head.json");
  if (!existsSync(verifiedFile))
    throw new ProtocolIntegrityBlockedError("Original verified-head predecessor is missing");
  const ledger = JSON.parse(await readFile(verifiedFile, "utf8")) as {
    version: number; jobId: string; headSha: string; workItemId: string };
  if (ledger.version !== 1 || ledger.jobId !== job.jobId ||
      ![intent.beforeHead, head].includes(ledger.headSha) ||
      (ledger.headSha === head && ledger.workItemId !== "repair-" + sha))
    throw new ProtocolIntegrityBlockedError("Verified-head ledger differs from repair predecessor");
  if (ledger.headSha === intent.beforeHead) {
    const tmp = verifiedFile + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify({ version: 1, jobId: job.jobId,
      headSha: head, workItemId: "repair-" + sha }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    await rename(tmp, verifiedFile);
  }
  const point = await finalizeRecoveryCheckpoint(job, "repair-" + sha, intent.beforeHead, head);
  return acceptRejectedRepairCheckpoint(job, sha, point);
}

/** Commit only the controller's exact validated draft, with an immutable
 * repair proof and native recovery checkpoint. Caller owns the writer lease.
 * Never reset or clean an interrupted draft or an unrecognized commit. */
export async function commitRejectedRepairDraft(job: JobStartResult, sha: string) {
  const recovered = await reconcileUnpublishedRepairCommit(job, sha);
  if (recovered) return recovered;
  const state = await inspectRejectedRepair(job, sha);
  const workItemId = "repair-" + sha;
  const existingProof = join(job.stateDir, "review-repairs", "proofs", sha + ".json");
  if (existsSync(existingProof)) {
    const { readRepairCommitProof } = await import("./checkpoint-assurance.js");
    const proof = await readRepairCommitProof(job, workItemId);
    const point = await finalizeRecoveryCheckpoint(job, workItemId,
      proof.beforeHead, proof.commitSha);
    return acceptRejectedRepairCheckpoint(job, sha, point);
  }
  if (state.phase !== "awaiting-checkpoint" || !state.validationProof ||
      !state.draftDigest || !state.paths?.length ||
      await trustedHead(job) !== state.baselineHead ||
      JSON.stringify(changedRepairPaths(job, state)) !== JSON.stringify(state.paths))
    throw Error("Repair has no exact native-validated draft ready to commit.");
  const digestNow = hash(state.paths.map(path =>
    ({ path, diff: git(job, "diff", "--binary", "--", repoPath(job, path)) })));
  if (digestNow !== state.draftDigest)
    throw Error("Draft changed after native validation; do not commit stale work.");
  const original = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === sha);
  if (!original?.assurance || (original.planVersion !== null &&
      original.planVersion !== state.planAmendment.basePlanVersion))
    throw Error("Repair lost its original validated, versioned checkpoint.");
  // Foundation checkpoints predate Architecture's own plan. They are still
  // source-bound to the immutable Turn work-plan version saved in the overlay.
  const planVersion = original.planVersion ?? state.planAmendment.basePlanVersion;
  const headFile = await ensureRepairLedger(job, state);
  const proofDigest = repairPublicationDigest(sha, state);
  const transcriptDigest = hash(await readFile(state.origin.sessionFile));
  if (!state.submittedSessionSha256 || transcriptDigest !== state.submittedSessionSha256)
    throw new ProtocolIntegrityBlockedError("Submitted repair Pi transcript changed before Git publication");
  const intent: RepairCommitIntent = {
    version: 1, beforeHead: state.baselineHead, proofDigest, planVersion,
    sessionSha256: transcriptDigest, paths: [...state.paths],
    fileHashes: Object.fromEntries(await Promise.all(state.paths.map(async path => {
      const target = join(job.worktreeStoryRoot, path);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(target) !== target)
        throw new ProtocolIntegrityBlockedError("Unsafe validated repair file before Git publication");
      return [path, hash(await readFile(target))];
    }))),
  };
  if (state.commitIntent && JSON.stringify(state.commitIntent) !== JSON.stringify(intent))
    throw new ProtocolIntegrityBlockedError("Existing repair publication intent disagrees with validated draft");
  if (!state.commitIntent) {
    state.commitIntent = intent;
    await save(job, state);
  }
  git(job, "add", "--", ...state.paths.map(path => repoPath(job, path)));
  git(job, "-c", "user.name=NovelTea Generator",
    "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m",
    "Correct rejected specialist assignment [" + job.jobId + "]\n\n" +
    "NovelTea-Job: " + job.jobId + "\n" +
    "NovelTea-Work-Item: " + workItemId + "\n" +
    "NovelTea-Plan-Version: " + planVersion + "\n" +
    "NovelTea-Review-Repair: " + proofDigest);
  const commitSha = git(job, "rev-parse", "HEAD");
  if (git(job, "rev-parse", "HEAD^") !== state.baselineHead ||
      git(job, "symbolic-ref", "--short", "HEAD") !== job.branch ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all") ||
      JSON.stringify(git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", commitSha)
        .split("\n").filter(Boolean).sort()) !==
        JSON.stringify(state.paths.map(p => repoPath(job, p)).sort()))
    throw Error("Repaired commit provenance or changed path inventory differs; preserve evidence.");
  const proof = repairPublicationProof(job, sha, state, commitSha, intent);
  await mkdir(dirname(existingProof), { recursive: true, mode: 0o700 });
  await writeFile(existingProof, JSON.stringify(proof, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  const prior = JSON.parse(await readFile(headFile, "utf8")) as {
    version: number; jobId: string; headSha: string };
  if (prior.version !== 1 || prior.jobId !== job.jobId ||
      prior.headSha !== state.baselineHead)
    throw Error("The verified-head ledger moved during repair publication.");
  const temp = headFile + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify({ version: 1, jobId: job.jobId,
    headSha: commitSha, workItemId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, headFile);
  const point = await finalizeRecoveryCheckpoint(job, workItemId, state.baselineHead, commitSha);
  return acceptRejectedRepairCheckpoint(job, sha, point);
}

/** Production Pi driver. Reopens the original writer transcript; no new agent
 * conversation, reviewer discussion, shell, approval tool or expanded scope. */
export async function runPiRejectedRepair(job: JobStartResult, sha: string) {
  // Resolve the pinned skill, model, budget and sandbox before claiming the
  // one-way Pi turn. A failed preflight must not strand a repair as an
  // interrupted writer call that never actually began.
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "ready" && state.phase !== "prepared")
    throw Error("No safe original-session repair attempt is ready.");
  // An uncertain saved claim must be refused BEFORE budget admission, sandbox
  // provisioning, or a new session. Only the exact pre-dispatch fence permits
  // continuing an interrupted prepared assignment.
  if (state.phase === "prepared") await inspectPreparedRepairDispatch(job, sha);
  const focus = state.origin.workItem.startsWith("focus:")
    ? state.origin.workItem.slice(6).split(".")[0] : null;
  const skill = state.origin.workItem === "foundation" ? "nt-story-discovery" :
    state.origin.workItem.startsWith("event-") || focus === "event"
      ? "nt-event-design" :
    state.origin.workItem.startsWith("composition-") || focus === "authored-content"
      ? "nt-narrative-composition" :
    state.origin.workItem.startsWith("interactive-choice-") || focus === "choice-point"
      ? "nt-interactive-narrative" :
    state.origin.workItem.startsWith("interactive-puzzle-") || focus === "puzzle"
      ? "nt-puzzle-design" :
    state.origin.workItem === "world-foundations" ||
      ["world-entity", "fact", "revelation"].includes(focus ?? "")
      ? "nt-worldbuilding" : "nt-character-development";
  if (await openSkillSnapshot(state.origin.snapshot.id) !== state.origin.snapshot.path)
    throw Error("Original specialist's pinned skills changed; preserve the repair receipt.");
  await guardPiBudget(job, "semantic-repair:" + sha + ":" + (state.attempts + 1),
    state.origin.sessionFile);
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true,
    { discovery: "explicit-only", novelteaSkills: state.origin.snapshot.path,
      skillDirs: [], requiredSkills: [skill, "nt-catalog"] });
  await loader.reload();
  const skills = loader.getSkills();
  if (skills.diagnostics.some(d => d.type === "error") ||
      !skills.skills.some(s => s.name === skill &&
        s.filePath.startsWith(join(state.origin.snapshot.path, "skills") + sep)))
    throw Error("The original pinned specialist skill is missing.");
  const runtime = await createJobModelRuntime();
  const resolved = await resolvePiModel(job, runtime, state.origin.provider,
    state.origin.model, state.origin.thinking);
  const sandboxTools = await selectSandboxPiTools(job, state.origin.snapshot,
    skills.skills, undefined, "writer");
  if (!sandboxTools) throw Error("Review repair cannot run outside the isolated Story sandbox.");
  // The model never receives a write tool that can target a path beyond the
  // exact failed checkpoint inventory. No post-hoc rollback is needed.
  const scopedTools = sandboxTools.filter(tool =>
    ["read", "edit", "write", "grep", "find", "ls"].includes(tool.name)).map(tool =>
    !["write", "edit"].includes(tool.name) ? tool : {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const input = args[1] as { path?: unknown };
        if (typeof input.path !== "string" || !state.allowedPaths.includes(input.path))
          throw Error("Review repair tool denied path outside the original authorized assignment.");
        return tool.execute(...args);
      },
    });
  const feedback = await prepareRejectedRepairFeedback(job, state);
  const claimed = state.phase === "ready"
    ? await claimRejectedRepair(job, sha)
    : await inspectPreparedRepairDispatch(job, sha);
  if (claimed.attempts !== state.attempts)
    throw Error("Repair attempt counter changed before the original Pi session.");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: resolved.model,
    thinkingLevel: resolved.resolution.thinking, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.open(state.origin.sessionFile,
      dirname(state.origin.sessionFile), project.root),
    customTools: [...scopedTools, createStoryValidateTool(job), createPiStatusTool()],
    noTools: "all", tools: ["read", "edit", "write", "grep", "find", "ls", "story_validate", "report_status"],
  });
  let reportedOutOfAuthority: string | undefined;
  let reportedDispute: { path: string; line: number; claim: string } | undefined;
  try {
    if (resolved.resolution.thinking &&
        session.thinkingLevel !== resolved.resolution.thinking)
      throw Error("Original specialist thinking effort changed.");
    await reportControllerReviewPhase("correcting");
    await markRejectedRepairStarted(job, sha);
    await promptStorySpecialist(session,
      "Continue your ORIGINAL specialist Pi session to correct a rejected draft. " +
      "This is not an argument with the independent reviewer. The prior verdict " +
      "remains failed unless files actually change and pass a fresh native " +
      "validation and separate semantic rereview. First read the relevant pinned " +
      "skill and exact Story files. Edit ONLY the already authorized paths below. " +
      "Do not modify protected canon, broaden the task, run shell, approve changes " +
      "or touch the author's deferred ideas. The one exception, when explicitly " +
      "listed in the signed feedback, is the selected Event Milestone's " +
      "completeness and fulfillment frontmatter slots; never change its " +
      "title, arcs, decisions, other metadata, or prose. If a finding cites records outside " +
      "the allowed files, those are READ-ONLY context, not write grants. Fix " +
      "the causal gap within your original authorized file where possible: " +
      "for example, present concrete playable observations before asking the " +
      "player to compare them in that Event instead of inventing new file paths. " +
      (state.planAmendment.eventCharacter
        ? "EVENT CHARACTER DEPENDENCY: A separate verified Character specialist has already " +
          "created Character " + state.planAmendment.eventCharacter.id + ". " +
          "The ONLY permitted Event YAML change is appending that exact ID to the " +
          "participants array of " + state.planAmendment.eventCharacter.path +
          "; preserve every other frontmatter byte, prerequisite, decision, route, step " +
          "and effect. Correct the canonical Event prose to accurately introduce " +
          "this named speaker without inventing off-page history. Do not edit the " +
          "Character profile, Arc, Milestone or any other Event. " : "") +
      "For Event corrections, compare the cited effect slot and narrative claim: " +
      "a prose-only rewrite cannot resolve a remaining typed mismatch. " +
      "If truthful state cannot fit the original slots, report the later Choice " +
      "dependency or required source rather than inventing a Fact or Relationship transition. " +
      (state.origin.workItem.startsWith("interactive-choice-") ? CHOICE_PAYOFF_REPAIR + " " :
        state.origin.workItem.startsWith("interactive-puzzle-") ? PUZZLE_GOAL_REPAIR + " " : "") +
      "If correction genuinely requires changing a source listed as a READ-ONLY " +
      "affected dependency, do not edit it: return exactly one line " +
      "OUT_OF_AUTHORITY: <canonical-relative-path> (and no edits) so the " +
      "controller can evaluate an independent supporting assignment. " +
      "If the reviewer is demonstrably wrong about a concrete historical " +
      "source fact, use the exact line DISPUTE_REVIEW: <path>:<line> | <reason> " +
      "(without editing). The controller can obtain ONE fresh independent " +
      "read-only adjudication; your rebuttal cannot approve the change. " +
      "If a genuine disagreement prevents " +
      "correction, explain it in your response without editing; the controller " +
      "will ask the author. Your explanation cannot change the reviewer verdict. " +
      "Finish with a concise description of the actual edits and run story_validate. " +
      "SOURCE-LINKED REVIEW FEEDBACK: " + JSON.stringify(feedback) +
      "\nPINNED SPECIALIST GUIDANCE: " +
      pinnedSkillReferences(state.origin.snapshot, [
        join(state.origin.snapshot.path, "skills", skill, "SKILL.md")]) +
      "\nAUTHORIZED FILES: " + state.allowedPaths.join(", "));
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" ||
        ["error", "aborted"].includes(last.stopReason))
      throw Error("Original specialist did not finish its correction turn.");
    const reply = last.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    reportedOutOfAuthority = reply.match(/^OUT_OF_AUTHORITY:\s*([a-z][a-z0-9-]*\/[a-z0-9._-]+\.md)\s*$/m)?.[1];
    const dispute = reply.match(/^DISPUTE_REVIEW:\s*([a-z][a-z0-9-]*\/[a-z0-9._-]+\.md):([1-9]\d*)\s*\|\s*(.{1,1000})\s*$/m);
    if (dispute) reportedDispute = { path: dispute[1]!, line: Number(dispute[2]), claim: dispute[3]!.trim() };
  } finally { session.dispose(); }
  return finishRejectedRepairDraft(job, sha, reportedOutOfAuthority, reportedDispute);
}

export interface RejectedRepairOptions {
  skillsSource?: string;
  provider?: string;
  model?: string;
  thinking?: "low" | "high";
  /** The parent Graph owns the safe, native-verified steering admission
   * boundary. Without an eligible inventory, corrections cannot yield. */
  canYieldForSteering?: () => Promise<boolean>;
}
async function reviewerFor(job: JobStartResult, sha: string, options: RejectedRepairOptions) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.reviewer) {
    const r = state.reviewer;
    if (options.skillsSource && options.skillsSource !== r.source ||
        options.provider && options.provider !== r.provider ||
        options.model && options.model !== r.model ||
        options.thinking && options.thinking !== r.thinking ||
        await openSkillSnapshot(r.snapshot.id) !== r.snapshot.path)
      throw Error("Review-repair reviewer configuration differs from the original pinned choice.");
    return r;
  }
  if (state.phase !== "ready")
    throw Error("The repair reviewer must be pinned before the first writer attempt.");
  // The first negative postcommit verdict already has a controller-owned,
  // source-bound reviewer identity. Corrections inherit that exact read-only
  // conversation and pinned method/model, not a newly sampled reviewer.
  const cycle = await inspectPostcommitReviewCycle(job, state.rootFailureSha,
    state.originalSource.assignmentDigest);
  if (!cycle || !cycle.rounds.some(r => r.commitSha === state.rootFailureSha))
    throw Error("Original rejected review lacks a reconciled reviewer cycle; do not silently replace it.");
  assertReviewCycleSession({ id: state.origin.sessionId, file: state.origin.sessionFile },
    cycle.reviewer);
  if (options.provider && options.provider !== cycle.provider ||
      options.model && options.model !== cycle.model ||
      options.thinking && options.thinking !== cycle.thinking)
    throw Error("Repair reviewer model policy differs from the source-bound original cycle.");
  if (await openSkillSnapshot(cycle.snapshot.id) !== cycle.snapshot.path)
    throw Error("Original reviewer skill snapshot is no longer verified.");
  state.reviewer = { snapshot: cycle.snapshot, source: options.skillsSource ?? null,
    provider: cycle.provider, model: cycle.model, thinking: cycle.thinking,
    sessionFiles: [cycle.reviewer.file] };
  await save(job, state);
  return state.reviewer;
}

/** A dispute has exactly one fresh, read-only adjudicator, never the writer
 * or previous reviewer session. Historical sealed negative review remains
 * authoritative even if the new reviewer disagrees: that becomes a distinct,
 * source-linked author/controller escalation, not an unreviewed approval. */
export async function adjudicateRejectedRepair(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "disputing" || !state.dispute || !state.reviewer)
    throw Error("No bounded, reviewer-pinned dispute is ready.");
  const claim = state.dispute;
  const line = gitRaw(job, "show", sha + ":" + repoPath(job, claim.path))
    .split(/\r?\n/)[claim.line - 1];
  if (line === undefined || !state.findings.some(f => f.path === claim.path && f.line === claim.line))
    throw Error("Deterministic source check rejects a stale or invented dispute location.");
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === sha && p.assurance);
  if (!point || sourceOf(await verifiedFailure(job, point)) !== state.sourceReviewDigest)
    throw Error("Disputed review no longer matches the immutable source.");
  const profile = state.reviewer;
  state.phase = "adjudicating";
  await save(job, state); // Crash fence: do not replay an uncertain independent Pi call.
  let sessionFile: string | undefined;
  const adjudication = await runPiAssignmentReview(job, [point], {
    snapshot: profile.snapshot, provider: profile.provider,
    model: profile.model, thinking: profile.thinking,
    reviewer: "independent-pi-assignment-adjudication", seal: false,
    challenge: { sourceSha: sha, reviewDigest: state.sourceReviewDigest,
      path: claim.path, line: claim.line, claim: claim.claim },
    onSession: async file => {
      sessionFile = file;
      const current = await inspectRejectedRepair(job, sha);
      if (!current.reviewer || current.phase !== "adjudicating")
        throw Error("Adjudicator transcript cannot attach to another repair phase.");
      current.reviewer.sessionFiles.push(file);
      await save(job, current);
    },
  });
  const current = await inspectRejectedRepair(job, sha);
  if (current.phase !== "adjudicating" || !current.dispute || !sessionFile)
    throw Error("Dispute result lacks its owned independent reviewer session.");
  current.dispute.adjudication = { sessionFile,
    packetDigest: adjudication.packet.sourceDigest,
    verdict: adjudication.verdict.verdict,
    findingsDigest: hash(adjudication.verdict.findings) };
  current.phase = "blocked";
  current.failure = adjudication.verdict.verdict === "pass"
    ? "Two independent reviewers disagree about the sealed source. Preserve both conclusions and obtain an authenticated author/controller resolution; a dispute does not erase the historical rejection."
    : "Fresh independent review confirmed the original semantic failure. Provide a source-linked correction or a new authorized strategy; writer argument is not approval.";
  await save(job, current);
  return current;
}

/** Same-Thread author continuation after a reviewer-confirmed nonconvergence
 * stop. Historical bounded grants remain source-bound and replay-safe. */
export async function acceptGuidedRepairContinuation(job: JobStartResult,
  sha: string, grantId: string) {
  const state = await inspectRejectedRepair(job, sha);
  const ledger = await inspectRepairLedger(job, state.originalSource.turnDigest);
  const grant = ledger.authorGrants?.find(item => item.id === grantId);
  if (!grant || grant.rootFailureSha !== state.rootFailureSha ||
      grant.sourceSha !== sha || !state.repairedCommitSha ||
      state.repairedCommitSha !== grant.headSha ||
      state.baselineHead !== grant.headSha ||
      !["blocked", "failed"].includes(state.phase) ||
      await trustedHead(job) !== grant.headSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Guided repair grant does not match a clean, rejected successor checkpoint.");
  const point = (await inspectRecoveryCheckpoints(job)).find(p =>
    p.eligible && p.commitSha === grant.headSha && p.semanticReview === "failed");
  if (!point || !point.assurance ||
      !(ledger.findings.some(f => f.rootFailureSha === state.rootFailureSha &&
        f.status === "open" && f.source.sourceSha === grant.headSha)))
    throw Error("Guided repair source is no longer independently rejected.");
  if (state.phase === "blocked") {
    state.phase = "failed";
    state.failure = undefined;
    await save(job, state);
  }
  return state;
}

/** One owned, restart-reconcilable controller workflow. The original failed
 * review remains sealed. A second correction uses the same original writer
 * session, a new rejected checkpoint and a new independent Pi review. */
export async function advanceRejectedRepair(job: JobStartResult, sourceSha: string,
  options: RejectedRepairOptions = {}) {
  if (!SHA.test(sourceSha)) throw Error("Repair requires one exact reviewed commit.");
  await withStoryJobLock(job, "reconcile-published-repair", async () => {
    await reconcileUnpublishedRepairCommit(job, sourceSha);
    await recoverInterruptedFoundationRepair(job, sourceSha);
    if (existsSync(pathFor(job, sourceSha))) {
      // A fully completed original Pi turn can be finalized exactly once
      // from its durable session prefix and owned diff. An uncertain writer
      // remains repairing, and the controller returns manual-reconcile.
      await reconcileCompletedRepairWriter(job, sourceSha);
    }
  });
  const point = (await inspectRecoveryCheckpoints(job)).find(
    p => p.eligible && p.commitSha === sourceSha);
  if (!point) throw Error("Requested rejected checkpoint is not independently verified.");
  return driveRejectedRepairCycle({
    begin: async () => {
      const state = await beginRejectedRepair(job, point);
      await withStoryJobLock(job, "rejected-review-profile", () =>
        reviewerFor(job, state.sourceCommitSha, options));
      return state;
    },
    inspect: sha => inspectRejectedRepair(job, sha),
    correct: sha => withStoryJobLock(job, "rejected-review-writer", () =>
      runPiRejectedRepair(job, sha)),
    choice: id => inspectSpecialistChoice(job, id),
    consume: sha => withStoryJobLock(job, "rejected-review-author", () =>
      consumeRejectedRepairChoice(job, sha)),
    validate: sha => withStoryJobLock(job, "rejected-review-validation", () =>
      validateRejectedRepairDraft(job, sha)),
    commit: sha => withStoryJobLock(job, "rejected-review-commit", () =>
      commitRejectedRepairDraft(job, sha)),
    shouldYieldForSteering: async () => {
      const adapter = currentSteeringBoundary();
      return !!adapter && !!options.canYieldForSteering &&
        (await options.canYieldForSteering()) &&
        (await adapter.pending(job)).length > 0;
    },
    reviewStatus: async state => {
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.commitSha === state.repairedCommitSha);
      if (!point?.assurance ||
          !["required-pending", "passed", "failed"].includes(point.semanticReview))
        throw Error("Repair has no independently verifiable successor review.");
      return point.semanticReview as "required-pending" | "passed" | "failed";
    },
    rereview: async state => {
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.commitSha === state.repairedCommitSha);
      if (!point?.assurance) throw Error("Repair successor checkpoint was lost.");
      const profile = (await inspectRejectedRepair(job, state.sourceCommitSha)).reviewer;
      if (!profile) throw Error("Original independent-review profile was not pinned.");
      // A read-only Pi reviewer still owns an active cancellable Story turn.
      // The original review takes this lease; a post-repair rereview must do
      // the same or it fails the active-writer guard after expensive model work.
      await withStoryJobLock(job, "rejected-review-rereview", () =>
        runPiAssignmentReview(job, [point], {
          snapshot: profile.snapshot, provider: profile.provider, model: profile.model,
          thinking: profile.thinking, reviewer: "independent-pi-assignment-review",
          onSession: async file => {
            const current = await inspectRejectedRepair(job, state.sourceCommitSha);
            if (!current.reviewer || current.phase !== "reviewing")
              throw Error("Reviewer session cannot attach to an unrelated repair.");
            const cycle = await inspectPostcommitReviewCycle(job, current.rootFailureSha,
              point.assurance!.assignmentDigest);
            if (!cycle) throw Error("Independent reviewer cycle disappeared during correction.");
            const identity = { id: cycle.reviewer.id, file };
            if (current.originalSource.assignmentDigest === point.assurance!.assignmentDigest)
              assertReviewCycleSession({ id: current.origin.sessionId, file: current.origin.sessionFile },
                identity, cycle.reviewer);
            else {
              // A verified author-directed scope revision owns a NEW cycle,
              // not the original reviewer's apparent memory or authority.
              if (!current.revision ||
                  hash(current.revision.assignment) !== point.assurance!.assignmentDigest)
                throw Error("Changed reviewer scope has no trusted plan revision.");
              assertReviewCycleSession({ id: current.origin.sessionId, file: current.origin.sessionFile },
                identity);
            }
            if (!current.reviewer.sessionFiles.includes(file))
              current.reviewer.sessionFiles.push(file);
            await save(job, current);
          },
        }));
    },
    finishReview: sha => withStoryJobLock(job, "rejected-review-seal", () =>
      finishRejectedRepairReview(job, sha)),
    adjudicate: state => withStoryJobLock(job, "independent-review-dispute", () =>
      adjudicateRejectedRepair(job, state.sourceCommitSha)),
    nextFailure: async state => {
      if (!state.repairedCommitSha)
        throw Error("Rejected correction lacks its source-linked successor.");
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.commitSha === state.repairedCommitSha);
      if (!point) throw Error("Failed correction checkpoint was lost.");
      return withStoryJobLock(job, "rejected-review-next-attempt", () =>
        beginRejectedRepair(job, point));
    },
  });
}
