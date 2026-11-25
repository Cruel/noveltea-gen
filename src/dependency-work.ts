import { subunitRoundProof, subunitWriterResult } from "./generation-writer-round.js";
import { AssignmentAuthorPauseError, AssignmentNonconvergenceError, type AssignmentRoundCommand } from "./assignment-metadata-recovery.js";
import { readJobControl } from "./job-control.js";
import { trustedHead } from "./revision.js";
import { ProtocolIntegrityBlockedError, ProtocolExhaustedError } from "./response-contract-recovery.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createGenerationQuestionGraph } from "./generation-author-question.js";
import { focusedChoiceWorkItem } from "./specialist-choice.js";
import { createAssignmentLifecycleGraph, logicalAssignmentKey, assignmentChildConfig, type AssignmentIdentity, type AssignmentOutcome, type AssignmentSubmission, type AssignmentPrerequisiteSuspension, type AssignmentCorrection, type AssignmentVerifiedSubmission } from "./generation-assignment-lifecycle.js";
import { join } from "node:path";
import { startStoryJob } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectFocusedFailure, inspectFocusedPrerequisite, inspectPendingFocusedInvocation, inspectPendingFocusedCommit, runFocusedWorkItem, type FocusedWorkOptions } from "./focused-work.js";
import { dependencyBoundary, dependencyTurn, dependencyDigest, dependencyGit,
  recordDependency, registerReviewDependency, registerBlueprintDependency, approveDependency, blueprintSourceOf,
  inspectDependencyPlan, saveDependencyPlan, dependencyWriterBase, dependencyAncestors, supportingReviewAssignment, DependencyAuthorizationRefusedError, type DependencyEntry } from "./dependency-state.js";
import { createReviewRoundTransitions } from "./generation-review-round.js";
import { reviewSupportRoot, inspectSharedSupportReview } from "./support-review.js";
import { executeReviewRound, inspectFoundationReviewBoundary } from "./rejected-review-repair.js";
import type { SupportingReviewAssessment } from "./generation-recovery-contract.js";
import { isDeepStrictEqual } from "node:util";
import { proposeDependency } from "./dependency-planner.js";

/** Source of a supporting tree. The root is the original sealed report,
 * not the failing child or the most recent amended plan. */
export type DependencySupportSource = import("./event-work.js").EventBlueprintPrerequisite |
  { rootReportDigest: string; expectedHead: string };
function supportRoots(plan: NonNullable<Awaited<ReturnType<typeof inspectDependencyPlan>>>, source: DependencySupportSource) {
  return plan.entries.filter(e => "rootReportDigest" in source
    ? e.reportDigest === source.rootReportDigest && !e.parent && e.report.sourceSha === source.expectedHead
    : e.blueprintSource?.readinessDigest === source.reportDigest &&
      e.blueprintSource.milestoneId === source.milestoneId);
}

/** Authenticate an exact committed, not-yet-published prerequisite effect.
 * This is inspection only; the existing child remains responsible for publication. */
export async function inspectInterruptedBlueprintSupport(job: import("./job.js").JobStartResult,
  readiness: DependencySupportSource, graphThreadId: string,
  allowPublished = false): Promise<string | null> {
  const plan = await inspectDependencyPlan(job);
  if (!plan) return null;
  const roots = supportRoots(plan, readiness);
  const head = dependencyGit(job, "rev-parse", "HEAD");
  const parent = dependencyGit(job, "rev-parse", "HEAD^");
  const published = JSON.parse(await readFile(join(job.stateDir, "revisions", "verified-head.json"), "utf8"));
  if (published.version !== 1 || published.jobId !== job.jobId || (published.headSha !== parent && !(allowPublished && published.headSha === head))) return null;
  const candidates = plan.entries.filter(e => (e.phase === "authorized" || allowPublished && e.phase === "reviewing") && e.amendment && !e.fixture &&
    roots.some(root => dependencyAncestors(plan.entries, e).has(root.reportDigest)) &&
    dependencyWriterBase(plan, e) === parent);
  const matches = [];
  for (const entry of candidates) {
    const amendment = entry.amendment!;
    const assignment = amendment.assignment;
    const receipt = await inspectPendingFocusedCommit(job, assignment.targets[0]!, parent, assignment.id);
    if (!receipt) continue;
    const identity: AssignmentIdentity = { schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
      jobThreadId: job.threadId, graphThreadId, turnDigest: entry.report.turnDigest,
      assignmentId: assignment.id, planVersion: amendment.afterVersion,
      sourceHeadSha: entry.report.sourceSha, scopeDigest: dependencyDigest(assignment) };
    if (receipt.commitSha !== head || receipt.worker !== "pi" || receipt.assignmentKey !== logicalAssignmentKey(identity) ||
        receipt.assignmentDigest !== entry.report.turnDigest || receipt.validation?.status !== "passed" ||
        receipt.validation.validatorVersion !== job.validatorVersion || receipt.validation.baseSha !== parent ||
        JSON.stringify(receipt.paths) !== JSON.stringify([...assignment.authority.existingPaths,
          ...(assignment.authority.newPaths ?? [])].sort())) return null;
    matches.push(entry.reportDigest);
  }
  return matches.length === 1 ? parent : null;
}

/** A paused prerequisite strategy can resume only across the exact ledger
 * effects of that original readiness report, never across unrelated commits. */
export async function inspectBlueprintSupportProgress(job: import("./job.js").JobStartResult,
  readiness: DependencySupportSource, graphThreadId: string): Promise<boolean> {
  const head = await trustedHead(job);
  if (head === readiness.expectedHead) return true;
  const plan = await inspectDependencyPlan(job);
  if (!plan) return false;
  const roots = supportRoots(plan, readiness);
  const relevant = plan.entries.filter(e =>
    roots.some(root => dependencyAncestors(plan.entries, e).has(root.reportDigest)));
  const verified = new Set<string>();
  for (const entry of relevant) {
    if ((entry.phase === "verified" || entry.phase === "reviewing" && entry.review?.verdict === "pass") && entry.commitSha) {
      verified.add(entry.commitSha);
      if (entry.supportRootSha && entry.supportRootSha !== entry.commitSha) {
        verified.add(entry.supportRootSha);
        // The full ledger inspector has already authenticated every Review
        // and repair predecessor between these exact two receipts.
        for (const sha of dependencyGit(job, "rev-list", entry.supportRootSha + ".." + entry.commitSha).split("\n"))
          verified.add(sha);
      }
    } else if (entry.phase === "reviewing" && entry.supportRootSha &&
        await (await import("./rejected-review-repair.js")).authenticateFoundationReviewHead(job, entry.supportRootSha)) {
      verified.add(entry.supportRootSha);
      for (const sha of dependencyGit(job, "rev-list", entry.supportRootSha + ".." + head).split("\n").filter(Boolean))
        verified.add(sha);
    }
  }
  dependencyGit(job, "merge-base", "--is-ancestor", readiness.expectedHead, head);
  let parent = readiness.expectedHead;
  for (const commit of dependencyGit(job, "rev-list", "--reverse", parent + ".." + head).split("\n")) {
    if (dependencyGit(job, "rev-parse", commit + "^") !== parent) return false;
    if (!verified.has(commit) && (commit !== head ||
        await inspectInterruptedBlueprintSupport(job, readiness, graphThreadId, true) !== parent)) return false;
    parent = commit;
  }
  return parent === head;
}

/** Returned-END outcome from an admitted supporting child. The parent must
 * reauthenticate its source before selecting any assessment or disposition. */
export class SupportingAssignmentStop extends Error {
  constructor(readonly reportDigest: string, readonly outcome: Exclude<AssignmentOutcome, {status: "verified"}>) {
    super("Supporting assignment returned " + outcome.status);
  }
}

/** Select the same bounded Review assessment used by ordinary assignments.
 * The admitted Blueprint root and every intervening support effect must
 * belong to the original parent. No checkpoint field confers authority. */
export async function inspectSupportingReviewSelection(job: import("./job.js").JobStartResult,
  readiness: DependencySupportSource, graphThreadId: string,
  reportDigest: string, selected?: SupportingReviewAssessment): Promise<SupportingReviewAssessment | null> {
  const plan = await inspectDependencyPlan(job);
  const entry = plan?.entries.find(e => e.reportDigest === reportDigest);
  if (!plan || !entry?.supportRootSha || !entry.amendment || entry.phase !== "reviewing" ||
      !supportRoots(plan, readiness).some(e =>
        dependencyAncestors(plan.entries, entry).has(e.reportDigest)) ||
      !await inspectBlueprintSupportProgress(job, readiness, graphThreadId)) return null;
  const assessment = await inspectFoundationReviewBoundary(job, entry.supportRootSha, selected?.assessment);
  if (!assessment) return null;
  const checked = { reportDigest, rootSha: entry.supportRootSha, assessment };
  return !selected || isDeepStrictEqual(selected, checked) ? checked : null;
}

