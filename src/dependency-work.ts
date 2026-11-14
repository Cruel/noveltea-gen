import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startStoryJob } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { runFocusedWorkItem, type FocusedWorkOptions } from "./focused-work.js";
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
export async function advanceFocusedDependency(input: FocusedWorkOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const origin = JSON.parse(await readFile(join(job.stateDir, "focused-items", input.target + ".json"), "utf8")) as {
    jobId: string; workItemId: string; phase: string; dependencyReport?: DependencyReport;
    assignmentDigest?: string; worker: string;
  };
  if (origin.jobId !== job.jobId || origin.workItemId !== "focus:" + input.target ||
      origin.phase !== "waiting-dependency" || !origin.dependencyReport ||
      origin.assignmentDigest !== input.turnPlanDigest || origin.worker !== (input.fixture ? "fixture" : "pi"))
    throw Error("Dependency amendment requires the exact suspended originating assignment.");
  const report = origin.dependencyReport;
  const reportDigest = dependencyDigest(report);
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
    if (entry.phase === "planning" || entry.phase === "reviewing" || entry.phase === "rejected")
      throw Error("Interrupted or rejected dependency planning/review requires explicit reconciliation; no replay.");
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
  const result = await runFocusedWorkItem({ ...input, target: assignment.targets[0]!,
    dependencyAssignmentId: assignment.id });
  if (result.status !== "focused-committed" || !result.headSha)
    throw Error("Dependency specialist did not publish a native-validated bounded commit.");
  await withStoryJobLock(job, "dependency-review", async () => {
    const head = await dependencyBoundary(job);
    saved = await inspectDependencyPlan(job);
    const entry = saved?.entries.find(e => e.reportDigest === reportDigest);
    if (!saved || !entry || entry.phase !== "authorized" || head !== result.headSha)
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
      entry.review = await reviewNarrative(job, proof.snapshot, review, proof.provider, proof.model,
        undefined, async sessionFile => {
          entry.reviewerSession = sessionFile;
          await saveDependencyPlan(job, saved!);
        });
    }
    if (await dependencyBoundary(job) !== head) throw Error("Dependency review changed the Story source.");
    entry.phase = entry.review.verdict === "pass" ? "verified" : "rejected";
    await saveDependencyPlan(job, saved);
    if (entry.phase !== "verified") throw Error("Independent dependency review rejected the prerequisite; preserve work for author reconciliation.");
  });
  return { status: "dependency-verified", reportDigest };
}

/** S14: resume a rejected, *completed* Character Foundations checkpoint with
 * one fresh, owner-typed supporting assignment. The failed review, original
 * Pi writer session and original Turn stay immutable. This shares the normal
 * dependency report/plan version/approval/commit/review machinery. A second,
 * independent read-only review must also verify the suspended original
 * Character Foundations obligation at the new source before the review gate
 * may regard the old failure as covered. */
