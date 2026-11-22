/** Postcommit repair admission in the existing Interactive preflight, under its
 * writer lease. Only the private planning owner runs; the Event never reruns. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { PiBudgetPause, inspectPiPolicy } from "./job-pi-policy.js";
import { trustedHead } from "./revision.js";
import { selectedAssignment } from "./event-work.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readIndependentReview } from "./checkpoint-assurance.js";
import { historicalMilestoneHandoff, reviewedMilestoneHandoff, type MilestoneEventSource } from "./milestone-obligation-handoff.js";
import { readEventOnlyOmission, type EventOnlyRef } from "./interactive-event-only.js";
import { archiveReviewedMilestoneBlueprint, ensureMilestoneBlueprint, milestoneBlueprintApprovalProvenance, originalBlueprintReviewDigest, readReviewedMilestoneBlueprint, parseMilestoneBlueprint, type MilestoneBlueprint } from "./milestone-blueprint.js";
import { classifyApprovalRevisionCause, approvalRevisionSeverity, inspectRepairLedger, recordBlueprintRepair, type BlueprintRepair } from "./repair-ledger.js";
import { execFileSync } from "./git-read-cache.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A reviewer of a valid Event can flag a defect in the private plan, not
 * grant an Event rewrite. The controller checks both exact source values. */