/** The existing native Review terminal is attributable to the original
 * parent Case, not a fresh failed Event or a new budget. */
export async function inspectSupportingNativeFailure(job: import("./job.js").JobStartResult,
  readiness: DependencySupportSource, graphThreadId: string, caseId: string | undefined,
  diagnostic?: import("./rejected-review-repair.js").NativeDiagnosticReference) {
  const plan = await inspectDependencyPlan(job);
  if (!plan) return null;
  const { inspectNativeReviewFailure } = await import("./rejected-review-repair.js");
  for (const entry of plan.entries) {
    if ((!["authorized", "reviewing"].includes(entry.phase) && !(diagnostic && entry.phase === "verified")) || !entry.amendment ||
        !supportRoots(plan, readiness).some(e =>
          dependencyAncestors(plan.entries, entry).has(e.reportDigest))) continue;
    const amendment = entry.amendment;
    const key = logicalAssignmentKey({ schema: "noveltea-assignment-identity/v1",
      jobId: job.jobId, jobThreadId: job.threadId, graphThreadId, turnDigest: entry.report.turnDigest,
      assignmentId: amendment.assignment.id, planVersion: amendment.afterVersion,
      sourceHeadSha: entry.report.sourceSha, scopeDigest: dependencyDigest(amendment.assignment) });
    if (!entry.supportRootSha || diagnostic) {
      const writerBase = dependencyWriterBase(plan, entry);
      const target = amendment.assignment.targets[0]!;
      // An already published writer is inspected historically only under
      // the original diagnostic grant; a later Review is not that draft.
      const selectedWriter = !diagnostic || diagnostic.ref.includes("/focused-sessions/");
      const failure = selectedWriter ? await inspectFocusedFailure(job, target, writerBase, diagnostic?.authorization,
        entry.supportRootSha, amendment.assignment.id) : null;
      if (failure && (!diagnostic || failure.ref === diagnostic.ref)) {
        if (failure.assignmentKey !== key || !await inspectBlueprintSupportProgress(job, readiness, graphThreadId))
          throw new ProtocolIntegrityBlockedError("Supporting writer failure lost its original parent lineage.");
        return { ...failure, nativeOwner: { phase: "writer" as const, workItem: amendment.assignment.id,
          sourceSha: writerBase, assignmentKey: key, rootSha: writerBase }, supportReportDigest: entry.reportDigest };
      }
    }
    if (!entry.supportRootSha) continue;
    const failure = await inspectNativeReviewFailure(job, entry.supportRootSha, caseId ?? key, key, diagnostic);
    if (!failure) continue;
    if (!await inspectBlueprintSupportProgress(job, readiness, graphThreadId))
      throw new ProtocolIntegrityBlockedError("Native supporting failure lost its original parent lineage.");
    return { ...failure, supportReportDigest: entry.reportDigest };
  }
  return null;
}

/** A settled refusal is not a failed or uncertain writer. The parent must
 * independently authenticate the original ledger before acting on it. */