export async function advanceReviewCharacterDependency(input: {
  story: string; job: string; task: string; contract: FocusedWorkOptions["contract"];
  skillsSource?: string; validatorSource?: string; provider?: string; model?: string;
  turnPlanDigest: string; request: ReviewDependencyRequest;
}) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const request = input.request;
  const eventSource = request.originalWorkItem.startsWith("event-");
  if (request.classification !== "new-full-story-record" ||
      request.action !== "controller-amendment-required" ||
      request.turnDigest !== input.turnPlanDigest)
    throw Error("Review-dependency execution requires an unchanged full-Story Character obligation.");
  const assignment = await withStoryJobLock(job, "review-dependency-authorization", async () => {
    const head = await dependencyBoundary(job);
    const { plan, entry } = await registerReviewDependency(job, request,
      input.validatorSource ?? input.skillsSource);
    if (entry.phase === "verified") return entry.amendment!.assignment;
    if (entry.phase === "reviewing" && eventSource &&
        entry.review?.verdict === "pass" && entry.commitSha === head)
      return entry.amendment!.assignment;
    if (entry.phase === "planning" || entry.phase === "reviewing" || entry.phase === "rejected")
      throw Error("Interrupted or rejected review-dependency work requires exact manual reconciliation; never replay model sessions.");
    if (entry.phase !== "reported" && entry.phase !== "authorized")
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
  if (entry.phase === "reviewing" && eventSource && entry.review?.verdict === "pass")
    return { status: "dependency-support-verified" as const, sourceSha: request.sourceSha };
  if (entry.phase !== "authorized")
    throw Error("Review-dependency authoring is not in an approved phase.");
  const result = await runFocusedWorkItem({
    story: input.story, job: input.job, target: assignment.targets[0]!,
    task: input.task, contract: input.contract, fixture: false,
    skillsSource: input.skillsSource, validatorSource: input.validatorSource,
    provider: input.provider, model: input.model,
    turnPlanDigest: input.turnPlanDigest,
    dependencyAssignmentId: assignment.id,
  });
  if (result.status !== "focused-committed" || !result.headSha)
    throw Error("Supporting Character writer did not publish a native-validated, bounded commit.");

  await withStoryJobLock(job, "review-dependency-independent-rereview", async () => {
    const head = await dependencyBoundary(job);
    const persisted = await inspectDependencyPlan(job);
    const current = persisted?.entries.find(e => e.reportDigest === entry.reportDigest);
    if (!persisted || !current || current.phase !== "authorized" ||
        !current.amendment || head !== result.headSha ||
        current.amendment.sourceSha !== request.sourceSha)
      throw Error("Review-dependency reviewer source or original grant was replaced.");
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
    const snapshot = await createSkillSnapshot({ ...config,
      requiredSkills: ["nt-narrative-review", "nt-catalog"] });
    if (!snapshot) throw Error("Supporting dependency lacks a pinned independent reviewer.");
    if (await openSkillSnapshot(snapshot.id) !== snapshot.path)
      throw Error("Independent review snapshot is not immutable.");
    current.commitSha = head;
    current.phase = "reviewing";
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
      turnGoal: eventSource
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
    current.review = await reviewNarrative(reviewJob, snapshot, support, provider, model,
      undefined, async file => {
        current.reviewerSession = file;
        await saveDependencyPlan(job, persisted);
      });
    if (await dependencyBoundary(job) !== head)
      throw Error("Independent supporting review changed the Story HEAD.");
    if (current.review.verdict !== "pass") {
      current.phase = "rejected";
      await saveDependencyPlan(job, persisted);
      throw Error("Independent review rejected the new Character or Arc link; preserve original failure and model session.");
    }
    if (eventSource) {
      // The Character work is independently reviewed, but the Event stays
      // negative until a distinct Event-owned participant/prose correction
      // passes its existing source-linked specialist-repair review gate.
      await saveDependencyPlan(job, persisted);
      return;
    }
    const reassess: ReviewAssignment = {
      ...base, paths: [...new Set([...originalPoint.assurance.changedPaths, ...paths])].sort(),
      specialistAssignments: [original, assignment],
      turnGoal: "Reassess ONLY the ORIGINAL independently failed Character Foundations " +
        "assignment of the saved whole-Story Turn at the NEW Story HEAD. Verify the " +
        "central missing inspector now has an appropriate Character profile and an exact " +
        "Arc Character link, and all original Character/World continuity, motivations " +
        "and honest knowledge remain intact. The previously negative review stays sealed; " +
        "this is an independent successor judgment, not a rewrite. Downstream Events, " +
        "interactive Choices and final prose have not yet been assigned.",
      reassessment: { assignmentId: original.id, failedSourceSha: request.sourceSha,
        correctedHeadSha: head },
    };
    current.originalReview = await reviewNarrative(reviewJob, snapshot, reassess, provider, model,
      undefined, async file => {
        current.originalReviewerSession = file;
        await saveDependencyPlan(job, persisted);
      });
    if (await dependencyBoundary(job) !== head)
      throw Error("Independent original-goal rereview changed the Story HEAD.");
    current.phase = current.originalReview.verdict === "pass" ? "verified" : "rejected";
    await saveDependencyPlan(job, persisted);
    if (current.phase !== "verified")
      throw Error("Suspended Character Foundations obligation still failed independent rereview; preserve original negative checkpoint.");
  });
  return { status: eventSource ? "dependency-support-verified" as const :
    "dependency-verified" as const, sourceSha: request.sourceSha };
}
