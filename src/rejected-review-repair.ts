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
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectRecoveryCheckpoints, finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectCheckpointReview, readRepairCommitProof, repairReviewAssignment,
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
import { withStoryJobLock } from "./job-lock.js";
import { driveRejectedRepairCycle } from "./rejected-repair-controller.js";
import { deriveReviewRepairAmendment, deriveReviewDependencyRequest, reviewNeedsDependency,
  type ReviewDependencyRequest, type ReviewRepairPlanAmendment } from "./review-repair-amendment.js";
import { inspectReviewEventSupport, recordReviewDependency } from "./dependency-state.js";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value: unknown) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const MAX_ATTEMPTS = 2;

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
export type RepairPhase = "ready" | "repairing" | "awaiting-author" | "validating" |
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
  phase: RepairPhase;
  attempts: number;
  revision?: RepairRevision;
  reviewer?: {
    snapshot: SkillSnapshot; source: string | null; provider: string; model: string;
    thinking?: "low" | "high"; sessionFiles: string[];
  };
  choiceId?: string;
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
  if (previous && previous.attempts >= MAX_ATTEMPTS)
    throw Error("Bounded repair attempts exhausted; author intervention is required.");
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
      !Array.isArray(state.allowedPaths) || !state.allowedPaths.length ||
      state.allowedPaths.some(path => !originalSafePath(path) ||
        (path.startsWith("creative-direction/") && state.origin?.workItem !== "foundation")) ||
      (state.origin?.workItem === "foundation" &&
        (state.allowedPaths.length !== 1 || !state.allowedPaths[0]?.startsWith("creative-direction/"))) ||
      !Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > MAX_ATTEMPTS ||
      !["ready", "repairing", "awaiting-author", "validating",
        "awaiting-checkpoint", "reviewing", "passed", "failed", "blocked"].includes(state.phase))
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
    attempt: state.attempts + 1, maxAttempts: MAX_ATTEMPTS,
  };
}
type EventRepairSources = Pick<import("./event-specialist.js").EventAssignment, "sourcePaths">;
/** Build actionable feedback before claiming a paid turn or touching the writer
 * transcript. The failed source and adjacent records remain immutable. */
