import { declaredCanonicalReferences, type CanonicalScopeRecord } from "./focused-scope.js";
import { focusedSpecialist } from "./focused-specialist.js";
import type { TurnAssignmentEvidence, TurnEvidence } from "./turn-plan-evidence.js";
import { createHash } from "node:crypto";
import type { ReviewDependencyRequest } from "./review-repair-amendment.js";

export interface DependencySource { path: string; sha256: string; quote: string }
export interface DependencyReport {
  sourceSha: string; turnDigest: string; assignmentId: string;
  obligation: string; missing: string; affectedIds: string[];
  sources: DependencySource[]; likelySpecialist: string; authorDecisionRequired: boolean;
}
export interface DependencyProposal {
  sourceSha: string; reportDigest: string; target: string; specialist: string;
  outcome: string; reason: string;
}
/** A Character creation proposal is merely a name and rationale. It cannot
 * supply a file path or edit authorization; the controller derives those. */
export interface ReviewCharacterProposal extends DependencyProposal {
  title: string;
  /** A planner may select a canonical Arc ID from authenticated candidates. */
  arcIds?: string[];
}
export interface DependencyAmendment {
  beforeVersion: number; afterVersion: number; sourceSha: string; turnDigest: string;
  reportDigest: string; reason: string; objective: TurnEvidence["objective"];
  resumes: string; assignment: TurnAssignmentEvidence;
}
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const sourceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = (v: unknown, expected: string) => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === expected.split(",").sort().join(",");
const id = /^[a-z][a-z-]*\.[a-z][a-z0-9-]*$/;
const path = /^[a-z][a-z-]*\/[a-z][a-z0-9-]*\.md$/;
export function parseDependencyReport(value: unknown): DependencyReport {
  const r = value as DependencyReport;
  if (!keys(r, "sourceSha,turnDigest,assignmentId,obligation,missing,affectedIds,sources,likelySpecialist,authorDecisionRequired") ||
      !/^[a-f0-9]{40}$/.test(r.sourceSha) || !/^[a-f0-9]{64}$/.test(r.turnDigest) ||
      !text(r.assignmentId, 200) || !text(r.obligation) || !text(r.missing) ||
      !text(r.likelySpecialist, 80) || typeof r.authorDecisionRequired !== "boolean" ||
      !Array.isArray(r.affectedIds) || !r.affectedIds.length || r.affectedIds.length > 12 ||
      r.affectedIds.some(v => typeof v !== "string" || !id.test(v)) ||
      new Set(r.affectedIds).size !== r.affectedIds.length ||
      !Array.isArray(r.sources) || !r.sources.length || r.sources.length > 8 ||
      r.sources.some(s => !keys(s, "path,sha256,quote") || !path.test(s.path) ||
        !/^[a-f0-9]{64}$/.test(s.sha256) || !text(s.quote)))
    throw Error("Malformed dependency evidence report.");
  return structuredClone(r);
}
// Only typed canonical link fields establish connection; free prose and titles
// mentioning an ID cannot turn an unrelated enhancement into a prerequisite.
function links(record: CanonicalScopeRecord, target: string): boolean {
  return declaredCanonicalReferences(record).has(target);
}

/** A review-discovered gap in a whole Story can warrant one *new*
 * Character and one field-limited Arc link. This reuses DependencyAmendment
 * and the same typed owner/path grants as focused prerequisite work. Neither
 * reviewer text nor a planner-proposed ID/path is trusted as authority.
 *
 * The caller must independently attest the saved request against its sealed
 * review and reconstruct these catalog records using native validation at HEAD.
 * This pure gate checks every original Turn/owner/scope and exact proposal;
 * Git and field-level diff auditing remain mandatory at dispatch. */
/** The exact proposed grant failed a deterministic authority check.
 * Distinct from failures reconstructing the original source or receipt. */
export class DependencyAuthorizationRefusedError extends Error {}

