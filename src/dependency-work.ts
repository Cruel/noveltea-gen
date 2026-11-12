import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startStoryJob } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { runFocusedWorkItem, type FocusedWorkOptions } from "./focused-work.js";
import { dependencyBoundary, dependencyTurn, dependencyDigest, dependencyGit,
  recordDependency, approveDependency, inspectDependencyPlan, saveDependencyPlan } from "./dependency-state.js";
import { proposeDependency } from "./dependency-planner.js";
import { type DependencyReport, type DependencyProposal } from "./dependency-amendments.js";
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