export class DependencyPlanningUnresolvedError extends Error {
  constructor(readonly reportDigest: string) { super("Supporting prerequisite needs further source-bound planning."); }
}
import { type DependencyReport } from "./dependency-amendments.js";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { createSkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { focusedSpecialist } from "./focused-specialist.js";
import { inspectPiPolicy } from "./job-pi-policy.js";
import { openSkillSnapshot } from "./snapshot.js";
import { reviewNarrative, type ReviewAssignment } from "./narrative-review-specialist.js";

/** The existing plan entry is the sole supporting authority. A dirty
 * restart may only reconcile the exact already admitted Focused round. */
async function supportingBoundary(job: import("./job.js").JobStartResult,
  entry: NonNullable<Awaited<ReturnType<typeof inspectDependencyPlan>>>["entries"][number] | undefined) {
  if (entry?.amendment && entry.phase === "authorized" && !entry.fixture) {
    const { assignment } = entry.amendment;
    const plan = (await inspectDependencyPlan(job))!;
    const sourceSha = dependencyWriterBase(plan, entry);
    const pending = await inspectPendingFocusedInvocation(job, assignment.targets[0]!, assignment.id);
    if (pending) {
      if (pending.expectedHead !== sourceSha || await trustedHead(job) !== sourceSha ||
          pending.assignmentDigest !== entry.report.turnDigest ||
          JSON.stringify(pending.paths) !== JSON.stringify([...assignment.authority.existingPaths,
            ...(assignment.authority.newPaths ?? [])].sort()))
        throw new ProtocolIntegrityBlockedError("Supporting draft lost its original grant.");
      return sourceSha;
    }
    const committed = await inspectPendingFocusedCommit(job, assignment.targets[0]!, sourceSha, assignment.id);
    if (committed) return committed.commitSha;
    const head = await dependencyBoundary(job);
    if (head !== sourceSha) throw new ProtocolIntegrityBlockedError("Supporting assignment source HEAD changed.");
    return head;
  }
  if (entry?.phase === "reviewing" && entry.supportRootSha &&
      await (await import("./rejected-review-repair.js")).authenticateFoundationReviewHead(job, entry.supportRootSha))
    return trustedHead(job);
  return dependencyBoundary(job);
}

function supportingWriterRounds(job: import("./job.js").JobStartResult, identity: AssignmentIdentity,
  input: FocusedWorkOptions, currentEntry: () => Promise<NonNullable<Awaited<ReturnType<typeof inspectDependencyPlan>>>["entries"][number] | undefined>,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  const key = logicalAssignmentKey(identity);
  const preflight = async (): Promise<AssignmentOutcome | null> => {
    const entry = await currentEntry();
    if (!entry?.amendment || dependencyDigest(entry.amendment.assignment) !== identity.scopeDigest ||
        entry.amendment.afterVersion !== identity.planVersion ||
        entry.amendment.sourceSha !== identity.sourceHeadSha ||
        !["authorized", "reviewing", "verified"].includes(entry.phase))
      throw new ProtocolIntegrityBlockedError("Supporting child lost its original grant.");
    const control = await readJobControl(job);
    if (control === "cancelled") { const error = Error("Supporting assignment cancelled."); error.name = "StoryCancelledError"; throw error; }
    if (control === "paused") return { status: "paused", assignmentKey: key,
      evidenceRef: entry.reportDigest, controlRef: "job-control" };
    await supportingBoundary(job, entry);
    return null;
  };
  const run = async (command: AssignmentRoundCommand) => {
    const stopped = await preflight();
    if (stopped) return stopped;
    const entry = (await currentEntry())!;
    if (entry.phase === "reviewing" || entry.phase === "verified")
      return { receiptRef: identity.assignmentId, status: "focused-committed", headSha: entry.supportRootSha ?? entry.commitSha };
    const writerBase = dependencyWriterBase((await inspectDependencyPlan(job))!, entry);
    const diagnostic = nativeDiagnostic?.phase === "writer" && nativeDiagnostic.assignmentKey === key ? nativeDiagnostic : undefined;
    const terminal = async () => inspectFocusedFailure(job, input.target, writerBase,
      diagnostic?.authorization, undefined, identity.assignmentId);
    let result: Awaited<ReturnType<typeof runFocusedWorkItem>>;
    try {
      if (diagnostic && command.phase === "invoke") {
        const original = await terminal();
        if (!original || original.ref !== diagnostic.ref || original.assignmentKey !== key || !original.settlementDigest)
          throw new ProtocolIntegrityBlockedError("Supporting writer diagnosis lost its original terminal.");
        const proof = original.successorProof ?? { sourceDigest: original.proof.sourceDigest,
          ordinal: original.proof.ordinal, settlementDigest: original.settlementDigest };
        return subunitWriterResult({ status: "writer-round", round: { status: "settled", proof } }, identity.assignmentId);
      }
      result = await runFocusedWorkItem({ ...input, round: { assignmentKey: key,
        command: diagnostic ? { ...command, diagnostic: diagnostic.authorization } : command } });
    } catch (error) {
      if (!(error instanceof AssignmentNonconvergenceError || error instanceof ProtocolExhaustedError)) throw error;
      const original = await terminal();
      if (!original || original.assignmentKey !== key) throw error;
      return { status: "unresolved" as const, assignmentKey: key, evidenceRef: original.proof.receiptDigest,
        dispositionRef: "repair-native:" + original.proof.kind };
    }
    if (result.status === "dependency-required") {
      const original = await supportingSuspension(job, entry, identity);
      if (!original) throw new ProtocolIntegrityBlockedError("Supporting prerequisite lost its sealed writer report.");
      return original;
    }
    if (result.status !== "writer-round" && (result.status !== "focused-committed" || !result.headSha))
      throw new ProtocolIntegrityBlockedError("Supporting writer failed to settle its bounded native commit.");
    return subunitWriterResult(result, identity.assignmentId);
  };
  const invoke = async (command: AssignmentRoundCommand) => {
    const result = await run(command);
    if ("correctionRef" in result) throw new ProtocolIntegrityBlockedError("Supporting writer cannot self-admit a correction.");
    return result;
  };
  return {
    preflight,
    invoke: () => invoke({ phase: "invoke" }),
    correct: (submission: AssignmentSubmission, correction: { correctionRef: string }) =>
      invoke({ phase: "correct", proof: subunitRoundProof(submission), grantDigest: correction.correctionRef }),
    verify: async (submission: AssignmentSubmission) => {
      const stopped = await preflight();
      if (stopped) return stopped;
      const result = await run({ phase: "verify", proof: subunitRoundProof(submission) });
      if ("assignmentKey" in result || "correctionRef" in result) return result;
      if (result.status !== "focused-committed" || !result.headSha)
        throw new ProtocolIntegrityBlockedError("Supporting native commit not settled.");
      return { submission: result, reviewPending: true as const };
    },
  };
}

/** Read a supporting writer's settled no-write boundary without opening its
 * session. The Architecture version is distinct from the dependency overlay. */
async function supportingSuspension(job: import("./job.js").JobStartResult, entry: DependencyEntry,
  identity: AssignmentIdentity): Promise<AssignmentPrerequisiteSuspension | null> {
  const assignment = entry.amendment!.assignment;
  const arch = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8"));
  const original = await inspectFocusedPrerequisite(job, assignment.targets[0]!, entry.report.turnDigest,
    false, arch.plan.version, assignment.id);
  if (!original) return null;
  if (original.report.sourceSha !== identity.sourceHeadSha ||
      original.report.assignmentId !== identity.assignmentId)
    throw new ProtocolIntegrityBlockedError("Supporting suspension differs from its original assignment.");
  return { status: "needs-prerequisite", assignmentKey: logicalAssignmentKey(identity),
    evidenceRef: original.seal.reportDigest, suspensionRef: dependencyDigest(original.seal),
    owner: original.report.likelySpecialist, scopeRef: original.seal.reportDigest, pendingPhase: "writer" };
}

/** Called only by the existing Generation parent, after the supporting child
 * has returned END and released the writer lease. Both root support and nested
 * support use this exact child runner and the existing dependency ledger. */
async function runSupportingChild(job: import("./job.js").JobStartResult,
  input: FocusedWorkOptions, identity: AssignmentIdentity, reportDigest: string,
  verify: (submission: AssignmentSubmission) => Promise<AssignmentOutcome | AssignmentCorrection | AssignmentVerifiedSubmission<AssignmentIdentity>>, config: RunnableConfig,
  correctReview?: (submission: AssignmentSubmission, correction: AssignmentCorrection) => Promise<AssignmentSubmission | AssignmentOutcome>,
  caseId?: string, nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  const key = logicalAssignmentKey(identity);
  const currentEntry = async () => (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
  const rounds = supportingWriterRounds(job, identity, input, currentEntry, nativeDiagnostic);
  // The logical assignment is unchanged, but a new parent task after an
  // assessed END must not inherit the completed child's terminal projection.
  // Retain the physical parent task ID in the unstripped namespace. A replay
  // of that same task still uses exactly the same child checkpoint.
  const childConfig = assignmentChildConfig(config, identity);
  const parentTask = config.configurable!.checkpoint_ns as string;
  childConfig.configurable!.checkpoint_ns += "-task-" + dependencyDigest(parentTask);

  // Preserve dynamic child invocation order on parent replay. LangGraph's
  // physical namespace includes the invocation ordinal; receipt-only replay
  // cannot skip earlier children while a later author gate is pending.
  const attest = async (outcome: AssignmentOutcome) => {
    const forbidden = async (): Promise<never> => { throw Error("Settled supporting child cannot write or review again."); };
    const child = createAssignmentLifecycleGraph({
      preflight: async () => outcome, invoke: forbidden, verify: forbidden,
    });
    const state = await child.invoke({ identity, submission: null, submissionKey: null,
      outcome: null, continuationRef: null, suspension: null },
      { ...childConfig, durability: "sync" });
    if (dependencyDigest(state.outcome) !== dependencyDigest(outcome))
      throw new ProtocolIntegrityBlockedError("Settled supporting child changed its outcome.");
  };
  let originalReturned = false;
  // At restart, the no-write receipt may already exist while the parent
  // checkpoint or supporting admission does not. Reconstruct it from source.
  while (true) {
    const entry = (await currentEntry())!;
    const suspension = await supportingSuspension(job, entry, identity);
    let continuationRef: string | null = null;
    if (suspension) {
      if (!originalReturned) await attest(suspension);
      const childEntry = await withStoryJobLock(job, "nested-dependency-admission", async () => {
        let plan = (await inspectDependencyPlan(job))!;
        let nested = plan.entries.find(e => e.reportDigest === suspension.evidenceRef);
        if (!nested) {
          const arch = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8"));
          const original = await inspectFocusedPrerequisite(job, input.target, entry.report.turnDigest,
            false, arch.plan.version, identity.assignmentId);
          if (!original || original.phase !== "waiting-dependency" ||
              dependencyDigest(original.seal) !== suspension.suspensionRef)
            throw new ProtocolIntegrityBlockedError("Nested admission requires the exact settled source.");
          ({ plan, entry: nested } = await recordDependency(job, original.report, false));
        }
        if (nested.parent?.reportDigest !== reportDigest ||
            nested.parent.suspensionDigest !== suspension.suspensionRef)
          throw new ProtocolIntegrityBlockedError("Nested grant belongs to a different parent.");
        if (nested.phase === "rejected") {
          if (nested.rejection?.kind)
            throw new DependencyPlanningUnresolvedError(nested.reportDigest);
          throw Error("Nested supporting prerequisite was independently rejected.");
        }
        await admitDependency(job, plan, nested, input);
        return nested;
      });
      await runSupportingDependency(job, input, childEntry.reportDigest, config, caseId, nativeDiagnostic);
      const checked = (await inspectDependencyPlan(job))!.entries.find(e => e.reportDigest === childEntry.reportDigest);
      if (!checked || checked.phase !== "verified" || !checked.commitSha)
        throw new ProtocolIntegrityBlockedError("Nested prerequisite lacks a verified successor.");
      continuationRef = dependencyDigest(checked);
    }
    if (entry.phase === "verified") {
      const outcome: AssignmentOutcome = { status: "verified", assignmentKey: key,
        evidenceRef: dependencyDigest(entry), reviewRef: reportDigest, headSha: entry.commitSha! };
      await attest(outcome);
      return outcome;
    }
    const authenticate = async () => {
      if (!suspension || !continuationRef) return false;
      const plan = (await inspectDependencyPlan(job))!;
      const owner = plan.entries.find(e => e.reportDigest === reportDigest)!;
      const nested = plan.entries.find(e => e.reportDigest === suspension.evidenceRef);
      if (!nested || nested.phase !== "verified" || dependencyDigest(nested) !== continuationRef ||
          nested.parent?.reportDigest !== reportDigest ||
          nested.parent.suspensionDigest !== suspension.suspensionRef ||
          nested.amendment?.assignment.specialist !== suspension.owner ||
          nested.amendment.resumes !== identity.assignmentId ||
          dependencyWriterBase(plan, owner) !== nested.commitSha) return false;
      return !!await supportingBoundary(job, owner);
    };
    const child = createGenerationQuestionGraph(job, identity,
      focusedChoiceWorkItem(input.target, identity.assignmentId), {
      preflight: rounds.preflight,
      authenticateContinuation: async state => state.continuationRef === continuationRef && await authenticate(),
      invoke: rounds.invoke,
      reenterWriter: rounds.invoke,
      correct: state => state.submission!.status === "writer-round" || !correctReview
        ? rounds.correct(state.submission!, state.correction!) : correctReview(state.submission!, state.correction!),
      verify: async state => state.submission!.status === "writer-round"
        ? rounds.verify(state.submission!) : verify(state.submission!),
    }, async head => !!continuationRef && await authenticate() && head === await trustedHead(job));
    const finished = await child.invoke({ identity, submission: null, submissionKey: null,
      outcome: null, continuationRef, suspension }, { ...childConfig, durability: "sync" });
    if (!finished.outcome || finished.outcome.assignmentKey !== key)
      throw new ProtocolIntegrityBlockedError("Supporting child returned a foreign outcome.");
    if (finished.outcome.status === "paused" && finished.outcome.controlRef === "job-control") throw new AssignmentAuthorPauseError();
    if (finished.outcome.status === "needs-prerequisite") {
      const original = await supportingSuspension(job, (await currentEntry())!, identity);
      if (!original || dependencyDigest(original) !== dependencyDigest(finished.outcome) || suspension)
        throw new ProtocolIntegrityBlockedError("Supporting child returned an untrusted or repeated suspension.");
      originalReturned = true;
      continue;
    }
    if (finished.outcome.status !== "verified")
      throw new SupportingAssignmentStop(reportDigest, finished.outcome);
    return finished.outcome;
  }
}

/** All prerequisite sources use the same controller admission boundary.
 * A deterministic proposal is permitted only for a uniquely bounded source;
 * otherwise the existing read-only planner supplies a proposal. */
async function admitDependency(job: import("./job.js").JobStartResult,
  plan: NonNullable<Awaited<ReturnType<typeof inspectDependencyPlan>>>,
  entry: NonNullable<Awaited<ReturnType<typeof inspectDependencyPlan>>>["entries"][number],
  input: Pick<FocusedWorkOptions, "provider" | "model" | "validatorSource" | "skillsSource">) {
  if (entry.amendment) return;
  if (await dependencyBoundary(job) !== entry.report.sourceSha)
    throw Error("Dependency proposal HEAD is stale.");
  const { policy } = await inspectPiPolicy(job);
  const source = blueprintSourceOf(entry);
  const proposal = source?.arcCandidates.length === 1 && entry.phase === "reported"
    ? { sourceSha: entry.report.sourceSha, reportDigest: entry.reportDigest, target: source.target,
        specialist: entry.report.likelySpecialist, outcome: entry.report.missing,
        reason: "Required by the independently reviewed prospective Milestone Blueprint.",
        title: source.target.slice(10).split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
        arcIds: [source.arcCandidates[0]!.id] }
    : await proposeDependency(job, plan, entry,
        input.provider ?? policy.profile.provider, input.model ?? policy.profile.model);
  if ("rejected" in proposal) {
    entry.phase = "rejected";
    entry.rejection = { kind: "planning-needed", reason: proposal.reason, proposal };
    await saveDependencyPlan(job, plan);
    throw new DependencyPlanningUnresolvedError(entry.reportDigest);
  }
  // A native/source/protection failure is not a rejected planner response.
  // Preserve the original planning state for receipt reconciliation.
  try {
    await approveDependency(job, plan, entry, proposal, input.validatorSource ?? input.skillsSource);
  } catch (error) {
    if (!(error instanceof DependencyAuthorizationRefusedError) || !entry.planner) throw error;
    entry.phase = "rejected";
    entry.rejection = { kind: "authorization-refused", reason: error.message, proposal };
    await saveDependencyPlan(job, plan);
    throw new DependencyPlanningUnresolvedError(entry.reportDigest);
  }
}

/** Serialized sub-work at the originating assignment's no-write boundary.
 * The parent stays on that assignment, so no second origin writer is scheduled.
 * All external effects are fenced by private receipts, independently of graph checkpoints. */
export async function advanceFocusedDependency(input: FocusedWorkOptions, config?: RunnableConfig,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  if (input.fixture) throw Error("Obsolete dependency fixture execution is retired.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const origin = JSON.parse(await readFile(join(job.stateDir, "focused-items", input.target + ".json"), "utf8")) as {
    jobId: string; workItemId: string; phase: string; dependencyReport?: DependencyReport;
    assignmentDigest?: string; worker: string;
  };
  if (origin.jobId !== job.jobId || origin.workItemId !== "focus:" + input.target ||
      origin.phase !== "waiting-dependency" || !origin.dependencyReport ||
      origin.assignmentDigest !== input.turnPlanDigest || origin.worker !== ("pi"))
    throw Error("Dependency amendment requires the exact suspended originating assignment.");
  const planVersion = (origin as { planVersion?: number }).planVersion;
  if (!input.turnPlanDigest || !Number.isSafeInteger(planVersion))
    throw Error("Dependency requires an authenticated original Turn and plan version.");
  const suspension = await inspectFocusedPrerequisite(job, input.target, input.turnPlanDigest,
    input.fixture, planVersion!);
  if (!suspension || suspension.phase !== "waiting-dependency")
    throw Error("Dependency requires the sealed original no-write session.");
  const report = suspension.report;
  const reportDigest = suspension.seal.reportDigest;
  await withStoryJobLock(job, "dependency-authorization", async () => {
    let plan = await inspectDependencyPlan(job);
    let entry = plan?.entries.find(e => e.reportDigest === reportDigest);
    const head = entry?.phase === "authorized" && plan?.entries.some(e => e.parent?.reportDigest === entry!.reportDigest)
      ? entry.report.sourceSha : await supportingBoundary(job, entry);
    if (!entry) ({ plan, entry } = await recordDependency(job, report, input.fixture));
    if (!plan || !entry || entry.fixture !== input.fixture) throw Error("Dependency mode/provenance changed.");
    if (entry.phase === "verified") {
      if (entry.commitSha !== head) throw Error("Completed dependency source is stale.");
      return entry.amendment!.assignment;
    }
    if (entry.phase === "reviewing" && (entry.commitSha === head || entry.supportRootSha) && entry.amendment)
      return entry.amendment.assignment;
    if (entry.phase === "reviewing" || entry.phase === "rejected")
      throw Error("Interrupted or rejected dependency work requires original receipt reconciliation; no replay.");
    await admitDependency(job, plan, entry, input);
    return entry.amendment!.assignment;
  });
  return runSupportingDependency(job, input, reportDigest, config, undefined, nativeDiagnostic);
}

/** The same parent prerequisite lane for an authenticated precommit writer.
 * Support is separately reviewed before affected-only revalidation, and
 * the original logical writer remains suspended throughout. */
export async function advanceWriterDependency(input: Omit<FocusedWorkOptions, "target"> & {
  source: import("./writer-dependency.js").WriterDependencySource;
  inventory: import("./generation-plan.js").GenerationInventory;
}, config?: RunnableConfig, caseId?: string,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  if (input.fixture) throw Error("Writer prerequisite requires original Pi evidence.");
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const { inspectWriterDependency } = await import("./writer-dependency.js");
  const { source, report, reportDigest } = await inspectWriterDependency(job, input.source);
  await withStoryJobLock(job, "dependency-authorization", async () => {
    let plan = await inspectDependencyPlan(job);
    let entry = plan?.entries.find(e => e.reportDigest === reportDigest);
    if (entry?.phase === "verified") return;
    if (entry?.phase === "rejected") {
      if (entry.rejection?.kind) throw new DependencyPlanningUnresolvedError(reportDigest);
      throw Error("Independent prerequisite Review rejected the supporting work.");
    }
    if (!entry || entry.phase !== "authorized" || !plan?.entries.some(e => e.parent?.reportDigest === reportDigest))
      await supportingBoundary(job, entry);
    if (!entry) {
      if (source.stage === "character")
        await (await import("./character-world.js")).archiveCharacterWriterDependency(job, source.sealDigest);
      else if (source.stage === "event")
        await (await import("./event-work.js")).archiveEventWriterDependency(job, source.milestoneId!, source.sealDigest);
      else if (source.stage === "composition")
        await (await import("./composition-work.js")).archiveCompositionWriterDependency(job, source.milestoneId!, source.sealDigest);
      else await (await import("./interactive-work.js")).archiveInteractiveWriterDependency(job, source.milestoneId!, source.stage, source.sealDigest);
      ({ plan, entry } = await recordDependency(job, report, false, undefined, source));
    }
    if (!plan || !entry) throw Error("Missing original writer dependency ledger entry.");
    await admitDependency(job, plan, entry, input);
  });
  let entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
  if (entry?.phase !== "verified")
    await runSupportingDependency(job, { ...input, target: source.targetId }, reportDigest, config, caseId, nativeDiagnostic);
  entry = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
  if (!entry || entry.phase !== "verified" || !entry.commitSha || entry.review?.verdict !== "pass")
    throw Error("Writer prerequisite has no independently verified support.");
  const support = entry;
  await withStoryJobLock(job, "writer-dependency-revalidation", async () => {
    const { executionId } = await import("./checkpoint-assurance.js");
    // A verified World subunit is an upstream producer even while its
    // composite parent remains pending. Project only its historical proof
    // for impact analysis; never mark the actual Generation item complete.
    const inventory = source.stage === "character" ? { ...input.inventory, items: input.inventory.items.map(item =>
      item.id === "foundations" && item.status === "pending"
        ? { ...item, status: "verified" as const, verifiedSha: source.producer.commitSha } : item) } : input.inventory;
    const producer = inventory.items.find(i => i.id === executionId(source.producer.workItem) &&
      i.status === "verified" && i.verifiedSha);
    if (!producer?.verifiedSha) throw Error("Writer prerequisite producer is not a completed original inventory item.");
    dependencyGit(job, "merge-base", "--is-ancestor", source.producer.commitSha, producer.verifiedSha);
    // A later cross-domain writer may legitimately edit a record created by
    // an earlier specialist. Its last-writer proof authenticates the source,
    // but impact must start at the first independently verified realization,
    // not at the later edit (which could skip intervening consumers).
    const repoPath = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + source.targetPath;
    const first = dependencyGit(job, "log", "--reverse", "--diff-filter=A", "--format=%H",
      report.sourceSha, "--", repoPath).split("\n")[0];
    let upstream = producer;
    if (first && first !== source.producer.commitSha &&
        first !== job.baseSha && dependencyGit(job, "merge-base", first, job.baseSha) !== first) {
      const { inspectHistoricalRecoveryCheckpoint } = await import("./recovery-checkpoints.js");
      const original = await inspectHistoricalRecoveryCheckpoint(job, first);
      const item = inventory.items.find(i => i.id === executionId(original.workItem) &&
        i.status === "verified" && i.verifiedSha);
      if (!item?.verifiedSha || original.assurance?.turnDigest !== report.turnDigest ||
          !original.assurance.changedPaths.includes(source.targetPath) ||
          !["passed", "not-required"].includes(original.semanticReview))
        throw Error("Writer prerequisite lost the earlier verified realization of its source.");
      dependencyGit(job, "merge-base", "--is-ancestor", first, item.verifiedSha);
      upstream = item;
    }
    const { revalidateAfterReviewedCorrection } = await import("./selective-revalidation-work.js");
    await revalidateAfterReviewedCorrection({ job, otherOwnerPath: source.targetPath,
      inventory: { ...inventory, headSha: report.sourceSha },
      correction: { version: 1, planVersion: source.planVersion, baseSha: report.sourceSha,
        successorSha: support.commitSha!, upstreamItemId: upstream.id, predecessorCommitSha: upstream.verifiedSha!,
        turnDigest: report.turnDigest, reviewDigest: dependencyDigest(support.review),
        changedPaths: [source.targetPath], permittedPaths: [source.targetPath] },
      contract: input.contract, task: input.task,
      provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
      skillsSource: input.skillsSource, validatorSource: input.validatorSource });
    if (source.stage === "character")
      await (await import("./character-world.js")).rebindCharacterAfterWriterDependency(job, source, reportDigest, dependencyDigest(support));
    else if (source.stage === "event")
      await (await import("./event-work.js")).rebindEventAfterWriterDependency(job, source, reportDigest, dependencyDigest(support));
    else if (source.stage === "composition")
      await (await import("./composition-work.js")).rebindCompositionAfterWriterDependency(job, source, reportDigest, dependencyDigest(support));
    else await (await import("./interactive-work.js")).rebindInteractiveAfterWriterDependency(job, source, reportDigest, dependencyDigest(support));
  });
  return { reportDigest, supportRef: dependencyDigest(support), head: await trustedHead(job) };
}

async function runSupportingDependency(job: import("./job.js").JobStartResult,
  input: FocusedWorkOptions, reportDigest: string, config?: RunnableConfig, caseId?: string,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  let saved = await inspectDependencyPlan(job);
  if (!config && saved?.entries.find(e => e.reportDigest === reportDigest)?.phase === "verified")
    return { status: "dependency-verified", reportDigest };
  const graphThreadId = config?.configurable?.thread_id;
  const admitted = saved?.entries.find(e => e.reportDigest === reportDigest);
  if (typeof graphThreadId !== "string" || !admitted?.amendment)
    throw Error("Supporting assignment requires the admitting Generation graph Thread.");
  const report = admitted.report;
  const assignment = admitted.amendment.assignment;
  const authorizedPaths = [...assignment.authority.existingPaths, ...(assignment.authority.newPaths ?? [])].sort();
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
    jobThreadId: job.threadId, graphThreadId, turnDigest: report.turnDigest,
    assignmentId: assignment.id, planVersion: admitted.amendment.afterVersion,
    sourceHeadSha: report.sourceSha, scopeDigest: dependencyDigest(assignment),
  };
  const key = logicalAssignmentKey(identity);
  const sharedReview = !!admitted.supportRootSha || !admitted.reviewerSession;
  const current = async () => (await inspectDependencyPlan(job))!.entries.find(e => e.reportDigest === reportDigest)!;
  const settle = async (head: string) => withStoryJobLock(job, "dependency-review-settlement", async () => {
    const plan = (await inspectDependencyPlan(job))!;
    const entry = plan.entries.find(e => e.reportDigest === reportDigest)!;
    if (await dependencyBoundary(job) !== head) throw Error("Support Review successor is stale.");
    const verdict = await inspectSharedSupportReview(job, entry, head);
    entry.commitSha = head;
    entry.review = verdict;
    entry.reviewerSession = verdict.sessionFile!;
    entry.reviewerSessionDigest = createHash("sha256").update(await readFile(verdict.sessionFile!)).digest("hex");
    // A review-discovered prerequisite still owes the original consumer's
    // independent rereview. Passing support alone never completes that entry.
    entry.phase = verdict.verdict === "pass" ? (entry.reviewSourceSha ? "reviewing" : "verified") : "rejected";
    await saveDependencyPlan(job, plan);
    return entry;
  });
  const transitions = async () => {
    const entry = await current();
    if (!entry.supportRootSha) throw Error("Support correction has no committed original root.");
    const root = entry.supportRootSha;
    return createReviewRoundTransitions({
      originalHead: root, originalReceipt: assignment.id,
      outcome: (status, evidenceRef, extra) => ({ status, assignmentKey: key, evidenceRef, ...extra }) as AssignmentOutcome,
      run: command => executeReviewRound(job, { rootSha: root, caseId: caseId ?? key,
        assignmentKey: key, workItem: assignment.id }, command, {
        skillsSource: input.skillsSource, provider: input.provider, model: input.model, nativeDiagnostic,
      }),
      verifySuccessor: async head => await trustedHead(job) === head &&
        (await inspectSharedSupportReview(job, await current(), head)).verdict === "pass",
    });
  };
  const verifyShared = async (submission: AssignmentSubmission) => {
    if (submission.status === "focused-committed") {
      await withStoryJobLock(job, "dependency-review-root", async () => {
        const plan = (await inspectDependencyPlan(job))!;
        const entry = plan.entries.find(e => e.reportDigest === reportDigest)!;
        if (!entry.supportRootSha) {
          const head = await dependencyBoundary(job);
          if (head !== submission.headSha || submission.receiptRef !== assignment.id)
            throw Error("Support Review lost its committed writer submission.");
          entry.supportRootSha = head;
          entry.commitSha = head;
          entry.phase = "reviewing";
          await saveDependencyPlan(job, plan);
        }
        if (entry.supportRootSha !== submission.headSha || submission.receiptRef !== assignment.id)
          throw Error("Support Review lost its original root.");
        await reviewSupportRoot(job, entry, dependencyWriterBase(plan, entry));
      });
      const entry = await current();
      const root = entry.supportRootSha!;
      const point = (await inspectRecoveryCheckpoints(job, "historical")).find(p => p.eligible && p.commitSha === root);
      if (!point) throw Error("Support Review lost its checkpoint.");
      if (point.semanticReview === "failed" && await trustedHead(job) === root) {
        const { inspectCheckpointReview } = await import("./checkpoint-assurance.js");
        const { reviewNeedsDependency } = await import("./review-repair-amendment.js");
        const review = await inspectCheckpointReview(job, point);
        if (point.assurance && review?.result &&
            reviewNeedsDependency(point.assurance, review.result, assignment.id)) {
          const terminal = await settle(root);
          return { status: "unresolved" as const, assignmentKey: key,
            evidenceRef: dependencyDigest(terminal), dispositionRef: "support-review-negative" };
        }
      }
      if (point.semanticReview === "passed") {
        const complete = await settle(root);
        return { status: "verified" as const, assignmentKey: key, evidenceRef: dependencyDigest(complete),
          reviewRef: reportDigest, headSha: root };
      }
    }
    const result = await (await transitions()).verify(submission);
    const outcome = "outcome" in result ? result.outcome : "assignmentKey" in result ? result : null;
    if (outcome?.status === "verified") {
      const complete = await settle(outcome.headSha);
      const verified = { status: "verified" as const, assignmentKey: key, evidenceRef: dependencyDigest(complete),
        reviewRef: reportDigest, headSha: outcome.headSha };
      return "submission" in result ? { submission: result.submission, outcome: verified } : verified;
    }
    return result;
  };
  await runSupportingChild(job, { ...input, target: assignment.targets[0]!,
    dependencyAssignmentId: assignment.id }, identity, reportDigest, sharedReview ? verifyShared : async result => {
      const complete = await withStoryJobLock(job, "dependency-review", async () => {
    const head = await dependencyBoundary(job);
    saved = await inspectDependencyPlan(job);
    const entry = saved?.entries.find(e => e.reportDigest === reportDigest);
    if (entry?.phase === "verified" && entry.commitSha === head && head === result.headSha)
      return entry;
    if (!saved || !entry || !["authorized", "reviewing"].includes(entry.phase) || head !== result.headSha ||
        (entry.phase === "reviewing" && entry.commitSha !== head))
      throw Error("Dependency review source or receipt changed.");
    const writerBase = dependencyWriterBase(saved, entry);
    const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", assignment.id + ".json"), "utf8"));
    if (proof.phase !== "committed" || proof.commitSha !== head || proof.expectedHead !== writerBase ||
        proof.workItemId !== assignment.id || proof.jobId !== job.jobId ||
        proof.assignmentDigest !== input.turnPlanDigest ||
        JSON.stringify(proof.paths) !== JSON.stringify(authorizedPaths))
      throw Error("Dependency work receipt is stale or out of scope.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const changed = dependencyGit(job, "diff", "--name-only", writerBase, head).split("\n");
    if (JSON.stringify(changed) !== JSON.stringify(authorizedPaths.map(p => prefix + p)) ||
        dependencyGit(job, "rev-parse", head + "^") !== writerBase)
      throw Error("Dependency commit differs from exact authorized work.");
    entry.commitSha = head; entry.phase = "reviewing";
    await saveDependencyPlan(job, saved);
    const turn = await dependencyTurn(job);
    const review = supportingReviewAssignment(job, saved, entry, turn);
    {
      if (!proof.snapshot || await openSkillSnapshot(proof.snapshot.id) !== proof.snapshot.path)
        throw Error("Dependency reviewer lacks the original pinned skill snapshot.");
      const reviewKey = "focused-support:" + reportDigest;
      if (entry.reviewerSession) {
        const { inspectCompletedPiReviewContext } = await import("./job-pi-policy.js");
        const completion = await inspectCompletedPiReviewContext(job, {
          group: "narrative:" + review.planVersion + ":independent:" + reviewKey,
          sessionFile: entry.reviewerSession, snapshotId: proof.snapshot.id,
          requested: { provider: proof.provider, model: proof.model },
        });
        const { recoveredCloseoutReview } = await import("./cross-domain-closeout-work.js");
        entry.review = { ...await recoveredCloseoutReview(job, entry.reviewerSession,
          completion.sessionSha256, review), sessionFile: entry.reviewerSession };
      } else entry.review = await reviewNarrative({ ...job, headSha: head }, proof.snapshot, review, proof.provider, proof.model,
        undefined, async sessionFile => {
          entry.reviewerSession = sessionFile;
          await saveDependencyPlan(job, saved!);
        }, reviewKey);
      if (!entry.reviewerSession) throw Error("Supporting review lacks a persistent Pi transcript.");
      entry.reviewerSessionDigest = createHash("sha256").update(await readFile(entry.reviewerSession)).digest("hex");
    }
    if (await dependencyBoundary(job) !== head) throw Error("Dependency review changed the Story source.");
    entry.phase = entry.review.verdict === "pass" ? "verified" : "rejected";
    await saveDependencyPlan(job, saved);
    if (entry.phase !== "verified") throw Error("Independent dependency review rejected the prerequisite; preserve work for author reconciliation.");
    return entry;
      });
      return { status: "verified", assignmentKey: key, evidenceRef: dependencyDigest(complete),
        reviewRef: reportDigest, headSha: complete.commitSha! };
  }, config!, sharedReview ? async (submission, correction) => (await transitions()).correct(submission, correction) : undefined, caseId, nativeDiagnostic);
  return { status: "dependency-verified", reportDigest };
}

/** Realize each independently reviewed prospective Character through the
 * existing dependency child. A later Event consumes the unchanged pin only
 * after every supporting commit has native and independent review proof. */
export async function advanceBlueprintDependency(input: Omit<FocusedWorkOptions, "target">,
  readiness: import("./event-work.js").EventBlueprintPrerequisite, config?: RunnableConfig, caseId?: string,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const { archiveEventBlueprintPrerequisite, inspectArchivedEventBlueprintPrerequisite,
    blueprintReadinessHistory, rebindEventAfterBlueprintPredecessors } = await import("./event-work.js");
  const { existsSync } = await import("node:fs");
  const original = await withStoryJobLock(job, "blueprint-dependency-admission", async () =>
    existsSync(blueprintReadinessHistory(job, readiness.milestoneId, readiness.reportDigest))
      ? inspectArchivedEventBlueprintPrerequisite(job, readiness.milestoneId, readiness.reportDigest)
      : archiveEventBlueprintPrerequisite(job, readiness, input.validatorSource ?? input.skillsSource));
  if (input.fixture || JSON.stringify(original.report) !== JSON.stringify(readiness) ||
      (await dependencyTurn(job)).digest !== input.turnPlanDigest)
    throw Error("Blueprint prerequisite is not an authorized reviewed dependency.");
  for (const target of [...new Set(readiness.blockers.map(b => b.characterId))]) {
    const admitted = await withStoryJobLock(job, "blueprint-dependency-authorization", async () => {
      let plan = await inspectDependencyPlan(job);
      let entry = plan?.entries.find(e => e.blueprintSource?.readinessDigest === readiness.reportDigest &&
        e.blueprintSource.target === target);
      if (entry?.phase === "verified") return entry;
      if (entry?.phase === "rejected") {
        if (entry.rejection?.kind)
          throw new DependencyPlanningUnresolvedError(entry.reportDigest);
        throw Error("Independent prerequisite review rejected the supporting work.");
      }
      if (!entry || entry.phase !== "authorized" || !plan?.entries.some(e => e.parent?.reportDigest === entry!.reportDigest))
        await supportingBoundary(job, entry);
      if (!entry) {
        const { processAuthorUpdatesAfterWork } = await import("./author-updates.js");
        const author = await processAuthorUpdatesAfterWork(job);
        if ("error" in author || author.status !== "ready") throw new AssignmentAuthorPauseError();
        ({ plan, entry } = await registerBlueprintDependency(job, readiness.milestoneId, readiness.reportDigest, target,
          input.validatorSource ?? input.skillsSource));
      }
      if (!plan || !entry) throw Error("Missing Blueprint dependency ledger entry.");
      await admitDependency(job, plan, entry, input);
      return entry;
    });
    await runSupportingDependency(job, { ...input, target }, admitted.reportDigest, config, caseId, nativeDiagnostic);
  }
  const { head, digest, entries } = await withStoryJobLock(job, "blueprint-dependency-rebind", () =>
    rebindEventAfterBlueprintPredecessors(job, readiness.milestoneId, readiness.reportDigest,
      input.validatorSource ?? input.skillsSource));
  return { head, digest, history: entries.map(e => ({ reportDigest: e.reportDigest, entryDigest: dependencyDigest(e) })) };
}

/** S14: resume a rejected, *completed* Character Foundations checkpoint with
 * one fresh, owner-typed supporting assignment. The failed review, original
 * Pi writer session and original Turn stay immutable. This shares the normal
 * dependency report/plan version/approval/commit/review machinery. A second,
 * independent read-only review must also verify the suspended original
 * Character Foundations obligation at the new source before the review gate
 * may regard the old failure as covered. */
export async function advanceReviewDependency(input: {
  story: string; job: string; task: string; contract: FocusedWorkOptions["contract"];
  skillsSource?: string; validatorSource?: string; provider?: string; model?: string;
  turnPlanDigest: string; request: ReviewDependencyRequest;
}, graphConfig?: RunnableConfig, caseId?: string,
  nativeDiagnostic?: import("./rejected-review-repair.js").NativeDiagnosticContinuation) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const request = input.request;
  const eventSource = request.classification === "new-full-story-record" &&
    request.originalWorkItem.startsWith("event-");
  const otherOwner = request.classification === "other-owner";
  if (!["new-full-story-record", "other-owner"].includes(request.classification) ||
      request.action !== "controller-amendment-required" ||
      request.turnDigest !== input.turnPlanDigest)
    throw Error("Review-dependency execution requires an unchanged full-Story Character obligation.");
  const assignment = await withStoryJobLock(job, "review-dependency-authorization", async () => {
    const existing = await inspectDependencyPlan(job);
    const prior = existing?.entries.find(e => e.reviewSourceSha === request.sourceSha);
    const head = prior?.phase === "authorized" && existing?.entries.some(e => e.parent?.reportDigest === prior.reportDigest)
      ? prior.report.sourceSha : await supportingBoundary(job, prior);
    const { plan, entry } = existing && prior?.amendment && (prior.phase === "authorized" || prior.phase === "reviewing" && prior.supportRootSha) &&
      existing.reviewRequests?.some(r => dependencyDigest(r) === dependencyDigest(request))
      ? { plan: existing, entry: prior }
      : await registerReviewDependency(job, request, input.validatorSource ?? input.skillsSource);
    if (entry.phase === "verified") return entry.amendment!.assignment;
    if (entry.phase === "reviewing" && (entry.commitSha === head || entry.supportRootSha))
      return entry.amendment!.assignment;
    if (entry.phase === "reviewing" || entry.phase === "rejected")
      throw Error("Interrupted or rejected review-dependency work requires exact manual reconciliation; never replay model sessions.");
    if (entry.phase !== "reported" && entry.phase !== "planning" && entry.phase !== "authorized")
      throw Error("Review dependency has an unsupported work-plan phase.");
    await admitDependency(job, plan, entry, input);
    return entry.amendment!.assignment;
  });
  const saved = await inspectDependencyPlan(job);
  const entry = saved?.entries.find(e => e.reviewSourceSha === request.sourceSha);
  if (!entry?.amendment || entry.amendment.assignment.id !== assignment.id)
    throw Error("New Character supporting assignment lost its approved work-plan version.");
  if (entry.phase === "verified")
    return { status: "dependency-verified" as const, sourceSha: request.sourceSha };
  if (entry.phase === "reviewing" && entry.review?.verdict === "pass")
    return { status: "dependency-support-verified" as const, sourceSha: request.sourceSha };
  if (entry.phase !== "authorized" && entry.phase !== "reviewing")
    throw Error("Review-dependency authoring is not in an approved phase.");
  // New review-origin roots share the same mandatory checkpointed support
  // Review, native correction, and original-session repair as writer-origin
  // and Blueprint-origin support. A pre-cutover review session must remain
  // on its original receipt path; never substitute a new independent reviewer.
  if (entry.supportRootSha || (!entry.reviewerSession && !entry.reviewSnapshot)) {
    await runSupportingDependency(job, { ...input, target: assignment.targets[0]!, fixture: false },
      entry.reportDigest, graphConfig, caseId, nativeDiagnostic);
    return { status: "dependency-support-verified" as const, sourceSha: request.sourceSha };
  }
  const verify = async (result: { headSha?: string }) => withStoryJobLock(job, "review-dependency-independent-review", async () => {
    const head = await dependencyBoundary(job);
    const persisted = await inspectDependencyPlan(job);
    const current = persisted?.entries.find(e => e.reportDigest === entry.reportDigest);
    if (!persisted || !current || !["authorized", "reviewing", "verified"].includes(current.phase) ||
        !current.amendment || head !== result.headSha ||
        current.amendment.sourceSha !== request.sourceSha)
      throw Error("Review-dependency reviewer source or original grant was replaced.");
    if (current.review?.verdict === "pass") return current;
    const writerBase = dependencyWriterBase(persisted, current);
    const paths = [...assignment.authority.existingPaths,
      ...(assignment.authority.newPaths ?? [])].sort();
    const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items",
      assignment.id + ".json"), "utf8"));
    if (proof.phase !== "committed" || proof.commitSha !== head ||
        proof.expectedHead !== writerBase || proof.jobId !== job.jobId ||
        proof.workItemId !== assignment.id || proof.assignmentDigest !== request.turnDigest ||
        JSON.stringify(proof.paths) !== JSON.stringify(paths) || !proof.validation ||
        proof.validation.status !== "passed")
      throw Error("Review-dependency commit does not match the exact native-validated Character/Arc receipt.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const changed = dependencyGit(job, "diff", "--name-only", writerBase, head);
    if (JSON.stringify(changed.split("\n")) !== JSON.stringify(paths.map(p => prefix + p)) ||
        dependencyGit(job, "rev-parse", head + "^") !== writerBase)
      throw Error("Review-dependency commit has unapproved paths or Git ancestry.");
    const points = await inspectRecoveryCheckpoints(job);
    const originalPoint = points.find(p => p.eligible && p.commitSha === request.sourceSha &&
      p.assurance?.assignmentId === request.originalAssignmentId &&
      p.semanticReview === "failed");
    if (!originalPoint?.assurance)
      throw Error("Original negative checkpoint is not still sealed and independently failed.");
    const turn = await dependencyTurn(job);
    const original = turn.assignments.find(a => a.id === request.originalAssignmentId);
    if (!original || turn.digest !== request.turnDigest ||
        JSON.stringify(turn.contract) !== JSON.stringify(input.contract))
      throw Error("Rereview would replace the original Turn or specialist ownership.");
    const { policy } = await inspectPiPolicy(job);
    const provider = input.provider ?? policy.profile.provider;
    const model = input.model ?? policy.profile.model;
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource,
        skillDirs: [], requiredSkills: [] }
      : await loadSkillConfig(undefined, false);
    const snapshot = current.reviewSnapshot ?? await createSkillSnapshot({ ...config,
      requiredSkills: ["nt-narrative-review", "nt-catalog"] });
    if (!snapshot) throw Error("Supporting dependency lacks a pinned independent reviewer.");
    if (await openSkillSnapshot(snapshot.id) !== snapshot.path)
      throw Error("Independent review snapshot is not immutable.");
    if (current.phase === "reviewing" && (current.reviewProvider !== provider ||
        current.reviewModel !== model || !current.reviewSnapshot))
      throw Error("Supporting Review lost its pinned model and methods.");
    current.commitSha = head;
    current.phase = "reviewing";
    current.reviewSnapshot = snapshot;
    current.reviewProvider = provider;
    current.reviewModel = model;
    await saveDependencyPlan(job, persisted);
    const diff = dependencyGit(job, "diff", writerBase, head, "--",
      ...paths.map(p => prefix + p));
    const base = {
      contract: input.contract, planVersion: current.amendment.afterVersion,
      scopeIds: [assignment.targets[0]!, ...current.report.affectedIds],
      routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    };
    const support: ReviewAssignment = {
      ...base, paths, specialistAssignments: [assignment],
      turnGoal: otherOwner
        ? "Review ONLY the separately authorized existing other-owner record " +
          request.otherOwnerPath + " against the cited original review obligation. " +
          "Do not broaden the original author objective or change any other Story path. " +
          "The originating specialist remains independently failed and must be reassessed " +
          "at the new HEAD before it can count as completed."
        : eventSource
        ? "Review ONLY the separately authorized new Character's grounded role in the " +
          "original Event source; that Event is READ-ONLY and still has a failed review. " +
          "The Event specialist, NOT this Character specialist, must later append the " +
          "Character to participants and correct its prose. The lack of enacted testimony " +
          "or Event attendance is the PRECISE ORIGINAL FAILED OBLIGATION and is deferred " +
          "to that Event owner: it is NOT a Character-stage blocker. Judge whether this " +
          "new Character has a source-grounded reason to be asked to testify, a credible " +
          "role and motivation, honest initial knowledge, and no invented prior acts. " +
          "Do NOT demand this Character profile itself enact an encounter or solve the " +
          "original Event's absent dialogue; that would create a dependency cycle."
        : "Review ONLY this new Character specialist's exact necessary support for the " +
          "original complete-Story Character Foundations requirement. No later Events, " +
          "Choices or authored dialogue need to be complete at this checkpoint. " +
          "Demand authentic motivation/initial knowledge and a single legitimate Arc link; " +
          "reject retconned Character history, invented culprit, unearned facts or any unrelated change.",
      dependency: { sourceSha: writerBase, commitSha: head,
        obligation: current.report.obligation, reason: current.amendment.reason,
        sources: current.report.sources.map(s => ({ path: s.path, quote: s.quote })), diff },
    };
    // The Job was opened at the failed source before its supporting writer
    // committed. Pin both fresh reviewer contexts to the verified successor,
    // not the stale job.headSha cached at admission.
    const reviewJob = { ...job, headSha: head };
    const reviewKey = "review-support:" + current.reportDigest;
    if (current.reviewerSession) {
      const { inspectCompletedPiReviewContext } = await import("./job-pi-policy.js");
      const completion = await inspectCompletedPiReviewContext(job, {
        group: "narrative:" + support.planVersion + ":independent:" + reviewKey,
        sessionFile: current.reviewerSession, snapshotId: snapshot.id,
        requested: { provider, model },
      });
      const { recoveredCloseoutReview } = await import("./cross-domain-closeout-work.js");
      current.review = { ...await recoveredCloseoutReview(job, current.reviewerSession,
        completion.sessionSha256, support), sessionFile: current.reviewerSession };
    } else current.review = await reviewNarrative(reviewJob, snapshot, support, provider, model,
      undefined, async file => {
        current.reviewerSession = file;
        await saveDependencyPlan(job, persisted);
      }, reviewKey);
    if (!current.reviewerSession) throw Error("Supporting Review has no persistent Pi session.");
    current.reviewerSessionDigest = createHash("sha256").update(await readFile(current.reviewerSession)).digest("hex");
    if (await dependencyBoundary(job) !== head)
      throw Error("Independent supporting review changed the Story HEAD.");
    if (current.review.verdict !== "pass") {
      current.phase = "rejected";
      await saveDependencyPlan(job, persisted);
      throw Error("Independent review rejected the new Character or Arc link; preserve original failure and model session.");
    }
    // This is only the supporting child's verdict, not the original Review.
    await saveDependencyPlan(job, persisted);
    return current;
  });
  {
    const graphThreadId = graphConfig?.configurable?.thread_id;
    if (typeof graphThreadId !== "string")
      throw Error("Review support requires the admitting parent graph Thread.");
    const identity: AssignmentIdentity = {
      schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
      graphThreadId, turnDigest: request.turnDigest, assignmentId: assignment.id,
      planVersion: entry.amendment.afterVersion, sourceHeadSha: request.sourceSha,
      scopeDigest: dependencyDigest(assignment),
    };
    const key = logicalAssignmentKey(identity);
    await runSupportingChild(job, { ...input, target: assignment.targets[0]!, fixture: false,
      dependencyAssignmentId: assignment.id }, identity, entry.reportDigest, async submission => {
        const reviewed = await verify(submission);
        if (reviewed.review?.verdict !== "pass" || !reviewed.commitSha)
          throw Error("Supporting child lacks independent positive review.");
        return { status: "verified", assignmentKey: key, evidenceRef: reviewed.reportDigest,
          reviewRef: reviewed.reviewerSessionDigest!, headSha: reviewed.commitSha };
    }, graphConfig!);
  }
  return { status: "dependency-support-verified" as const, sourceSha: request.sourceSha };
}

