/** A deterministic prerequisite check before dependent Story writing.
 *
 * Native catalog/route evidence describes what exists. A specialist's prose
 * that another domain is missing is NOT authority to write that domain.
 * The controller separately authenticates this proposal against the pinned
 * Turn, original Event receipt, Git ancestry and protected-decision checks.
 */
import { createHash } from "node:crypto";

const SHA = /^[a-f0-9]{40}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9-]*$/;
const PATH = /^milestones\/[a-z0-9][a-z0-9._-]*\.md$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface CanonicalRecord {
  path: string;
  metadata: { id: string; type: string; status: string; completeness?: string;
    fulfillment?: { any_of?: string[][] }; outcomes?: string[] };
}
export interface CompositionPrerequisiteInput {
  headSha: string;
  milestoneId: string;
  planVersion: number;
  /** Exact signed Event field grant, independently verified by the controller. */
  selectedMilestone: { id: string; path: string };
  event: {
    jobId: string; phase: string; milestoneId: string; workItemId: string; commitSha: string;
    validation: { status: string; milestoneState?: string; eventIds: string[] };
  };
  interactive: {
    jobId: string; milestoneId: string; eventHead: string;
    units: Array<{ phase: string; commitSha?: string;
      validation?: { status: string; choices?: Array<{ id: string; outcomes: Array<{
        name: string; event: string; step: string; branch: string }> }> } }>;
  };
  report: {
    records: CanonicalRecord[];
    coverage: {
      search: { truncated: boolean };
      branchProgress: Array<{ event: string; step: string; branch: string; status: string }>;
      milestoneRoutes: Array<{ id: string; routes: Array<{ status: string }> }>;
    };
  };
}
export interface CloseoutProposal {
  version: 1;
  kind: "unmet-prerequisite";
  owner: "nt-event-design";
  sourceSha: string;
  milestoneId: string;
  sourceEventSha: string;
  choiceCommitSha: string;
  planVersion: number;
  allowedPaths: string[];
  fields: ["completeness", "fulfillment"];
  dependsOn: string[];
  blocks: string[];
  /** Merely a versioned source-bound proposal; not a writer lease. */
  digest: string;
}
export function validCloseoutProposal(proposal: CloseoutProposal): boolean {
  if (!proposal || proposal.version !== 1 || proposal.kind !== "unmet-prerequisite" ||
      proposal.owner !== "nt-event-design" || !SHA.test(proposal.sourceSha) ||
      !SHA.test(proposal.sourceEventSha) || !SHA.test(proposal.choiceCommitSha) ||
      !MILESTONE.test(proposal.milestoneId) ||
      !Number.isSafeInteger(proposal.planVersion) || proposal.planVersion < 1 ||
      !Array.isArray(proposal.allowedPaths) || proposal.allowedPaths.length !== 1 ||
      !PATH.test(proposal.allowedPaths[0]!) ||
      JSON.stringify(proposal.fields) !== JSON.stringify(["completeness", "fulfillment"]) ||
      JSON.stringify(proposal.dependsOn) !== JSON.stringify([
        "interactive:" + proposal.milestoneId ]) ||
      JSON.stringify(proposal.blocks) !== JSON.stringify([
        "composition:" + proposal.milestoneId ]) ||
      !/^[a-f0-9]{64}$/.test(proposal.digest))
    return false;
  const { digest: actual, ...body } = proposal;
  return actual === digest(body);
}
export type CompositionPrerequisiteVerdict =
  | { kind: "ready" }
  | { kind: "refuse"; reason: string }
  | { kind: "repair"; proposal: CloseoutProposal };

/** Fail closed for partial, unproven, stale and corrupt canonical sources.
 * No second dependency DAG is created: the edge connects the already approved
 * interactive and composition work items. */