export function authorizeReviewCharacterDependency(input: {
  plan: TurnEvidence; head: string; request: ReviewDependencyRequest;
  proposal: ReviewCharacterProposal; reportDigest: string;
  records: CanonicalScopeRecord[]; version: number;
  priorAmendments?: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const { plan, head, request, proposal, records } = input;
  const owner = plan.assignments.find(a => a.id === request.originalAssignmentId);
  const foundation = request.originalWorkItem === "character-foundations";
  const event = /^event-[a-z][a-z0-9-]*$/.test(request.originalWorkItem);
  const citedArcs = request.findings.filter(f => /^arcs\/[a-z][a-z0-9-]*\.md$/.test(f.path));
  const [cited] = request.findings;
  const supportingRecord = records.find(r => r.path === cited?.path);
  const arc = foundation ? supportingRecord : undefined;
  const proposedPath = typeof proposal?.target === "string" &&
    /^character\.[a-z][a-z0-9-]*$/.test(proposal.target)
    ? "characters/" + proposal.target.slice("character.".length) + ".md" : "";
  const priorOwners = [...plan.assignments.filter(a => a.id !== owner?.id),
    ...(input.priorAmendments ?? [])];
  if (request.kind !== "review-dependency" ||
      request.classification !== "new-full-story-record" ||
      request.action !== "controller-amendment-required" ||
      plan.kind !== "full-story" || plan.objective?.breadth !== "whole-story" ||
      !owner || !(foundation
        ? owner.specialist === "nt-worldbuilding + nt-character-development" &&
          owner.authority.mayCreate && owner.authority.recordTypes.includes("character")
        : event && owner.id === "event" && owner.specialist === "nt-event-design" &&
          owner.authority.recordTypes.includes("event") &&
          plan.assignments.some(a => a.specialist === "nt-worldbuilding + nt-character-development" &&
            a.authority.recordTypes.includes("character") && a.authority.mayCreate)) ||
      request.sourceSha !== head || plan.digest !== request.turnDigest ||
      sourceHash(plan.objective) !== request.objectiveDigest ||
      sourceHash(plan.contract.scope) !== request.scopeDigest ||
      sourceHash(plan.assignments) !== request.ownersDigest ||
      sourceHash(owner) !== request.originalAssignmentDigest ||
      !text(proposal.title, 120) || /[\r\n]/.test(proposal.title) ||
      !keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason,title") ||
      !text(proposal.reason) || !text(proposal.outcome) ||
      proposal.sourceSha !== head || proposal.reportDigest !== input.reportDigest ||
      !/^[a-f0-9]{64}$/.test(input.reportDigest) ||
      proposal.specialist !== "nt-character-development" ||
      !proposedPath || !cited || request.findings.length !== 1 ||
      proposal.outcome !== cited.requiredCorrection ||
      !supportingRecord || supportingRecord.metadata.status === "superseded" ||
      !(foundation
        ? citedArcs.length === 1 && arc?.metadata.type === "arc" &&
          /^arc\.[a-z][a-z0-9-]*$/.test(arc.metadata.id) &&
          Array.isArray(arc.metadata.characters) &&
          arc.metadata.characters.every(id => typeof id === "string" &&
            /^character\.[a-z][a-z0-9-]*$/.test(id))
        : event && /^events\/[a-z][a-z0-9-]*\.md$/.test(cited.path) &&
          supportingRecord.metadata.type === "event" &&
          /^event\.[a-z][a-z0-9-]*$/.test(supportingRecord.metadata.id) &&
          Array.isArray(supportingRecord.metadata.participants) &&
          supportingRecord.metadata.participants.every(id => typeof id === "string" &&
            /^character\.[a-z][a-z0-9-]*$/.test(id)) &&
          new Set(supportingRecord.metadata.participants).size ===
            supportingRecord.metadata.participants.length &&
          cited.affectedPaths.length === 1 && cited.affectedPaths[0] === cited.path) ||
      records.some(r => r.path === proposedPath || r.metadata.id === proposal.target) ||
      priorOwners.some(a => a.authority.existingPaths.includes(proposedPath) ||
        a.authority.newPaths?.includes(proposedPath) ||
        (foundation && a.authority.existingPaths.includes(arc!.path)) ||
        a.targets.includes(proposal.target)) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8)
    throw new DependencyAuthorizationRefusedError("Review dependency lacks exact approved full-Story creation, Arc source, owner or plan authorization.");
  // A Character prerequisite discovered in an Event review needs two
  // distinct writers: the Character specialist creates exactly one record;
  // the original Event specialist subsequently corrects only the cited
  // Event's participant list and canonical prose. No Event path is granted
  // to the supporting Character writer. Foundations retain the Arc-link lease.
  return {
    beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: head, turnDigest: plan.digest, reportDigest: input.reportDigest,
    reason: proposal.reason, objective: structuredClone(plan.objective),
    resumes: owner.id,
    assignment: {
      id: "dependency:" + input.version + ":" + proposal.target,
      specialist: "nt-character-development", outcome: proposal.outcome,
      targets: [proposal.target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: {
        recordTypes: foundation ? ["arc", "character"] : ["character"],
        existingPaths: foundation ? [arc!.path] : [],
        newPaths: [proposedPath], mayCreate: true,
      },
    },
  };
}

/** Pure authorization policy. Inputs named records/sources are controller-read
 * canonical evidence at HEAD, never the model's own catalog or permission list.
 * Only existing, typed, directly connected records can be amended here. */
/** A sealed no-write report may need a different existing owner. The exact
 * path comes from the original Turn leases, native catalog and authenticated
 * finding. Planner output never grants new paths or writes to protected canon. */
export function authorizeReviewOtherOwnerDependency(input: {
  plan: TurnEvidence; head: string; request: ReviewDependencyRequest;
  proposal: DependencyProposal; reportDigest: string;
  records: CanonicalScopeRecord[]; version: number;
  priorAmendments?: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const { plan, head, request, proposal, records } = input;
  const owner = plan.assignments.find(a => a.id === request.originalAssignmentId);
  const otherPath = request.otherOwnerPath;
  const source = records.find(r => r.path === request.findings[0]?.path);
  const target = records.find(r => r.path === otherPath);
  const otherOwners = plan.assignments.filter(a => a.id !== owner?.id && !!otherPath &&
    (a.authority.existingPaths.includes(otherPath) || a.authority.newPaths?.includes(otherPath)));
  const other = otherOwners[0];
  const connected = !!source && !!target && (
    declaredCanonicalReferences(source).has(target.metadata.id) ||
    declaredCanonicalReferences(target).has(source.metadata.id));
  if (request.kind !== "review-dependency" || request.classification !== "other-owner" ||
      request.action !== "controller-amendment-required" ||
      !owner || !other || otherOwners.length !== 1 || !otherPath ||
      !path.test(otherPath) || !target || !source || !connected ||
      request.findings.length !== 1 ||
      !request.findings[0]!.affectedPaths.includes(otherPath) ||
      source.metadata.status === "superseded" || target.metadata.status === "superseded" ||
      !other.authority.recordTypes.includes(target.metadata.type) ||
      !other.authority.existingPaths.includes(otherPath) ||
      target.metadata.id !== proposal.target ||
      target.metadata.type !== proposal.target.split(".")[0] ||
      !text(proposal.reason) || !text(proposal.outcome) ||
      !keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason") ||
      proposal.sourceSha !== head || proposal.reportDigest !== input.reportDigest ||
      proposal.outcome !== request.findings[0]!.requiredCorrection ||
      proposal.specialist !== focusedSpecialist(proposal.target) ||
      proposal.specialist === owner.specialist ||
      /^(?:arcs|milestones|narrative-positions|creative-direction)\//.test(otherPath) ||
      target.metadata.decisions !== undefined &&
        (!Array.isArray(target.metadata.decisions) || target.metadata.decisions.length > 0) ||
      (input.priorAmendments ?? []).some(a => a.authority.existingPaths.includes(otherPath) ||
        a.authority.newPaths?.includes(otherPath)) ||
      request.sourceSha !== head || request.turnDigest !== plan.digest ||
      sourceHash(plan.objective) !== request.objectiveDigest ||
      sourceHash(plan.contract.scope) !== request.scopeDigest ||
      sourceHash(plan.assignments) !== request.ownersDigest ||
      sourceHash(owner) !== request.originalAssignmentDigest ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8)
    throw new DependencyAuthorizationRefusedError("Cross-specialist prerequisite is not a proven in-scope, single-owner existing canonical correction.");
  return {
    beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: head, turnDigest: plan.digest, reportDigest: input.reportDigest,
    reason: proposal.reason, objective: structuredClone(plan.objective),
    resumes: owner.id,
    assignment: { id: "dependency:" + input.version + ":" + target.metadata.id,
      specialist: proposal.specialist, outcome: proposal.outcome,
      targets: [target.metadata.id], dependsOn: [],
      discovery: "canonical-story-read-only",
      authority: { recordTypes: [target.metadata.type], existingPaths: [otherPath], mayCreate: false },
    },
  };
}

export function authorizeDependency(input: {
  plan: TurnEvidence; head: string; report: DependencyReport; reportDigest: string;
  proposal: DependencyProposal; records: CanonicalScopeRecord[];
  sources: DependencySource[]; version: number;
  /** Controller-verified grants from earlier amendments in the same Turn. */
  priorAmendments?: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const { plan, head, proposal, records } = input;
  const report = parseDependencyReport(input.report);
  const parent = input.priorAmendments?.find(a => a.id === report.assignmentId);
  if (!keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason") ||
      proposal.sourceSha !== head || report.sourceSha !== head ||
      report.turnDigest !== plan.digest || proposal.reportDigest !== input.reportDigest ||
      !/^[a-f0-9]{64}$/.test(input.reportDigest) || !text(proposal.reason) ||
      !text(proposal.outcome) || proposal.outcome !== report.missing ||
      !plan.objective || !plan.objective.obligations.includes(report.obligation) ||
      (plan.kind !== "revision" && !parent) || report.authorDecisionRequired ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8 ||
      JSON.stringify(report.sources) !== JSON.stringify(input.sources))
    throw new DependencyAuthorizationRefusedError("Dependency amendment has stale evidence, changed obligations or requires author approval.");
  const origin = parent ?? plan.assignments.find(a => a.id === report.assignmentId);
  const record = records.find(r => r.metadata.id === proposal.target);
  // Write authority is path-based: supportingTargets may be in existingPaths
  // without appearing in targets. Check every existing writer, including
  // earlier dependency amendments, before approving a second writer.
  const priorOwners = [...plan.assignments, ...(input.priorAmendments ?? [])];
  const originRecords = records.filter(r => origin?.targets.includes(r.metadata.id) ||
    parent?.authority.existingPaths.includes(r.path));
  if (!origin || !record || record.metadata.status === "superseded" ||
      record.metadata.type !== proposal.target.split(".")[0] || !path.test(record.path) ||
      origin.targets.includes(proposal.target) || priorOwners.some(a =>
        a.targets.includes(proposal.target) || a.authority.existingPaths.includes(record.path) ||
        a.authority.newPaths?.includes(record.path)) ||
      report.affectedIds.some(id => !records.some(r => r.metadata.id === id && r.metadata.status !== "superseded") &&
        !parent?.targets.includes(id)) ||
      !report.affectedIds.includes(proposal.target) || !origin.targets.some(id => report.affectedIds.includes(id)) ||
      !report.sources.some(s => s.path === record.path) ||
      report.sources.some(s => !records.some(r => r.path === s.path && report.affectedIds.includes(r.metadata.id))) ||
      !originRecords.some(r => links(r, proposal.target) || links(record, r.metadata.id)))
    throw new DependencyAuthorizationRefusedError("Unknown, speculative, already assigned or unrelated dependency record.");
  if (proposal.specialist !== focusedSpecialist(proposal.target) ||
      report.likelySpecialist !== proposal.specialist || proposal.specialist === origin.specialist)
    throw new DependencyAuthorizationRefusedError("Dependency amendment must use the proper cross-domain specialist.");
  if (records.some(r => report.affectedIds.includes(r.metadata.id) &&
      r.metadata.decisions !== undefined &&
      (!Array.isArray(r.metadata.decisions) || r.metadata.decisions.length > 0)))
    throw new DependencyAuthorizationRefusedError("Dependency affects decisions requiring explicit protected-authority review.");
  return { beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: head, turnDigest: plan.digest, reportDigest: input.reportDigest,
    reason: proposal.reason, objective: structuredClone(plan.objective), resumes: origin.id,
    assignment: { id: "dependency:" + input.version + ":" + proposal.target,
      specialist: focusedSpecialist(proposal.target), outcome: proposal.outcome,
      targets: [proposal.target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: { recordTypes: [record.metadata.type], existingPaths: [record.path], mayCreate: false } } };
}

/** Only the previously reviewed, unrealized Character may be created. The
 * shared focused writer audits the one appended Arc Character reference. */
/** Resolve an explicit proposal against the native, authenticated candidate
 * set. Omitted selection is legal only at a uniquely determined boundary. */
export function selectBlueprintArcSources(source: import("./dependency-state.js").BlueprintDependencySource,
  proposal: ReviewCharacterProposal) {
  const ids = proposal.arcIds ?? (source.arcCandidates.length === 1 ? [source.arcCandidates[0]!.id] : []);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some(id => !source.arcCandidates.some(a => a.id === id)))
    throw new DependencyAuthorizationRefusedError("Dependency proposal must identify necessary canonical Arc candidates.");
  return source.arcCandidates.filter(a => ids.includes(a.id)).sort((a, b) => a.path.localeCompare(b.path));
}

export function authorizeBlueprintCharacterDependency(input: {
  plan: TurnEvidence; head: string; report: DependencyReport; reportDigest: string;
  proposal: ReviewCharacterProposal; records: CanonicalScopeRecord[]; sources: DependencySource[];
  version: number; source: import("./dependency-state.js").BlueprintDependencySource;
  priorAmendments: TurnAssignmentEvidence[];
}): DependencyAmendment {
  const {plan, head, report, proposal, records, source} = input;
  const target = source.target;
  const existing = source.readiness === "outside-event-authority";
  const targetRecord = records.find(r => r.metadata.id === target);
  const newPath = "characters/" + target.slice(10) + ".md";
  const selected = selectBlueprintArcSources(source, proposal);
  const arcs = selected.map(candidate => records.find(r => r.path === candidate.path &&
    r.metadata.id === candidate.id && r.metadata.type === "arc" && r.metadata.status !== "superseded"));
  const milestone = records.find(r => r.metadata.id === source.milestoneId && r.metadata.type === "milestone" && r.metadata.status !== "superseded");
  const event = plan.assignments.find(a => a.id === "event" && a.specialist === "nt-event-design" && a.authority.recordTypes.includes("event"));
  const character = plan.assignments.find(a => a.specialist === "nt-worldbuilding + nt-character-development" && a.authority.mayCreate && a.authority.recordTypes.includes("character"));
  const architecture = plan.assignments.find(a => a.specialist === "nt-story-architecture" && a.authority.recordTypes.includes("arc"));
  if (plan.kind !== "full-story" || plan.objective?.breadth !== "whole-story" || !event || !character || !architecture ||
      !milestone || arcs.some(arc => !arc || !Array.isArray(milestone.metadata.arcs) ||
        !milestone.metadata.arcs.includes(arc.metadata.id) || !Array.isArray(arc.metadata.characters) ||
        arc.metadata.characters.includes(target) ||
        (arc.metadata.decisions !== undefined && (!Array.isArray(arc.metadata.decisions) ||
          arc.metadata.decisions.some(d => !d || d.origin !== "agent" || d.authority !== "delegated")))) ||
      !/^character\.[a-z][a-z0-9-]*$/.test(target) ||
      (existing ? !targetRecord || targetRecord.metadata.type !== "character" ||
        targetRecord.metadata.status === "superseded" || targetRecord.path !== source.targetPath
        : !!targetRecord || records.some(r => r.path === newPath)) ||
      report.assignmentId !== event.id || report.sourceSha !== head || report.turnDigest !== plan.digest ||
      !plan.objective.obligations.includes(report.obligation) || report.authorDecisionRequired ||
      report.likelySpecialist !== "nt-character-development" ||
      JSON.stringify(report.sources) !== JSON.stringify(input.sources) ||
      !keys(proposal, "sourceSha,reportDigest,target,specialist,outcome,reason,title" + (proposal.arcIds === undefined ? "" : ",arcIds")) ||
      proposal.sourceSha !== head || proposal.reportDigest !== input.reportDigest || proposal.target !== target ||
      proposal.specialist !== report.likelySpecialist || proposal.outcome !== report.missing ||
      !text(proposal.reason) || !text(proposal.title, 120) || /[\r\n]/.test(proposal.title) ||
      !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 8 ||
      (!existing && [...plan.assignments, ...input.priorAmendments].some(a => a.targets.includes(target) ||
        a.authority.existingPaths.includes(newPath) || a.authority.newPaths?.includes(newPath))))
    throw new DependencyAuthorizationRefusedError("Blueprint predecessor lacks exact whole-Story ownership, safe delegated Arc link or Character authority.");
  return { beforeVersion: input.version, afterVersion: input.version + 1, sourceSha: head,
    turnDigest: plan.digest, reportDigest: input.reportDigest, reason: proposal.reason,
    objective: structuredClone(plan.objective), resumes: event.id,
    assignment: { id: "dependency:" + input.version + ":" + target, specialist: proposal.specialist,
      outcome: proposal.outcome, targets: [target], dependsOn: [], discovery: "canonical-story-read-only",
      authority: { recordTypes: existing ? ["arc"] : ["arc", "character"],
        existingPaths: selected.map(a => a.path),
        ...(existing ? {} : { newPaths: [newPath] }), mayCreate: !existing } } };
}