/** Exact support proof, independent of the originating Review's disposition.
 * This digest remains stable when the old Review is subsequently continued. */
export async function inspectReviewSupport(job: import("./job.js").JobStartResult,
  request: ReviewDependencyRequest) {
  const plan = await inspectDependencyPlan(job);
  const entry = plan?.entries.find(e => e.reviewSourceSha === request.sourceSha);
  if (!plan?.reviewRequests?.some(r => dependencyDigest(r) === dependencyDigest(request)) ||
      !entry?.amendment || !entry.commitSha || !entry.reviewerSessionDigest ||
      !["reviewing", "verified"].includes(entry.phase) || entry.review?.verdict !== "pass")
    throw Error("Original Review has no independently verified supporting assignment.");
  const ref = dependencyDigest({ reportDigest: entry.reportDigest, amendment: entry.amendment,
    commitSha: entry.commitSha, verdict: entry.review, session: entry.reviewerSessionDigest });
  return { entry, ref };
}

/** Resume the actual negative Pi Review at its independently verified
 * successor; no new writer or fresh reviewer is authorized. */
export async function continueReviewDependency(job: import("./job.js").JobStartResult,
  request: ReviewDependencyRequest, supportRef: string) {
  return withStoryJobLock(job, "review-dependency-original-review", async () => {
    const checked = await inspectReviewSupport(job, request);
    if (checked.ref !== supportRef) throw Error("Review continuation support changed.");
    const head = await dependencyBoundary(job);
    const plan = (await inspectDependencyPlan(job))!;
    const entry = plan.entries.find(e => e.reportDigest === checked.entry.reportDigest)!;
    if (entry.phase === "verified") {
      if (entry.commitSha !== head) {
        const { verifiedNarrativeChain } = await import("./job-successor.js");
        await verifiedNarrativeChain(job, entry.commitSha!, head);
      }
      return entry;
    }
    if (entry.commitSha !== head) throw Error("Original Review continuation is not at the verified supporting commit.");
    if (request.originalWorkItem.startsWith("event-") && request.classification === "new-full-story-record")
      throw Error("Event prerequisite requires the original Event writer correction, not a read-only waiver.");
    const turn = await dependencyTurn(job);
    const original = turn.assignments.find(a => a.id === request.originalAssignmentId);
    const point = (await inspectRecoveryCheckpoints(job)).find(p => p.eligible &&
      p.commitSha === request.sourceSha && p.semanticReview === "failed" &&
      p.assurance?.assignmentId === request.originalAssignmentId);
    const { inspectPostcommitReviewCycle } = await import("./postcommit-review-cycle.js");
    const cycle = await inspectPostcommitReviewCycle(job, request.sourceSha, request.originalAssignmentDigest);
    const round = cycle?.rounds.find(r => r.commitSha === request.sourceSha);
    if (!original || !point?.assurance || !cycle || !round || cycle.turnDigest !== request.turnDigest ||
        await openSkillSnapshot(cycle.snapshot.id) !== cycle.snapshot.path)
      throw Error("Original negative Review session or pinned assignment is missing.");
    const assignment = entry.amendment!.assignment;
    const paths = [...assignment.authority.existingPaths, ...(assignment.authority.newPaths ?? [])].sort();
    const reassess: ReviewAssignment = {
      contract: turn.contract, planVersion: entry.amendment!.afterVersion,
      scopeIds: [...new Set([...original.targets, ...assignment.targets])],
      paths: [...new Set([...point.assurance.changedPaths, ...paths])].sort(),
      routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
      specialistAssignments: [original, assignment],
      turnGoal: "Reassess ONLY the ORIGINAL independently failed specialist assignment. " +
        "Verify every sealed negative finding using the current canonical Story and the exact " +
        "supporting commit. The prior negative verdict remains immutable. Do not certify " +
        "completion based solely on the supporting writer or its independent review.",
      reassessment: { assignmentId: original.id, failedSourceSha: request.sourceSha, correctedHeadSha: head },
    };
    const reviewJob = { ...job, headSha: head };
    if (entry.originalReviewerSession) {
      if (entry.originalReviewerSession !== cycle.reviewer.file)
        throw Error("Original negative reviewer identity changed.");
      const { inspectCompletedPiReviewContext } = await import("./job-pi-policy.js");
      const completion = await inspectCompletedPiReviewContext(job, {
        group: "assignment-fidelity:" + cycle.id + (cycle.protocolFresh ? ":protocol-fresh" : ""),
        sessionFile: cycle.reviewer.file, snapshotId: cycle.snapshot.id,
        requested: { provider: cycle.provider, model: cycle.model },
      });
      if ((await readFile(cycle.reviewer.file)).length <= round.transcriptBytes)
        throw Error("Original Review continuation has no newly completed verdict; never replay a claimed turn.");
      const { recoveredCloseoutReview } = await import("./cross-domain-closeout-work.js");
      entry.originalReview = { ...await recoveredCloseoutReview(job, cycle.reviewer.file,
        completion.sessionSha256, reassess), sessionFile: cycle.reviewer.file };
    } else {
      if ((await readFile(cycle.reviewer.file)).length !== round.transcriptBytes)
        throw Error("Original negative Review has unexpected unclaimed transcript effects.");
      entry.originalReview = await reviewNarrative(reviewJob, cycle.snapshot, reassess,
        cycle.provider, cycle.model, cycle.thinking, async file => {
          if (file !== cycle.reviewer.file) throw Error("Original reviewer session was replaced.");
          entry.originalReviewerSession = file;
          await saveDependencyPlan(job, plan);
        }, undefined, { cycle, changedPaths: paths });
    }
    if (await dependencyBoundary(job) !== head)
      throw Error("Independent original-goal rereview changed the Story HEAD.");
    const transcript = await readFile(cycle.reviewer.file);
    entry.originalReviewerSessionDigest = createHash("sha256").update(transcript).digest("hex");
    entry.originalReviewerSessionBytes = transcript.length;
    entry.phase = entry.originalReview.verdict === "pass" ? "verified" : "rejected";
    await saveDependencyPlan(job, plan);
    if (entry.phase !== "verified")
      throw Error("Original obligation remains independently failed after support.");
    return entry;
  });
}
export const advanceReviewCharacterDependency = advanceReviewDependency;
