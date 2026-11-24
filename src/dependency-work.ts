import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createAssignmentLifecycleGraph, logicalAssignmentKey, type AssignmentIdentity } from "./generation-assignment-lifecycle.js";
import { join } from "node:path";
import { startStoryJob } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { inspectFocusedPrerequisite, runFocusedWorkItem, type FocusedWorkOptions } from "./focused-work.js";
import { dependencyBoundary, dependencyTurn, dependencyDigest, dependencyGit,
  recordDependency, registerReviewDependency, approveDependency,
  inspectDependencyPlan, saveDependencyPlan } from "./dependency-state.js";
import { proposeDependency } from "./dependency-planner.js";
import { type DependencyReport, type DependencyProposal } from "./dependency-amendments.js";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { createSkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { focusedSpecialist } from "./focused-specialist.js";
import { inspectPiPolicy } from "./job-pi-policy.js";
import { openSkillSnapshot } from "./snapshot.js";
import { reviewNarrative, type ReviewAssignment } from "./narrative-review-specialist.js";

/** Serialized sub-work at the originating assignment's no-write boundary.
 * The parent stays on that assignment, so no second origin writer is scheduled.
 * All external effects are fenced by private receipts, independently of graph checkpoints. */
export async function advanceFocusedDependency(input: FocusedWorkOptions, config?: RunnableConfig) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const origin = JSON.parse(await readFile(join(job.stateDir, "focused-items", input.target + ".json"), "utf8")) as {
    jobId: string; workItemId: string; phase: string; dependencyReport?: DependencyReport;
    assignmentDigest?: string; worker: string;
  };
  if (origin.jobId !== job.jobId || origin.workItemId !== "focus:" + input.target ||
      origin.phase !== "waiting-dependency" || !origin.dependencyReport ||
      origin.assignmentDigest !== input.turnPlanDigest || origin.worker !== (input.fixture ? "fixture" : "pi"))
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
  const assignment = await withStoryJobLock(job, "dependency-authorization", async () => {
    const head = await dependencyBoundary(job);
    let plan = await inspectDependencyPlan(job);
    let entry = plan?.entries.find(e => e.reportDigest === reportDigest);
    if (!entry) ({ plan, entry } = await recordDependency(job, report, input.fixture));
    if (!plan || !entry || entry.fixture !== input.fixture) throw Error("Dependency mode/provenance changed.");
    if (entry.phase === "verified") {
      if (entry.commitSha !== head) throw Error("Completed dependency source is stale.");
      return entry.amendment!.assignment;
    }
    if (entry.phase === "reviewing" && entry.commitSha === head && entry.amendment)
      return entry.amendment.assignment;
    if (entry.phase === "reviewing" || entry.phase === "rejected" || entry.phase === "planning" && input.fixture)
      throw Error("Interrupted or rejected dependency work requires original receipt reconciliation; no replay.");
    if (!entry.amendment) {
      if (head !== report.sourceSha) throw Error("Dependency proposal HEAD is stale.");
      const { policy } = await inspectPiPolicy(job);
      let proposal: DependencyProposal;
      if (input.fixture) {
        const target = report.affectedIds.find(id => !origin.workItemId.endsWith(id) &&
          focusedSpecialist(id) === report.likelySpecialist);
        if (!target) throw Error("Fixture dependency has no owning target.");
        proposal = { sourceSha: report.sourceSha, reportDigest, target,
          specialist: report.likelySpecialist, outcome: report.missing,
          reason: "Deterministic dependency fixture: " + report.missing };
      } else proposal = await proposeDependency(job, plan, entry,
        input.provider ?? policy.profile.provider, input.model ?? policy.profile.model);
      try {
        await approveDependency(job, plan, entry, proposal, input.validatorSource ?? input.skillsSource);
      } catch (error) {
        entry.phase = "rejected";
        entry.rejection = { reason: error instanceof Error ? error.message : String(error), proposal };
        await saveDependencyPlan(job, plan);
        throw error;
      }
    }
    return entry.amendment!.assignment;
  });
  let saved = await inspectDependencyPlan(job);
  if (saved?.entries.find(e => e.reportDigest === reportDigest)?.phase === "verified")
    return { status: "dependency-verified", reportDigest };
  const graphThreadId = config?.configurable?.thread_id;
  const admitted = saved?.entries.find(e => e.reportDigest === reportDigest);
  if (typeof graphThreadId !== "string" || !admitted?.amendment)
    throw Error("Supporting assignment requires the admitting Generation graph Thread.");
  const identity: AssignmentIdentity = {
    schema: "noveltea-assignment-identity/v1", jobId: job.jobId,
    jobThreadId: job.threadId, graphThreadId, turnDigest: report.turnDigest,
    assignmentId: assignment.id, planVersion: admitted.amendment.afterVersion,
    sourceHeadSha: report.sourceSha, scopeDigest: dependencyDigest(assignment),
  };
  const key = logicalAssignmentKey(identity);
  const child = createAssignmentLifecycleGraph({
    preflight: async () => {
      const current = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
      if (!current?.amendment || dependencyDigest(current.amendment.assignment) !== identity.scopeDigest ||
          current.amendment.afterVersion !== identity.planVersion ||
          !["authorized", "reviewing", "verified"].includes(current.phase))
        throw Error("Supporting child lost its exact controller authorization.");
      return null;
    },
    invoke: async () => {
      const current = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === reportDigest);
      if (current?.phase === "reviewing")
        return { receiptRef: assignment.id, status: "focused-committed", headSha: current.commitSha };
      const result = await runFocusedWorkItem({ ...input, target: assignment.targets[0]!,
        dependencyAssignmentId: assignment.id });
      if (result.status !== "focused-committed" || !result.headSha)
        throw Error("Dependency specialist did not publish a native-validated bounded commit.");
      return { receiptRef: assignment.id, status: result.status, headSha: result.headSha };
    },
    verify: async state => {
      const result = state.submission!;
      const complete = await withStoryJobLock(job, "dependency-review", async () => {
    const head = await dependencyBoundary(job);
    saved = await inspectDependencyPlan(job);
    const entry = saved?.entries.find(e => e.reportDigest === reportDigest);
    if (entry?.phase === "verified" && entry.commitSha === head && head === result.headSha)
      return entry;
    if (!saved || !entry || !["authorized", "reviewing"].includes(entry.phase) || head !== result.headSha ||
        (entry.phase === "reviewing" && entry.commitSha !== head))
      throw Error("Dependency review source or receipt changed.");
    const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items", assignment.id + ".json"), "utf8"));
    if (proof.phase !== "committed" || proof.commitSha !== head || proof.expectedHead !== report.sourceSha ||
        proof.workItemId !== assignment.id || proof.jobId !== job.jobId ||
        proof.assignmentDigest !== input.turnPlanDigest ||
        JSON.stringify(proof.paths) !== JSON.stringify(assignment.authority.existingPaths))
      throw Error("Dependency work receipt is stale or out of scope.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const changed = dependencyGit(job, "diff", "--name-only", report.sourceSha, head).split("\n");
    if (JSON.stringify(changed) !== JSON.stringify(assignment.authority.existingPaths.map(p => prefix + p)) ||
        dependencyGit(job, "rev-parse", head + "^") !== report.sourceSha)
      throw Error("Dependency commit differs from exact authorized work.");
    entry.commitSha = head; entry.phase = "reviewing";
    await saveDependencyPlan(job, saved);
    const turn = await dependencyTurn(job);
    const dependencyContract = { ...turn.contract, scope: { ...turn.contract.scope,
      targets: assignment.targets, supportingTargets: [], creates: [] } };
    const review: ReviewAssignment = { contract: dependencyContract,
      planVersion: entry.amendment!.afterVersion, scopeIds: entry.report.affectedIds,
      paths: [...new Set([...assignment.authority.existingPaths, ...report.sources.map(s => s.path)])],
      routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
      turnGoal: "ONLY review the necessary supporting prerequisite for this original author goal: " + turn.goal +
        ". The originating author dialogue is suspended and will be written only AFTER this review passes; " +
        "its current incompleteness is not a failure of the supporting assignment.",
      specialistAssignments: [assignment],
      dependency: { sourceSha: report.sourceSha, commitSha: head,
        obligation: report.obligation, reason: entry.amendment!.reason,
        sources: report.sources.map(s => ({ path: s.path, quote: s.quote })),
        diff: dependencyGit(job, "diff", report.sourceSha, head, "--",
          ...assignment.authority.existingPaths.map(p => prefix + p)) } };
    if (input.fixture) {
      entry.review = { verdict: "pass", findings: [], evidence: ["Deterministic fixture only; no semantic or literary certification."] };
    } else {
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
    },
  });
  const finished = await child.invoke({ identity, submission: null, submissionKey: null,
    outcome: null, continuationRef: null, suspension: null }, config);
  if (finished.outcome?.status !== "verified" || finished.outcome.assignmentKey !== key)
    throw Error("Supporting child did not independently verify the approved prerequisite.");
  return { status: "dependency-verified", reportDigest };
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
}, graphConfig?: RunnableConfig) {
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
    const head = await dependencyBoundary(job);
    const { plan, entry } = await registerReviewDependency(job, request,
      input.validatorSource ?? input.skillsSource);
    if (entry.phase === "verified") return entry.amendment!.assignment;
    if (entry.phase === "reviewing" && entry.commitSha === head)
      return entry.amendment!.assignment;
    if (entry.phase === "reviewing" || entry.phase === "rejected")
      throw Error("Interrupted or rejected review-dependency work requires exact manual reconciliation; never replay model sessions.");
    if (entry.phase !== "reported" && entry.phase !== "planning" && entry.phase !== "authorized")
      throw Error("Review dependency has an unsupported work-plan phase.");
    if (!entry.amendment) {
      if (head !== request.sourceSha)
        throw Error("Review-dependency proposal is stale relative to the reviewed Story HEAD.");
      const { policy } = await inspectPiPolicy(job);
      const proposal = await proposeDependency(job, plan, entry,
        input.provider ?? policy.profile.provider, input.model ?? policy.profile.model);
      try {
        await approveDependency(job, plan, entry, proposal, input.validatorSource ?? input.skillsSource);
      } catch (error) {
        entry.phase = "rejected";
        entry.rejection = { reason: error instanceof Error ? error.message : String(error), proposal };
        await saveDependencyPlan(job, plan);
        throw error;
      }
    }
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
  const invoke = async () => {
    if (entry.phase === "reviewing")
      return { receiptRef: assignment.id, status: "focused-committed", headSha: entry.commitSha };
    const result = await runFocusedWorkItem({
    story: input.story, job: input.job, target: assignment.targets[0]!,
    task: input.task, contract: input.contract, fixture: false,
    skillsSource: input.skillsSource, validatorSource: input.validatorSource,
    provider: input.provider, model: input.model,
    turnPlanDigest: input.turnPlanDigest,
    dependencyAssignmentId: assignment.id,
  });
    if (result.status !== "focused-committed" || !result.headSha)
      throw Error("Supporting specialist did not publish a native-validated, bounded commit.");
    return { receiptRef: assignment.id, status: result.status, headSha: result.headSha };
  };
  const verify = async (result: { headSha?: string }) => withStoryJobLock(job, "review-dependency-independent-review", async () => {
    const head = await dependencyBoundary(job);
    const persisted = await inspectDependencyPlan(job);
    const current = persisted?.entries.find(e => e.reportDigest === entry.reportDigest);
    if (!persisted || !current || !["authorized", "reviewing", "verified"].includes(current.phase) ||
        !current.amendment || head !== result.headSha ||
        current.amendment.sourceSha !== request.sourceSha)
      throw Error("Review-dependency reviewer source or original grant was replaced.");
    if (current.review?.verdict === "pass") return current;
    const paths = [...assignment.authority.existingPaths,
      ...(assignment.authority.newPaths ?? [])].sort();
    const proof = JSON.parse(await readFile(join(job.stateDir, "dependency-items",
      assignment.id + ".json"), "utf8"));
    if (proof.phase !== "committed" || proof.commitSha !== head ||
        proof.expectedHead !== request.sourceSha || proof.jobId !== job.jobId ||
        proof.workItemId !== assignment.id || proof.assignmentDigest !== request.turnDigest ||
        JSON.stringify(proof.paths) !== JSON.stringify(paths) || !proof.validation ||
        proof.validation.status !== "passed")
      throw Error("Review-dependency commit does not match the exact native-validated Character/Arc receipt.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const changed = dependencyGit(job, "diff", "--name-only", request.sourceSha, head);
    if (JSON.stringify(changed.split("\n")) !== JSON.stringify(paths.map(p => prefix + p)) ||
        dependencyGit(job, "rev-parse", head + "^") !== request.sourceSha)
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
    const diff = dependencyGit(job, "diff", request.sourceSha, head, "--",
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
      dependency: { sourceSha: request.sourceSha, commitSha: head,
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
  if (graphConfig) {
    const graphThreadId = graphConfig.configurable?.thread_id;
    if (typeof graphThreadId !== "string")
      throw Error("Review support requires the admitting parent graph Thread.");
    const identity: AssignmentIdentity = {
      schema: "noveltea-assignment-identity/v1", jobId: job.jobId, jobThreadId: job.threadId,
      graphThreadId, turnDigest: request.turnDigest, assignmentId: assignment.id,
      planVersion: entry.amendment.afterVersion, sourceHeadSha: request.sourceSha,
      scopeDigest: dependencyDigest(assignment),
    };
    const key = logicalAssignmentKey(identity);
    const child = createAssignmentLifecycleGraph({
      preflight: async () => {
        const current = (await inspectDependencyPlan(job))?.entries.find(e => e.reportDigest === entry.reportDigest);
        if (!current?.amendment || dependencyDigest(current.amendment.assignment) !== identity.scopeDigest ||
            !["authorized", "reviewing", "verified"].includes(current.phase))
          throw Error("Supporting Review child lost its original grant.");
        return null;
      },
      invoke,
      verify: async state => {
        const reviewed = await verify(state.submission!);
        if (reviewed.review?.verdict !== "pass" || !reviewed.commitSha)
          throw Error("Supporting child lacks independent positive review.");
        return { status: "verified", assignmentKey: key, evidenceRef: reviewed.reportDigest,
          reviewRef: reviewed.reviewerSessionDigest!, headSha: reviewed.commitSha };
      },
    });
    const finished = await child.invoke({ identity, submission: null, submissionKey: null,
      outcome: null, continuationRef: null, suspension: null }, graphConfig);
    if (finished.outcome?.status !== "verified" || finished.outcome.assignmentKey !== key)
      throw Error("Supporting Review child did not verify its authorized prerequisite.");
  } else {
    // Direct adapter certification uses the same writer and verifier; the
    // production parent always supplies its inherited LangGraph config.
    await verify(await invoke());
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