export interface BlueprintChallenge {
  pinDigest: string; field: string; before: unknown; proposed: unknown; sourceQuote: string;
}
function proposedField(design: MilestoneBlueprint, c: BlueprintChallenge) {
  const match = /^(events|downstream)\/(0|[1-9]\d?)\/(purpose|dependsOn|evidence|participants|knowledge|routes|owner|obligation)$/.exec(c.field);
  if (!match) throw Error("Invalid material Blueprint field selector.");
  const result = structuredClone(design);
  const entry = result[match[1] as "events" | "downstream"][Number(match[2])] as unknown as Record<string, unknown> | undefined;
  if (!entry || !Object.hasOwn(entry, match[3]!) || !equal(entry[match[3]!], c.before)) throw Error("Blueprint finding does not match the original material field.");
  entry[match[3]!] = c.proposed;
  return result;
}
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" });
}
export async function correctPendingBlueprint(job: JobStartResult, plan: Plan,
  event: MilestoneEventSource & { snapshot?: SkillSnapshot; worker?: string; provider?: string; model?: string; planDigest?: string },
  input: { head: string; fixture: boolean; omission: EventOnlyRef | null; protectionBase?: string; objective?: string; turnDigest?: string; native: Parameters<typeof selectedAssignment>[2] }) {
  const old = await historicalMilestoneHandoff(job, event);
  if (!old || !event.assignment || !event.snapshot) return;
  const ownerConflict = !!input.omission && old.design.downstream.some(item => item.owner === "interactive");
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === event.commitSha && p.eligible &&
    p.workItem === "event-" + event.milestoneId.slice(10));
  const review = point?.assurance && await readIndependentReview(job, point.assurance);
  const evidence = review?.result?.evidence;
  const entries = evidence?.includes('"blueprintChallenge"') && evidence.startsWith("{") ? JSON.parse(evidence).evidence : [];
  const findings = Array.isArray(entries) ? entries.filter(e => e.blueprintChallenge !== undefined) : [];
  if (!ownerConflict && !findings.length) return;
  if (!existsSync(join(job.stateDir, "turn-plan.json")))
    throw Error("Post-approval Blueprint challenge lacks the authenticated Turn plan.");
  const head = input.head;
  const clean = async () => {
    if (await trustedHead(job) !== head || git(job, "rev-parse", "HEAD").trim() !== head || git(job, "status", "--porcelain").trim())
      throw Error("Blueprint correction lost its clean verified HEAD.");
  };
  await clean();
  const turn = await readTurnEvidence(job, plan.contract);
  const owner = turn?.assignments.find(a => a.id === "event");
  if (!turn || input.objective !== turn.originalRequest || input.turnDigest && input.turnDigest !== turn.digest ||
      !input.fixture && input.turnDigest !== turn.digest || !point || review?.status !== "passed" || point.planVersion !== plan.version || point.assurance?.assignmentId !== "event" || point.assurance.turnDigest !== turn.digest ||
      event.expectedHead !== old.pin.sourceSha || owner?.specialist !== "nt-event-design" || !owner.authority.recordTypes.includes("event") ||
      owner.targets.some(id => id.startsWith("milestone.")) && !owner.targets.includes(event.milestoneId) ||
      plan.contract.scope.kind === "partial" && !plan.contract.scope.targets.includes(event.milestoneId) ||
      !turn.assignments.some(a => a.id === "interactive") || JSON.stringify(plan.contract) !== JSON.stringify(event.assignment.contract) ||
      !["full-story", "partial"].includes(plan.contract.scope.kind) || input.protectionBase !== head || event.planDigest !== sha(plan) ||
      existsSync(join(job.stateDir, "composition-items", event.milestoneId.slice(10) + ".json")) ||
      event.worker !== (input.fixture ? "fixture" : "pi") || !event.provider || !event.model ||
      await openSkillSnapshot(event.snapshot.id) !== event.snapshot.path)
    throw Error("No current reviewed Event, protected Turn scope or planning owner for Blueprint correction.");
  const currentScope = selectedAssignment(job, plan, input.native, event.milestoneId, point.workItem);
  if (currentScope.milestonePath !== event.assignment.milestonePath || currentScope.workItemId !== event.assignment.workItemId ||
      !equal(currentScope.authority, event.assignment.authority) || !equal(currentScope.arcIds, event.assignment.arcIds) ||
      !equal(currentScope.characterIds, event.assignment.characterIds) || event.assignment.sourcePaths.some(path => !currentScope.sourcePaths.includes(path)))
    throw Error("Blueprint planning scope differs from the current canonical Milestone assignment.");
  await readReviewedMilestoneBlueprint(job, old.pin, event.assignment, { provider: input.fixture ? "fixture" : event.provider,
    model: input.fixture ? "fixture" : event.model, planDigest: sha(plan), contractDigest: sha(plan.contract), snapshotId: event.snapshot.id });
  git(job, "merge-base", "--is-ancestor", old.eventHead, head);
  let candidate = structuredClone(old.design);
  const sources = new Set<string>();
  if (findings.length > 1) throw Error("Multiple material challenges need a separately bounded assignment.");
  for (const e of findings) {
    const c = e.blueprintChallenge as BlueprintChallenge;
    if (!c || c.pinDigest !== old.pin.digest || e.commitSha !== old.eventHead || e.assignmentId !== "event" ||
        !point.assurance.changedPaths.includes(e.path) || !Number.isSafeInteger(e.line) || e.line < 1 ||
        typeof c.sourceQuote !== "string" || c.sourceQuote.trim().length < 8 || c.sourceQuote.length > 1000)
      throw Error("Blueprint challenge is not bound to the reviewed Event source.");
    const path = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + e.path;
    const source = git(job, "show", old.eventHead + ":" + path);
    if (source.split(/\r?\n/)[e.line - 1]?.trim() !== c.sourceQuote || git(job, "show", head + ":" + path) !== source)
      throw Error("Blueprint challenge canonical quote changed or was not in its reviewed source.");
    candidate = proposedField(candidate, c);
    sources.add(e.path);
  }
  if (input.omission) {
    const proof = await readEventOnlyOmission(job, event.milestoneId, input.omission, {
      eventHead: old.eventHead, eventSnapshotId: event.snapshot.id, planDigest: sha(plan), validatorVersion: job.validatorVersion });
    if (proof.reviewHead !== head || proof.turnDigest !== turn.digest || proof.reviewMode !== event.worker ||
        JSON.stringify(proof.eventIds) !== JSON.stringify(old.eventIds) || old.milestoneState !== "complete")
      throw Error("Event-only contradiction lacks an exact independently reviewed source.");
    if (ownerConflict) candidate.downstream = candidate.downstream.filter(item => item.owner !== "interactive");
    for (const path of Object.keys(proof.sourceHashes).filter(p => p.startsWith("events/"))) sources.add(path);
  }
  const protectedPaths = input.native.records.filter(r => r.metadata.type === "creative-direction" || r.metadata.decisions?.length).map(r => r.path);
  if (protectedPaths.includes(event.assignment.milestonePath) || [...sources].some(path => protectedPaths.includes(path)))
    throw Error("Protected Blueprint correction evidence requires separate author approval.");
  if (input.omission && candidate.downstream.some(item => item.owner === "interactive"))
    throw Error("Proposed Blueprint field contradicts the reviewed Event-only disposition.");
  parseMilestoneBlueprint(JSON.stringify(candidate), event.assignment);
  // Different JSON key ordering (or an identical suggestion) changes no
  // obligation. Deterministically retain the original approval, no Pi turn.
  if (equal(candidate, old.design)) return;
  const evidenceDigest = sha([input.omission, findings, sha(candidate)]);
  // Both paths have already authenticated the immutable Event and independent
  // review above. A later Event-only omission is a newly discovered constraint;
  // a reviewer claim with no PREapproval contradiction proof stays unclassified.
  const cause = classifyApprovalRevisionCause({
    kind: input.omission && !findings.length ? "later-constraint" : "unknown",
    originalSourceSha: old.pin.sourceSha, verifiedSourceSha: head,
  });
  const grant: BlueprintRepair = { owner: "nt-event-design", original: old.pin, eventHead: old.eventHead,
    originalReviewDigest: await originalBlueprintReviewDigest(job, old.pin),
    sourceSha: head, planDigest: sha(plan), evidenceDigest,
    incident: { id: sha({ jobId: job.jobId, threadId: job.threadId, turnDigest: turn.digest,
        original: old.pin, evidenceDigest }), cause, severity: approvalRevisionSeverity(cause),
      trigger: { kind: findings.length ? input.omission ? "combined" : "independent-event-review" : "event-only",
        fields: [...(ownerConflict ? ["downstream/interactive"] : []),
          ...findings.map(f => (f.blueprintChallenge as BlueprintChallenge).field)].sort(),
        sourcePaths: [...sources].sort(), reviewDigest: findings.length ? sha(review?.result) : null },
      affectedWork: ["interactive:" + event.milestoneId, "composition:" + event.milestoneId],
      originalApproval: await milestoneBlueprintApprovalProvenance(job, old.pin, event.assignment) } };
  const prior = (await inspectRepairLedger(job, turn.digest)).blueprintRepairs?.find(r => r.original.milestoneId === event.milestoneId);
  if (prior?.successor) {
    await recordBlueprintRepair(job, turn.digest, { ...grant, successor: prior.successor,
      incident: grant.incident && { ...grant.incident,
        successorApproval: await milestoneBlueprintApprovalProvenance(job, prior.successor, event.assignment) } });
    await reviewedMilestoneHandoff(job, event);
    return;
  }
  await recordBlueprintRepair(job, turn.digest, grant);
  await archiveReviewedMilestoneBlueprint(job, old.pin, event.assignment);
  if (input.fixture && process.env.NT_BLUEPRINT_CORRECTION_FIXTURE_INTERRUPT === "archived")
    throw new PiBudgetPause("fixture interruption after original Blueprint archival", (await inspectPiPolicy(job)).budget);
  const accepts = (draft: MilestoneBlueprint) => {
    if (equal(draft, candidate)) return true;
    if (equal(draft, old.design)) return false;
    if (ownerConflict || findings.length !== 1 || input.omission && draft.downstream.some(item => item.owner === "interactive")) return false;
    const c: BlueprintChallenge = findings[0].blueprintChallenge;
    const [array, index, field] = c.field.split("/");
    const entry = draft[array as "events" | "downstream"][Number(index)] as unknown as Record<string, unknown> | undefined;
    return !!entry && equal(proposedField(old.design, { ...c, proposed: entry[field!] }), draft);
  };
  const task = "Post-approval correction for FUTURE obligations only; the reviewed Event remains valid. " +
    "Do not regenerate it or modify canonical sources. Read the cited Event sources. Independently reject if the exact proposed correction " +
    "would drop real obligations, change protected decisions, or is not justified. No scope outside this patch. " +
    JSON.stringify({ goal: turn.goal, grant, findings, eventOnly: input.omission, sources: [...sources], original: old.design, proposed: candidate });
  const next = await ensureMilestoneBlueprint(job, plan, event.assignment, event.snapshot, event.provider, event.model,
    task, head, input.fixture, { candidate, sources: [...sources], accepts, exactPatch: ownerConflict, supersedes: {
      original: old.pin, eventHead: old.eventHead, turnDigest: turn.digest, evidenceDigest: grant.evidenceDigest, originalReviewDigest: grant.originalReviewDigest } });
  const approved = await readReviewedMilestoneBlueprint(job, next.pin, event.assignment);
  await clean();
  if (await originalBlueprintReviewDigest(job, old.pin) !== grant.originalReviewDigest)
    throw Error("Historical Blueprint approval changed during correction.");
  if (!accepts(approved)) throw Error("Reviewed correction exceeds the approved material patch.");
  await recordBlueprintRepair(job, turn.digest, { ...grant, successor: next.pin,
    incident: grant.incident && { ...grant.incident,
      successorApproval: await milestoneBlueprintApprovalProvenance(job, next.pin, event.assignment) } });
}