export async function prepareRejectedRepairFeedback(job: JobStartResult, state: RepairReceipt) {
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
    return { ...repairFeedback(state), ...context, causalGrounding: EVENT_CAUSAL_GROUNDING,
      ...(proof ? { originalConsequenceProof: proof, citedEffects } : {}) };
  }
  return { ...repairFeedback(state), ...rejectedRepairContext(job, state, sourcePaths) };
}
export async function claimRejectedRepair(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "ready" || state.attempts >= MAX_ATTEMPTS)
    throw Error("No safe repair attempt is ready; preserve the original session and draft.");
  if (await trustedHead(job) !== state.baselineHead ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Repair source moved or worktree contains a draft; never overwrite it.");
  if (hash(await readFile(state.origin.sessionFile)) !== state.sessionSha256)
    throw Error("Original Pi transcript changed; do not silently start a new session.");
  state.attempts++;
  state.phase = "repairing";
  await save(job, state); // One-way crash fence before any external model call.
  return state;
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
export async function finishRejectedRepairDraft(job: JobStartResult, sha: string) {
  const state = await inspectRejectedRepair(job, sha);
  if (state.phase !== "repairing") throw Error("Repair was not claimed in this process.");
  if (await trustedHead(job) !== state.baselineHead)
    throw Error("Repair changed verified Git HEAD; preserve draft and investigate.");
  const paths = changedRepairPaths(job, state);
  if (!paths.length) {
    state.phase = "awaiting-author";
    state.sessionSha256 = hash(await readFile(state.origin.sessionFile));
    const choice = await recordSpecialistChoice(job, "repair-" + sha,
      disagreementQuestion(state), state.origin.sessionId, state.origin.sessionFile);
    state.choiceId = choice.id;
    await save(job, state);
    return state;
  }
  state.paths = paths;
  state.draftDigest = hash(paths.map(path =>
    ({ path, diff: git(job, "diff", "--binary", "--", repoPath(job, path)) })));
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
/** Pure terminal transition after the controller has verified the independent
 * successor receipt. Keeping both verdicts separate makes restart validation
 * against the original source possible after a second negative finding. */
export function repairReviewOutcome(state: RepairReceipt, review: IndependentReviewResult): RepairReceipt {
  if (state.phase !== "reviewing" || !state.repairedCommitSha ||
      review.source.commitSha !== state.repairedCommitSha)
    throw Error("Repair verdict must refer to its reviewed successor.");
  const failed = review.status === "failed";
  const phase = !failed ? "passed" : state.attempts >= MAX_ATTEMPTS ? "blocked" : "failed";
  return { ...state, phase, successorFindings: structuredClone(review.findings),
    ...(failed ? { baselineHead: state.repairedCommitSha,
      failure: phase === "blocked"
        ? "Two real corrections failed independent rereview; inspect saved sessions, drafts and immutable findings."
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
  const finished = repairReviewOutcome(state, review.result);
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
  state.phase = state.attempts >= MAX_ATTEMPTS ? "blocked" : "ready";
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

/** Commit only the controller's exact validated draft, with an immutable
 * repair proof and native recovery checkpoint. Caller owns the writer lease.
 * Never reset or clean an interrupted draft or an unrecognized commit. */
export async function commitRejectedRepairDraft(job: JobStartResult, sha: string) {
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
  const proofDigest = hash({
    workItemId, sourceCommitSha: sha, rootFailureSha: state.rootFailureSha,
    sourceReviewDigest: state.sourceReviewDigest, assignmentId: state.assignment.id,
    assignmentRevision: state.revision?.digest ?? null,
    nativeProof: state.validationProof, draft: state.draftDigest, paths: state.paths,
    repairPlanDigest: state.planAmendment.digest,
  });
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
  const proof: RepairCommitProof = {
    version: 1, jobId: job.jobId, threadId: job.threadId, branch: job.branch,
    baseSha: job.baseSha, phase: "committed", worker: "pi", workItemId,
    sourceCommitSha: sha, rootFailureSha: state.rootFailureSha,
    sourceReviewDigest: state.sourceReviewDigest, originalReviewDigest: state.originalReviewDigest,
    assignmentId: state.assignment.id,
    assignmentDigest: hash(state.revision?.assignment ?? state.assignment),
    ...(state.revision ? { assignmentRevision: state.revision } : {}),
    beforeHead: state.baselineHead, commitSha, paths: [...state.paths],
    digest: proofDigest,
    validation: { status: "passed", validatorVersion: job.validatorVersion,
      proofDigest: state.validationProof },
    sessionFile: state.origin.sessionFile, sessionId: state.origin.sessionId,
    sessionSha256: hash(await readFile(state.origin.sessionFile)),
    provider: state.origin.provider, model: state.origin.model,
    snapshot: state.origin.snapshot, planVersion,
    repairPlanDigest: state.planAmendment.digest,
  };
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
  if (state.phase !== "ready" || state.attempts >= MAX_ATTEMPTS)
    throw Error("No safe original-session repair attempt is ready.");
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
  const claimed = await claimRejectedRepair(job, sha);
  if (claimed.attempts !== state.attempts + 1)
    throw Error("Repair attempt counter changed while preparing the original Pi session.");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: resolved.model,
    thinkingLevel: resolved.resolution.thinking, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.open(state.origin.sessionFile,
      dirname(state.origin.sessionFile), project.root),
    customTools: [...scopedTools, createStoryValidateTool(job), createPiStatusTool()],
    noTools: "all", tools: ["read", "edit", "write", "grep", "find", "ls", "story_validate", "report_status"],
  });
  try {
    if (resolved.resolution.thinking &&
        session.thinkingLevel !== resolved.resolution.thinking)
      throw Error("Original specialist thinking effort changed.");
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
  } finally { session.dispose(); }
  return finishRejectedRepairDraft(job, sha);
}

export interface RejectedRepairOptions {
  skillsSource?: string;
  provider?: string;
  model?: string;
  thinking?: "low" | "high";
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
  const config = options.skillsSource
    ? { discovery: "explicit-only" as const, novelteaSkills: options.skillsSource,
      skillDirs: [], requiredSkills: [] }
    : await loadSkillConfig(undefined, false);
  const snapshot = await createSkillSnapshot({
    ...config, requiredSkills: ["nt-narrative-review", "nt-catalog"] });
  if (!snapshot) throw Error("No pinned independent narrative-review skill is available.");
  state.reviewer = { snapshot, source: options.skillsSource ?? null,
    provider: options.provider ?? state.origin.provider,
    model: options.model ?? state.origin.model,
    thinking: options.thinking ?? (state.origin.thinking === "medium" ? undefined : state.origin.thinking),
    sessionFiles: [] };
  await save(job, state);
  return state.reviewer;
}

/** One owned, restart-reconcilable controller workflow. The original failed
 * review remains sealed. A second correction uses the same original writer
 * session, a new rejected checkpoint and a new independent Pi review. */
export async function advanceRejectedRepair(job: JobStartResult, sourceSha: string,
  options: RejectedRepairOptions = {}) {
  if (!SHA.test(sourceSha)) throw Error("Repair requires one exact reviewed commit.");
  await withStoryJobLock(job, "reconcile-published-repair", () =>
    recoverInterruptedFoundationRepair(job, sourceSha));
  const point = (await inspectRecoveryCheckpoints(job)).find(
    p => p.eligible && p.commitSha === sourceSha);
  if (!point) throw Error("Requested rejected checkpoint is not independently verified.");
  return driveRejectedRepairCycle({
    begin: async () => {
      const state = await beginRejectedRepair(job, point);
      await reviewerFor(job, state.sourceCommitSha, options);
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
            current.reviewer.sessionFiles.push(file);
            await save(job, current);
          },
        }));
    },
    finishReview: sha => withStoryJobLock(job, "rejected-review-seal", () =>
      finishRejectedRepairReview(job, sha)),
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
