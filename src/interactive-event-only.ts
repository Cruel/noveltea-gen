/** A reviewed no-write controller path for an observational Event-only Milestone.
 * No Choice/Puzzle author is invoked and no synthetic Git work item is created.
 * Recovery and Composition independently reopen this same source-bound proof. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { execFileSync } from "./git-read-cache.js";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import { observedNondecisionMilestone } from "./event-specialist.js";
import { currentMilestoneChoiceBinding } from "./event-work.js";
import { explicitlyRequiresPuzzle } from "./puzzle-obligation.js";
import { declaredCanonicalReferences } from "./focused-scope.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { createSkillSnapshot, openSkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { readRecoveryFork } from "./recovery-fork-state.js";
import { reviewNarrative, type ReviewAssignment } from "./narrative-review-specialist.js";

const sha256 = (value: string | Buffer | unknown) =>
  createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value)
    ? value : JSON.stringify(value)).digest("hex");
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9-]*$/;
type RecordItem = { path: string; metadata: Record<string, any> & { type: string; id: string; status: string } };
type NativeReport = {
  records: RecordItem[];
  coverage: { search: { truncated: boolean };
    eventProgress: Array<{ id: string; status: string; witness?: string[] }>;
    milestoneRoutes: Array<{ id: string; routes: Array<{ status: string; witness?: string[] }> }>;
    branchProgress: Array<{ event: string; step: string; branch: string; status: string; witness?: string[] }> };
};
export interface EventOnlyRef { nonce: string; digest: string }
export interface EventOnlyPayload {
  version: 1; decision: "event-only"; jobId: string; threadId: string; branch: string;
  baseSha: string; eventHead: string; reviewHead: string; milestoneId: string; eventIds: string[];
  planVersion: number; planDigest: string; turnDigest: string; validatorVersion: string;
  eventSnapshotId: string; reviewerSnapshotId: string | null;
  reviewMode: "pi" | "fixture"; reviewerSession: string | null; reviewerSessionSha256: string | null;
  evidence: string[]; sourceHashes: Record<string, string>;
}
interface Seal { phase: "sealed"; nonce: string; digest: string; payload: EventOnlyPayload;
  inherited?: { sourceJobId: string; sourceSeal: EventOnlyRef; sourcePayloadDigest: string } }
const pathFor = (job: JobStartResult, milestone: string) => {
  if (!MILESTONE.test(milestone)) throw Error("Invalid Event-only Milestone ID.");
  return join(job.stateDir, "interactive-event-only", milestone.slice(10) + ".json");
};
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}
function scopedRecords(report: NativeReport, milestone: string, eventIds: string[]) {
  const records = report.records.filter(r => r.metadata.status !== "superseded");
  const selected = records.find(r => r.metadata.type === "milestone" && r.metadata.id === milestone);
  const routes = report.coverage.milestoneRoutes.find(r => r.id === milestone)?.routes ?? [];
  const fulfillment = selected?.metadata.fulfillment?.any_of as string[][] | undefined;
  if (!selected || !observedNondecisionMilestone(String(selected.metadata.change ?? "")) ||
      selected.metadata.completeness === "partial" || !fulfillment?.length ||
      routes.length !== fulfillment.length || !routes.some(r => r.status === "reachable") ||
      routes.some(r => r.status === "impossible" || r.status === "incomplete" || r.status === "unverified") ||
      !eventIds.length || !eventIds.some(id => fulfillment.some(route => route.includes(id))) ||
      eventIds.some(id => !records.some(r => r.metadata.type === "event" && r.metadata.id === id) ||
        !report.coverage.eventProgress.some(r => r.id === id && r.status === "reachable")) ||
      report.coverage.search.truncated)
    return null;
  return { records, selected, routes };
}
/** This is a conservative eligibility preflight, not a semantic verdict.
 * Only an independent reviewer can authorize the omission on a live Turn. */
