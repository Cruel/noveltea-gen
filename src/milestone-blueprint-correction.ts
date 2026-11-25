/** Postcommit repair admission in the existing Interactive preflight, under its
 * writer lease. Only the private planning owner runs; the Event never reruns. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { trustedHead } from "./revision.js";
import { selectedAssignment } from "./event-work.js";
import { openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { inspectRecoveryCheckpoints,
  inspectHistoricalRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { readIndependentReview } from "./checkpoint-assurance.js";
import { historicalMilestoneHandoff, reviewedMilestoneHandoff, milestoneRevisionImpact, type MilestoneEventSource } from "./milestone-obligation-handoff.js";
import { readEventOnlyOmission, readHistoricalEventOnlyOmission,
  type EventOnlyRef } from "./interactive-event-only.js";
import { archiveReviewedMilestoneBlueprint, ensureMilestoneBlueprint, milestoneBlueprintApprovalProvenance, originalBlueprintReviewDigest, readReviewedMilestoneBlueprint, parseMilestoneBlueprint, type MilestoneBlueprint } from "./milestone-blueprint.js";
import { classifyApprovalRevisionCause, approvalRevisionSeverity, inspectRepairLedger, recordBlueprintRepair, type BlueprintRepair } from "./repair-ledger.js";
import { execFileSync } from "./git-read-cache.js";
import { sourceBoundBlueprintChallenge, proposedBlueprintField,
  type BlueprintChallenge, type SpecialistBlueprintChallenge } from "./blueprint-challenge.js";
import { verifyJobPiSession } from "./job-session.js";
import { lastSpecialistManifest } from "./specialist-manifest.js";
export type { BlueprintChallenge } from "./blueprint-challenge.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Verify a claimed specialist challenge against the original completed Pi
 * response; changing a private receipt cannot create a new model finding. */
async function originalSpecialistChallenge(job: JobStartResult, event: {
  worker?: string; sessionFile?: string; sessionId?: string; workItemId?: string;
  blueprintChallenge?: SpecialistBlueprintChallenge }, challenge: SpecialistBlueprintChallenge) {
  if (event.worker !== "pi") throw Error("Historical Event evidence cannot authorize a Blueprint correction.");
  if (event.worker !== "pi" || !event.workItemId)
    throw Error("Blueprint specialist challenge has no original worker identity.");
  await verifyJobPiSession(job, "event", event.sessionFile, event.sessionId, event.workItemId);
  if (!event.sessionFile || !event.sessionId)
    throw Error("Blueprint specialist challenge lost its original session identity.");
  const messages = (await readFile(event.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
    type?: string; message?: { role?: string; stopReason?: string;
      content?: Array<{ type: string; text?: string }> } });
  const completed = messages.filter(m => m.type === "message" && m.message?.role === "assistant" &&
    !["aborted", "error"].includes(m.message.stopReason ?? ""));
  const last = completed.at(-1)?.message;
  const text = last?.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") ?? "";
  if (!equal(lastSpecialistManifest(text)?.blueprintChallenge, challenge) ||
      !equal(event.blueprintChallenge, challenge))
    throw Error("Blueprint specialist challenge was not present in the completed pinned Pi response.");
}
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" });
}
type VerifiedChallenge = { c: BlueprintChallenge; path: string; line: number;
  origin: "reviewer" | "specialist" };
function reviewBlueprintFindings(review: Awaited<ReturnType<typeof readIndependentReview>> | null | undefined) {
  const evidence = review?.result?.evidence;
  const parsed = evidence?.includes('"blueprintChallenge"') && evidence.startsWith("{")
    ? JSON.parse(evidence).evidence : [];
  return Array.isArray(parsed) ? parsed.filter(e => e.blueprintChallenge !== undefined) : [];
}
/** A postapproval Event cannot retroactively prove a defect in an earlier
 * review. Only a sealed reviewer challenge citing the SAME canonical line
 * at the historical approval source can establish a prior-visible defect. */