export function inspectCompositionPrerequisite(
  input: CompositionPrerequisiteInput,
): CompositionPrerequisiteVerdict {
  const refuse = (reason: string): CompositionPrerequisiteVerdict => ({ kind: "refuse", reason });
  const { report, milestoneId, selectedMilestone, event, interactive } = input;
  if (!SHA.test(input.headSha) || !Number.isSafeInteger(input.planVersion) ||
      input.planVersion < 1 || !MILESTONE.test(milestoneId) ||
      selectedMilestone.id !== milestoneId || !PATH.test(selectedMilestone.path) ||
      event.jobId !== interactive.jobId || !event.jobId ||
      event.milestoneId !== milestoneId || event.workItemId !== "event-" + milestoneId.slice(10) ||
      event.phase !== "committed" || !SHA.test(event.commitSha) ||
      interactive.milestoneId !== milestoneId || interactive.eventHead !== event.commitSha ||
      !Array.isArray(interactive.units) || interactive.units.length !== 2 ||
      !Array.isArray(report.records) || !Array.isArray(report.coverage?.branchProgress) ||
      !Array.isArray(report.coverage?.milestoneRoutes) || report.coverage.search?.truncated)
    return refuse("Invalid or stale Event/Choice/Story source evidence; no corrective authority.");
  const record = report.records.find(r => r.metadata.id === milestoneId &&
    r.metadata.type === "milestone" && r.metadata.status !== "superseded");
  if (!record || record.path !== selectedMilestone.path ||
      report.records.some(r => r !== record && r.metadata.id === milestoneId))
    return refuse("Selected Milestone is missing, duplicated, superseded or not the signed Event target.");
  const fulfillment = record.metadata.fulfillment?.any_of;
  if (!Array.isArray(fulfillment) || fulfillment.some(route =>
      !Array.isArray(route) || route.some(id => typeof id !== "string")))
    return refuse("Milestone has no trustworthy native fulfillment contract.");
  const routeEvidence = report.coverage.milestoneRoutes.find(r => r.id === milestoneId)?.routes ?? [];
  if (record.metadata.completeness === "complete" && fulfillment.length > 0 &&
      routeEvidence.some(r => r.status === "reachable") &&
      !routeEvidence.some(r => r.status === "impossible"))
    return { kind: "ready" };
  if (record.metadata.completeness !== "partial" || fulfillment.length !== 0)
    return refuse("Incomplete or contradictory Milestone is not the defined deferred Choice closeout.");
  if (event.validation?.status !== "passed" ||
      event.validation.milestoneState !== "partial-choice-pending" ||
      !Array.isArray(event.validation.eventIds) || !event.validation.eventIds.length ||
      new Set(event.validation.eventIds).size !== event.validation.eventIds.length ||
      event.validation.eventIds.some(id => !/^event\.[a-z][a-z0-9-]*$/.test(id) ||
        !report.records.some(r => r.metadata.id === id && r.metadata.type === "event" &&
          r.metadata.status !== "superseded")) ||
      interactive.units[0]?.phase !== "committed" ||
      !SHA.test(interactive.units[0].commitSha ?? "") ||
      interactive.units[0].validation?.status !== "passed")
    return refuse("No authenticated committed Event setup and completed Choice source for this obligation.");
  const choices = interactive.units[0].validation.choices;
  if (!Array.isArray(choices) || !choices.length || choices.some(c =>
    !c || !/^choice-point\.[a-z][a-z0-9-]*$/.test(c.id) ||
    !Array.isArray(c.outcomes) || c.outcomes.length < 2 ||
    !report.records.some(r => r.metadata.type === "choice-point" &&
      r.metadata.id === c.id && r.metadata.status !== "superseded" &&
      Array.isArray(r.metadata.outcomes) &&
      c.outcomes.every(o => r.metadata.outcomes!.includes(o.name))) ||
    c.outcomes.some(o => !report.records.some(r =>
      r.metadata.type === "event" && r.metadata.id === o.event &&
      r.metadata.status !== "superseded") ||
      !report.coverage.branchProgress.some(b => b.event === o.event && b.step === o.step &&
        b.branch === o.branch && b.status === "reachable"))))
    return refuse("Choice outcomes are missing, unbound or not reachable in native sources.");
  const body = {
    version: 1 as const, kind: "unmet-prerequisite" as const,
    owner: "nt-event-design" as const, sourceSha: input.headSha,
    milestoneId, sourceEventSha: event.commitSha,
    choiceCommitSha: interactive.units[0].commitSha!,
    planVersion: input.planVersion,
    allowedPaths: [selectedMilestone.path],
    fields: ["completeness", "fulfillment"] as ["completeness", "fulfillment"],
    dependsOn: ["interactive:" + milestoneId],
    blocks: ["composition:" + milestoneId],
  };
  return { kind: "repair", proposal: { ...body, digest: digest(body) } };
}