export async function eventOnlyCandidate(job: JobStartResult, plan: Plan, report: NativeReport,
  milestone: string, eventIds: string[], obligations: string[]) {
  const selected = scopedRecords(report, milestone, eventIds);
  if (!selected || currentMilestoneChoiceBinding(obligations, milestone,
      String(selected.selected.metadata.change ?? ""))) return false;
  const turn = await readReviewTurnEvidence(job);
  if (!turn?.objective || !turn.digest) return false;
  if (plan.contract.scope.targets.some(id => id.startsWith("choice-point.") || id.startsWith("puzzle.")) &&
      plan.contract.scope.kind === "partial") return false;
  if (turn.objective.requestedTargets.some(id => id.startsWith("choice-point.") ||
      id.startsWith("puzzle.")) && turn.contract.scope.kind === "partial") return false;
  if (selected.records.some(r =>
      r.metadata.type === "choice-point" &&
        (r.metadata.events as string[] ?? []).some(id => eventIds.includes(id)) ||
      r.metadata.type === "puzzle" &&
        (r.metadata.solutions as string[] ?? []).some(id => eventIds.includes(id))))
    return false;
  // A whole-Story objective (e.g. solve the mystery later) is not a
  // per-Milestone demand for a Puzzle at *every* observational scene.
  // Preserve that global obligation for the independently reviewed final
  // Turn. Do not omit explicit local, every-Milestone, or bound mechanics.
  const global = [turn.originalRequest, turn.goal,
    ...turn.objective.obligations, ...turn.contract.constraints];
  const everyMilestone = /\b(?:every|each|per)\s+(?:single\s+)?(?:event|milestone|scene)\b.{0,75}\b(?:choice|decision|puzzle|riddle)\b|\b(?:choice|decision|puzzle|riddle)\b.{0,75}\b(?:every|each|per)\s+(?:single\s+)?(?:event|milestone|scene)\b/i;
  if (global.some(text => everyMilestone.test(text))) return false;
  if (obligations.some(text => explicitlyRequiresPuzzle(text, "event-handoff"))) return false;
  if (plan.contract.scope.kind === "partial" &&
      plan.contract.constraints.some(text => explicitlyRequiresPuzzle(text))) return false;
  return true;
}
async function sourceHashes(job: JobStartResult, report: NativeReport,
  milestone: string, eventIds: string[]) {
  const active = report.records.filter(r => r.metadata.status !== "superseded");
  const byId = new Map(active.map(r => [r.metadata.id, r]));
  const eventSources = [milestone, ...eventIds].map(id => byId.get(id));
  if (eventSources.some(r => !r) ||
      eventSources[0]?.metadata.type !== "milestone" ||
      eventSources.slice(1).some(r => r?.metadata.type !== "event"))
    throw Error("Event-only proof lacks actual Milestone/Event sources.");
  const related = new Set([...eventSources.map(r => r!.metadata.id),
    ...active.filter(r => r.metadata.type === "creative-direction").map(r => r.metadata.id)]);
  // Include typed outgoing context (Characters, Arcs, Facts, Relationships,
  // Revelations) and content/route records referring into this source.
  for (const record of eventSources) for (const id of declaredCanonicalReferences(record!))
    if (byId.has(id)) related.add(id);
  for (const record of active) if (
    ["authored-content", "narrative-position", "puzzle", "choice-point"].includes(record.metadata.type) &&
    [...declaredCanonicalReferences(record)].some(id => related.has(id)))
      related.add(record.metadata.id);
  for (const record of active) if (record.metadata.type === "relationship" &&
    [...declaredCanonicalReferences(record)].some(id => related.has(id)))
      related.add(record.metadata.id);
  const selected = active.filter(record => related.has(record.metadata.id));
  if (selected.length > 128) throw Error("Event-only causal source context exceeds bounded review budget.");
  const hashes: Record<string, string> = {};
  for (const source of selected) {
    if (!/^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(source.path))
      throw Error("Unsafe canonical Event-only source path.");
    const path = join(job.worktreeStoryRoot, source.path);
    if (await realpath(path) !== path || !(await lstat(path)).isFile())
      throw Error("Event-only source is not a regular canonical file.");
    hashes[source.path] = sha256(await readFile(path));
  }
  return hashes;
}
async function sessionDigest(job: JobStartResult, file: string) {
  if (!file.startsWith(join(job.stateDir, "review-sessions") + sep) ||
      !file.endsWith(".jsonl") || await realpath(file) !== file)
    throw Error("Event-only reviewer transcript is outside the original review session.");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024 * 1024)
    throw Error("Event-only reviewer transcript is unsafe.");
  return sha256(await readFile(file));
}
export async function readEventOnlyOmission(job: JobStartResult, milestone: string,
  ref: EventOnlyRef | undefined, expected?: { eventHead: string; planDigest: string;
    eventSnapshotId: string; validatorVersion: string }): Promise<EventOnlyPayload> {
  const path = pathFor(job, milestone), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw Error("Invalid Event-only controller proof file.");
  const seal = JSON.parse(await readFile(path, "utf8")) as Seal;
  const p = seal.payload;
  if (!p || seal.phase !== "sealed" || !ref || seal.nonce !== ref.nonce ||
      seal.digest !== ref.digest || !HASH.test(ref.digest) ||
      !/^[0-9a-f-]{36}$/.test(ref.nonce) || sha256(p) !== ref.digest ||
      p.version !== 1 || p.decision !== "event-only" ||
      p.jobId !== job.jobId || p.threadId !== job.threadId ||
      p.branch !== job.branch || p.baseSha !== job.baseSha ||
      p.milestoneId !== milestone || !SHA.test(p.eventHead) || !SHA.test(p.reviewHead) ||
      !HASH.test(p.planDigest) || !HASH.test(p.turnDigest) ||
      !HASH.test(p.eventSnapshotId) || !Array.isArray(p.eventIds) || !p.eventIds.length ||
      p.eventIds.some(id => !/^event\.[a-z][a-z0-9-]*$/.test(id)) ||
      !p.validatorVersion || p.validatorVersion !== job.validatorVersion ||
      expected && (p.eventHead !== expected.eventHead || p.planDigest !== expected.planDigest ||
        p.eventSnapshotId !== expected.eventSnapshotId ||
        p.validatorVersion !== expected.validatorVersion))
    throw Error("Event-only omission identity/source/validator evidence differs.");
  // A same-Thread continuation receives a new job-bound seal but never a
  // newly invented independent verdict. Its origin must match the original
  // source reviewer and no-write receipts in the immutable fork bundle.
  if (seal.inherited) {
    const fork = readRecoveryFork(job);
    const original = fork?.reviewBatch?.entries.find(entry => entry.milestoneId === milestone);
    if (!original || seal.inherited.sourceJobId !== fork?.sourceJobId ||
        JSON.stringify(seal.inherited.sourceSeal) !== JSON.stringify(original.sourceSeal) ||
        seal.inherited.sourcePayloadDigest !== sha256(original.sourcePayload) ||
        p.eventHead !== original.sourcePayload.eventHead ||
        p.reviewHead !== original.sourcePayload.reviewHead ||
        p.planDigest !== original.sourcePayload.planDigest ||
        p.planVersion !== original.sourcePayload.planVersion ||
        p.eventSnapshotId !== fork?.toolchain.skills.id ||
        p.reviewerSnapshotId !== original.sourcePayload.reviewerSnapshotId ||
        p.reviewerSessionSha256 !== original.sourcePayload.reviewerSessionSha256 ||
        JSON.stringify(p.sourceHashes) !== JSON.stringify(original.sourcePayload.sourceHashes) ||
        JSON.stringify(p.eventIds) !== JSON.stringify(original.sourcePayload.eventIds) ||
        JSON.stringify(p.evidence) !== JSON.stringify(original.sourcePayload.evidence) ||
        p.reviewMode !== original.sourcePayload.reviewMode ||
        p.reviewerSession !== (original.sourcePayload.reviewerSession
          ? join(job.stateDir, "review-sessions", "review",
              "inherited-" + milestone.slice(10) + ".jsonl") : null))
      throw Error("Inherited Event-only review differs from its original sealed source.");
  } else if (readRecoveryFork(job)?.reviewBatch?.entries.some(entry =>
      entry.milestoneId === milestone)) {
    throw Error("A transferred Event-only decision lost its inherited source proof.");
  }
  const turn = await readReviewTurnEvidence(job);
  if (!turn || turn.digest !== p.turnDigest)
    throw Error("Event-only omission lost its original authenticated Turn.");
  if (p.reviewMode === "pi") {
    if (!p.reviewerSnapshotId || !HASH.test(p.reviewerSnapshotId) ||
        !(await openSkillSnapshot(p.reviewerSnapshotId)) ||
        !p.reviewerSession || !p.reviewerSessionSha256 ||
        await sessionDigest(job, p.reviewerSession) !== p.reviewerSessionSha256 ||
        !p.evidence.length)
      throw Error("Independent Event-only review is missing or tampered.");
  } else if (p.reviewMode !== "fixture" || p.reviewerSession !== null ||
      p.reviewerSessionSha256 !== null || p.reviewerSnapshotId !== null || p.evidence.length)
    throw Error("Event-only fixture incorrectly claims an independent review.");
  for (const [source, hash] of Object.entries(p.sourceHashes)) {
    if (!HASH.test(hash) || !/^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(source))
      throw Error("Event-only source inventory was altered.");
    const path = join(job.worktreeStoryRoot, source);
    if (await realpath(path) !== path || sha256(await readFile(path)) !== hash)
      throw Error("Event-only canonical evidence changed after review.");
  }
  if (!Object.keys(p.sourceHashes).some(path => path.startsWith("milestones/")) ||
      !p.eventIds.every(id => Object.keys(p.sourceHashes).some(path => path.startsWith("events/"))))
    throw Error("Event-only omission lacks source-file witnesses.");
  git(job, "merge-base", "--is-ancestor", p.eventHead, p.reviewHead);
  git(job, "merge-base", "--is-ancestor", p.reviewHead, "HEAD");
  return p;
}
export async function decideEventOnlyOmission(job: JobStartResult, plan: Plan,
  report: NativeReport, milestone: string, eventHead: string, eventIds: string[],
  eventSnapshotId: string, obligations: string[], input: {
    fixture: boolean; skillsSource?: string; provider: string; model: string }): Promise<EventOnlyRef | null> {
  if (!await eventOnlyCandidate(job, plan, report, milestone, eventIds, obligations)) return null;
  const turn = await readReviewTurnEvidence(job);
  if (!turn?.digest || !turn.objective) return null;
  const path = pathFor(job, milestone);
  if (existsSync(path))
    throw Error("Started Event-only omission review exists; reconcile its sealed receipt or preserved transcript, never replay.");
  const reviewHead = git(job, "rev-parse", "HEAD");
  git(job, "merge-base", "--is-ancestor", eventHead, reviewHead);
  const hashes = await sourceHashes(job, report, milestone, eventIds);
  const planDigest = sha256(plan);
  const file = { phase: "reviewing", jobId: job.jobId, eventHead, milestone,
    turnDigest: turn.digest, planDigest };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file) + "\n", { flag: "wx", mode: 0o600 });
  let snapshotId: string | null = null, session: string | null = null;
  let evidence: string[] = [];
  if (!input.fixture) {
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource,
          skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] }
      : await loadSkillConfig(undefined, false);
    const snapshot = await createSkillSnapshot(config);
    if (!snapshot) throw Error("Event-only omission requires pinned independent review skills.");
    snapshotId = snapshot.id;
    const records = report.records.filter(r => hashes[r.path]);
    const milestoneRoutes = report.coverage.milestoneRoutes.find(r => r.id === milestone)?.routes ?? [];
    const assignment: ReviewAssignment = {
      contract: turn.contract, planVersion: plan.version, scopeIds: [milestone],
      paths: records.map(r => r.path),
      routes: report.coverage.branchProgress.filter(r => eventIds.includes(r.event) && r.status === "reachable")
        .map(r => ({ ...r, witness: r.witness ?? [] })),
      milestoneRoutes: milestoneRoutes.map((r, i) => ({ milestone, alternative: i,
        status: r.status, witness: r.witness ?? [] })),
      puzzleRoutes: [], outstanding: [], uncertainties: [],
      turnGoal: "INDEPENDENT EVENT-ONLY OMISSION REVIEW. The existing source-grounded Event " +
        "already completes this observational Milestone. Independently inspect the author-approved " +
        "goal and actual Milestone/Event sources. PASS only when no formal Choice and no formal Puzzle " +
        "is justified for THIS milestone, the Event fulfillment and narrative causality are real, " +
        "and the original author did not promise a required local decision, Puzzle, or consequence. " +
        "A broader Story-wide interaction promise remains mandatory at final Turn review. " +
        "Do not demand an invented Choice, write anything, or assert that absent branching exists. " +
        "If any essential decision or Puzzle is needed, BLOCK with the exact source requirement. " +
        "Original author goal: " + turn.goal,
      omission: { assignmentId: "interactive:" + milestone, headSha: reviewHead },
    };
    const reviewed = await reviewNarrative(job, snapshot, assignment, input.provider, input.model,
      undefined, async file => { session = file; });
    if (reviewed.verdict !== "pass")
      throw Error("Independent reviewer rejected Event-only omission: " + JSON.stringify(reviewed.findings));
    evidence = reviewed.evidence;
    for (const record of records.filter(r =>
      r.metadata.id === milestone || eventIds.includes(r.metadata.id))) {
      const lines = (await readFile(join(job.worktreeStoryRoot, record.path), "utf8"))
        .split(/\r?\n/).length;
      const witness = evidence.some(item => {
        const at = item.indexOf(record.path + ":");
        const line = at < 0 ? null : item.slice(at + record.path.length + 1).match(/^[1-9][0-9]*/);
        return line && Number(line[0]) <= lines;
      });
      if (!witness) throw Error("Event-only review omitted a real Milestone/Event source-line witness.");
    }
  }
  if (git(job, "rev-parse", "HEAD") !== reviewHead ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Event-only omission source or clean worktree changed during independent review.");
  const current = await sourceHashes(job, report, milestone, eventIds);
  if (JSON.stringify(current) !== JSON.stringify(hashes))
    throw Error("Event-only canonical sources changed during independent review.");
  const payload: EventOnlyPayload = { version: 1, decision: "event-only",
    jobId: job.jobId, threadId: job.threadId, branch: job.branch, baseSha: job.baseSha,
    eventHead, reviewHead, milestoneId: milestone, eventIds, planVersion: plan.version,
    planDigest, turnDigest: turn.digest, validatorVersion: job.validatorVersion,
    eventSnapshotId, reviewerSnapshotId: snapshotId,
    reviewMode: input.fixture ? "fixture" : "pi",
    reviewerSession: session,
    reviewerSessionSha256: session ? await sessionDigest(job, session) : null,
    evidence, sourceHashes: hashes };
  const ref = { nonce: randomUUID(), digest: sha256(payload) };
  await writeFile(path, JSON.stringify({ phase: "sealed", ...ref, payload }, null, 2) + "\n", { mode: 0o600 });
  return ref;
}