export function historicallyVisibleReview(job: JobStartResult, originalSha: string,
  claims: VerifiedChallenge[], omitted: boolean, specialist: boolean): boolean {
  if (omitted || specialist || !claims.length || claims.some(c => c.origin !== "reviewer"))
    return false;
  return claims.every(({ c, path, line }) => {
    try {
      const source = git(job, "show", originalSha + ":" +
        (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path);
      return source.split(/\r?\n/)[line - 1]?.trim() === c.sourceQuote;
    } catch { return false; }
  });
}
function blueprintRevisionCause(job: JobStartResult, originalSha: string, head: string,
  omission: boolean, findings: unknown[], specialist: boolean, claims: VerifiedChallenge[]) {
  const historical = historicallyVisibleReview(job, originalSha, claims, omission, specialist);
  return classifyApprovalRevisionCause({
    kind: historical ? "historical-contradiction" :
      omission && !findings.length && !specialist ? "later-constraint" : "unknown",
    originalSourceSha: originalSha,
    verifiedSourceSha: historical ? originalSha : head,
  });
}

export async function correctPendingBlueprint(job: JobStartResult, plan: Plan,
  event: MilestoneEventSource & { snapshot?: SkillSnapshot; worker?: string; provider?: string; model?: string; planDigest?: string;
    sessionFile?: string; sessionId?: string; workItemId?: string; blueprintChallenge?: SpecialistBlueprintChallenge },
  input: { head: string; fixture: boolean; omission: EventOnlyRef | null; protectionBase?: string; objective?: string; turnDigest?: string; native: Parameters<typeof selectedAssignment>[2] }) {
  if (input.fixture) throw Error("Obsolete Blueprint correction authority.");
  const old = await historicalMilestoneHandoff(job, event);
  if (!old || !event.assignment || !event.snapshot) return;
  const ownerConflict = !!input.omission && old.design.downstream.some(item => item.owner === "interactive");
  const point = (await inspectRecoveryCheckpoints(job)).find(p => p.commitSha === event.commitSha && p.eligible &&
    p.workItem === "event-" + event.milestoneId.slice(10));
  const review = point?.assurance && await readIndependentReview(job, point.assurance);
  const findings = reviewBlueprintFindings(review);
  const specialist = event.blueprintChallenge;
  const trailer = git(job, "log", "-1", "--format=%B", old.eventHead).split("\n")
    .find(line => line.startsWith("NovelTea-Blueprint-Challenge: "));
  if (trailer !== (specialist ? "NovelTea-Blueprint-Challenge: " + sha(specialist) : undefined))
    throw Error("Specialist Blueprint challenge does not match the immutable Event commit.");
  if (!ownerConflict && !findings.length && !specialist) return;
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
  if (!turn || input.objective !== turn.originalRequest || input.turnDigest !== turn.digest || !point || review?.status !== "passed" || point.planVersion !== plan.version || point.assurance?.assignmentId !== "event" || point.assurance.turnDigest !== turn.digest ||
      event.expectedHead !== old.pin.sourceSha || owner?.specialist !== "nt-event-design" || !owner.authority.recordTypes.includes("event") ||
      owner.targets.some(id => id.startsWith("milestone.")) && !owner.targets.includes(event.milestoneId) ||
      plan.contract.scope.kind === "partial" && !plan.contract.scope.targets.includes(event.milestoneId) ||
      !turn.assignments.some(a => a.id === "interactive") || JSON.stringify(plan.contract) !== JSON.stringify(event.assignment.contract) ||
      !["full-story", "partial"].includes(plan.contract.scope.kind) || input.protectionBase !== head || event.planDigest !== sha(plan) ||
      existsSync(join(job.stateDir, "composition-items", event.milestoneId.slice(10) + ".json")) ||
      event.worker !== "pi" || !event.provider || !event.model ||
      await openSkillSnapshot(event.snapshot.id) !== event.snapshot.path)
    throw Error("No current reviewed Event, protected Turn scope or planning owner for Blueprint correction.");
  const currentScope = selectedAssignment(job, plan, input.native, event.milestoneId, point.workItem);
  if (currentScope.milestonePath !== event.assignment.milestonePath || currentScope.workItemId !== event.assignment.workItemId ||
      !equal(currentScope.authority, event.assignment.authority) || !equal(currentScope.arcIds, event.assignment.arcIds) ||
      !equal(currentScope.characterIds, event.assignment.characterIds) || event.assignment.sourcePaths.some(path => !currentScope.sourcePaths.includes(path)))
    throw Error("Blueprint planning scope differs from the current canonical Milestone assignment.");
  await readReviewedMilestoneBlueprint(job, old.pin, event.assignment, { provider: event.provider,
    model: event.model, planDigest: sha(plan), contractDigest: sha(plan.contract), snapshotId: event.snapshot.id });
  git(job, "merge-base", "--is-ancestor", old.eventHead, head);
  let candidate = structuredClone(old.design);
  const sources = new Set<string>();
  if (findings.length > 1) throw Error("Multiple material challenges need a separately bounded assignment.");
  const claims: VerifiedChallenge[] = [];
  for (const e of findings) {
    if (e.commitSha !== old.eventHead || e.assignmentId !== "event")
      throw Error("Blueprint reviewer challenge is not bound to the original Event review.");
    claims.push({ c: e.blueprintChallenge, path: e.path, line: e.line, origin: "reviewer" });
  }
  if (specialist) {
    await originalSpecialistChallenge(job, event, specialist);
    claims.push({ c: specialist, path: specialist.path, line: specialist.line, origin: "specialist" });
  }
  // Contradictory proposals about ONE material field are a bounded semantic
  // dispute: authenticate both before a fresh independent correction review.
  // Unrelated fields require separate assignments, never a combined grant.
  if (claims.length > 1 && claims.some(entry => entry.c.field !== claims[0]!.c.field ||
      !equal(entry.c.before, claims[0]!.c.before) || entry.c.pinDigest !== claims[0]!.c.pinDigest))
    throw Error("Multiple unrelated material challenges require separately bounded adjudication.");
  const disputed = claims.length > 1 && !claims.every(entry => equal(entry.c, claims[0]!.c));
  for (const { c, path, line } of claims) {
    if (!point.assurance.changedPaths.includes(path))
      throw Error("Blueprint challenge is not bound to the reviewed Event source.");
    const repoPath = (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path;
    const source = git(job, "show", old.eventHead + ":" + repoPath);
    if (git(job, "show", head + ":" + repoPath) !== source)
      throw Error("Blueprint challenge cited an Event source changed since its independent review.");
    const proposed = sourceBoundBlueprintChallenge(old.design, old.pin.digest, c,
      { path, line }, { path, content: source }, point.assurance.changedPaths);
    // Reviewer evidence is independently sealed; a competing specialist
    // proposal is carried into adjudication, not silently applied as a grant.
    if (c === claims[0]!.c) candidate = proposed;
    sources.add(path);
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
  const prior = (await inspectRepairLedger(job, turn.digest)).blueprintRepairs?.find(r => r.original.milestoneId === event.milestoneId);
  const evidenceDigest = sha(specialist || disputed
    ? [input.omission, findings, specialist, disputed, sha(candidate)]
    : [input.omission, findings, sha(candidate)]);
  // Controller-observed source and review citations, never a model's cause.
  const cause = blueprintRevisionCause(job, old.pin.sourceSha, head,
    !!input.omission, findings, !!specialist, claims);
  const grant: BlueprintRepair = { owner: "nt-event-design", original: old.pin, eventHead: old.eventHead,
    originalReviewDigest: await originalBlueprintReviewDigest(job, old.pin),
    sourceSha: head, planDigest: sha(plan), evidenceDigest,
    // Pre-#230 interrupted grants retain their original identity on replay.
    ...(prior && !prior.affected ? {} : { affected: milestoneRevisionImpact(old.design, candidate) }),
    incident: { id: sha({ jobId: job.jobId, threadId: job.threadId, turnDigest: turn.digest,
        original: old.pin, evidenceDigest }), cause, severity: approvalRevisionSeverity(cause),
      trigger: {
        kind: [!!input.omission, !!findings.length, !!specialist].filter(Boolean).length > 1
          ? "combined" : specialist ? "event-specialist" : findings.length
            ? "independent-event-review" : "event-only",
        fields: [...(ownerConflict ? ["downstream/interactive"] : []),
          ...findings.map(f => (f.blueprintChallenge as BlueprintChallenge).field),
          ...(specialist ? [specialist.field] : [])].sort(),
        sourcePaths: [...sources].sort(), reviewDigest: findings.length ? sha(review?.result) : null },
      affectedWork: ["interactive:" + event.milestoneId, "composition:" + event.milestoneId],
      originalApproval: await milestoneBlueprintApprovalProvenance(job, old.pin, event.assignment) } };
  if (prior?.successor) {
    await recordBlueprintRepair(job, turn.digest, { ...grant, successor: prior.successor,
      incident: grant.incident && { ...grant.incident,
        successorApproval: await milestoneBlueprintApprovalProvenance(job, prior.successor, event.assignment) } });
    await reviewedMilestoneHandoff(job, event);
    return;
  }
  await recordBlueprintRepair(job, turn.digest, grant);
  await archiveReviewedMilestoneBlueprint(job, old.pin, event.assignment);
  const accepts = (draft: MilestoneBlueprint) => {
    if (equal(draft, candidate)) return true;
    if (equal(draft, old.design)) return false;
    if (ownerConflict || claims.length === 0 || input.omission && draft.downstream.some(item => item.owner === "interactive")) return false;
    const c = claims[0]!.c;
    const [array, index, field] = c.field.split("/");
    const entry = draft[array as "events" | "downstream"][Number(index)] as unknown as Record<string, unknown> | undefined;
    try { return !!entry && equal(proposedBlueprintField(old.design, { ...c, proposed: entry[field!] }), draft); }
    catch { return false; }
  };
  const task = (disputed ? "DISPUTED APPROVED PLAN: The specialist and Event reviewer proposed different corrections " +
    "to the same cited field. Independently adjudicate both source-bound claims; reject if evidence cannot resolve " +
    "the contradiction. A prior PASS and either proposed value alone are NOT sufficient. " : "") +
    "Post-approval correction for FUTURE obligations only; the reviewed Event remains valid. " +
    "Do not regenerate it or modify canonical sources. Read the cited Event sources. Independently reject if the exact proposed correction " +
    "would drop real obligations, change protected decisions, or is not justified. No scope outside this patch. " +
    JSON.stringify({ goal: turn.goal, grant, findings, specialist, eventOnly: input.omission,
      sources: [...sources], original: old.design, proposed: candidate });
  const next = await ensureMilestoneBlueprint(job, plan, event.assignment, event.snapshot, event.provider, event.model,
    task, head, input.fixture, { candidate, sources: [...sources], accepts, exactPatch: ownerConflict || disputed, supersedes: {
      original: old.pin, eventHead: old.eventHead, turnDigest: turn.digest, evidenceDigest: grant.evidenceDigest, originalReviewDigest: grant.originalReviewDigest } });
  const approved = await readReviewedMilestoneBlueprint(job, next.pin, event.assignment);
  await clean();
  if (await originalBlueprintReviewDigest(job, old.pin) !== grant.originalReviewDigest)
    throw Error("Historical Blueprint approval changed during correction.");
  if (!accepts(approved)) throw Error("Reviewed correction exceeds the approved material patch.");
// The approved patch must have precisely the dependent impact admitted by
  // the controller; this must be verified before recording the successor.
  if (grant.affected && !equal(milestoneRevisionImpact(old.design, approved), grant.affected))
    throw Error("Approved Blueprint changed dependent impact outside its authorized correction.");
  await recordBlueprintRepair(job, turn.digest, { ...grant, successor: next.pin,
    incident: grant.incident && { ...grant.incident,
      successorApproval: await milestoneBlueprintApprovalProvenance(job, next.pin, event.assignment) } });
}

/** Reconstruct the incident's classification from original independently
 * reviewed Event findings, the Git-bound specialist challenge and the sealed
 * Event-only omission. A mutable ledger cannot relabel a warning as info, or
 * change trigger metadata to manufacture a different explanation. This check
 * is read-only and runs BEFORE admin inspection applies severity/cause filters. */
export async function verifyBlueprintRevisionEvidence(job: JobStartResult,
  repair: BlueprintRepair, turnDigest: string,
  event: MilestoneEventSource & { snapshot?: SkillSnapshot; worker?: string;
    blueprintChallenge?: SpecialistBlueprintChallenge; sessionFile?: string;
    sessionId?: string; workItemId?: string }) {
  const incident = repair.incident;
  if (!incident || !event.assignment) throw Error("Post-approval incident lacks its verified Event.");
  const historical = await historicalMilestoneHandoff(job, event);
  if (!historical || !equal(historical.pin, repair.original) ||
      historical.eventHead !== repair.eventHead)
    throw Error("Post-approval incident lost its authenticated historical Blueprint.");
  const point = await inspectHistoricalRecoveryCheckpoint(job, repair.eventHead);
  if (point.workItem !== "event-" + event.milestoneId.slice(10))
    throw Error("Post-approval incident original Event checkpoint identity changed.");
  if (!point?.assurance) throw Error("Post-approval incident lost independent Event review.");
  const review = await readIndependentReview(job, point.assurance);
  if (review.status !== "passed" || !review.result)
    throw Error("Post-approval incident lost its original independently sealed verdict.");
  const findings = reviewBlueprintFindings(review);
  const specialist = event.blueprintChallenge;
  const trailer = git(job, "log", "-1", "--format=%B", repair.eventHead).split("\n")
    .find(line => line.startsWith("NovelTea-Blueprint-Challenge: "));
  if (trailer !== (specialist ? "NovelTea-Blueprint-Challenge: " + sha(specialist) : undefined))
    throw Error("Post-approval incident lost its immutable specialist challenge.");
  if (specialist) await originalSpecialistChallenge(job, event, specialist);
  const slug = event.milestoneId.slice(10);
  const omissionPath = join(job.stateDir, "interactive-event-only", slug + ".json");
  let omission: Awaited<ReturnType<typeof readEventOnlyOmission>> | null = null;
  if (existsSync(omissionPath)) {
    const stat = await lstat(omissionPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
      throw Error("Post-approval incident Event-only omission has unsafe evidence.");
    const seal = JSON.parse(await readFile(omissionPath, "utf8")) as {
      phase?: string; nonce?: string; digest?: string };
    if (seal.phase !== "sealed" || !seal.nonce || !seal.digest || !event.snapshot?.id)
      throw Error("Post-approval incident Event-only omission is not sealed.");
    const checked = await readHistoricalEventOnlyOmission(job, event.milestoneId,
      { nonce: seal.nonce, digest: seal.digest }, {
        eventHead: repair.eventHead, planDigest: repair.planDigest,
        eventSnapshotId: event.snapshot.id, validatorVersion: job.validatorVersion,
      });
    if (checked.reviewHead !== repair.sourceSha || checked.turnDigest !== turnDigest ||
        checked.reviewMode !== event.worker)
      throw Error("Post-approval incident Event-only review changed its source or author Turn.");
    omission = checked;
  }
  const ownerConflict = !!omission &&
    historical.design.downstream.some(item => item.owner === "interactive");
  const claims: VerifiedChallenge[] = findings.map(f => {
    if (f.commitSha !== repair.eventHead || f.assignmentId !== "event")
      throw Error("Post-approval incident reviewer challenge has changed its Event source.");
    return { c: f.blueprintChallenge, path: f.path, line: f.line, origin: "reviewer" };
  });
  if (specialist) claims.push({ c: specialist, path: specialist.path,
    line: specialist.line, origin: "specialist" });
  const sources = new Set<string>();
  for (const claim of claims) {
    if (!point.assurance.changedPaths.includes(claim.path) ||
        !Number.isSafeInteger(claim.line))
      throw Error("Post-approval incident challenge lost its independently reviewed file.");
    const source = git(job, "show", repair.eventHead + ":" +
      (job.storyRelativePath ? job.storyRelativePath + "/" : "") + claim.path);
    sourceBoundBlueprintChallenge(historical.design, repair.original.digest,
      claim.c, { path: claim.path, line: claim.line }, { path: claim.path, content: source },
      point.assurance.changedPaths);
    sources.add(claim.path);
  }
  if (omission)
    for (const path of Object.keys(omission.sourceHashes).filter(p => p.startsWith("events/")))
      sources.add(path);
  const trigger = {
    kind: [!!omission, !!findings.length, !!specialist].filter(Boolean).length > 1
      ? "combined" : specialist ? "event-specialist" : findings.length
        ? "independent-event-review" : "event-only",
    fields: [...(ownerConflict ? ["downstream/interactive"] : []),
      ...findings.map(f => (f.blueprintChallenge as BlueprintChallenge).field),
      ...(specialist ? [specialist.field] : [])].sort(),
    sourcePaths: [...sources].sort(),
    reviewDigest: findings.length ? sha(review.result) : null,
  };
  const cause = blueprintRevisionCause(job, repair.original.sourceSha, repair.sourceSha,
    !!omission, findings, !!specialist, claims);
  if (!findings.length && !specialist && !omission ||
      !equal(incident.trigger, trigger) || incident.cause !== cause ||
      incident.severity !== approvalRevisionSeverity(cause))
    throw Error("Post-approval incident classification or triggering evidence changed.");
}
