import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { JobReport } from "./job-report.js";
import { verifyPlanHistory, type Plan } from "./architecture.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { type TurnEvidence } from "./turn-plan-evidence.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { assertTurnDeliveryHistory, deliveryCriteria, type NarrativeDeliveryCriteria } from "./turn-delivery.js";
import { readAdaptiveState, assertAdaptiveSettled } from "./adaptive-state.js";
import { projectAdaptiveFinal } from "./adaptive-final-review.js";
import { reviewedMilestoneHandoff,
  assertMilestoneCanonicalClosure } from "./milestone-obligation-handoff.js";
import { validateStoryJob } from "./validator.js";
import type { MilestoneEventSource, ReviewedMilestoneHandoff } from "./milestone-obligation-handoff.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safePath = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;
const MAX_PATHS = 64;
const MAX_CONTEXT = 256 * 1024;

export interface TurnFulfillmentContext {
  headSha: string;
  baseSha: string;
  planVersion: number;
  contract: TurnEvidence["contract"];
  scopeCurrent: boolean;
  scopeComplete: boolean;
  editorialPass: boolean;
  scopedPaths: string[];
}
export function turnFulfillmentContext(report: JobReport): TurnFulfillmentContext {
  return { headSha: report.identity.headSha, baseSha: report.identity.baseSha,
    planVersion: report.plan?.version ?? 0,
    contract: report.plan?.contract ?? ({} as TurnEvidence["contract"]),
    scopeCurrent: report.evidence.scope?.current === true,
    scopeComplete: report.generation.scopeFulfillment === "complete-in-scope",
    editorialPass: report.evidence.editorial.verdict === "pass",
    scopedPaths: report.evidence.scope?.scopedPaths ?? [] };
}
export interface TurnObjective { id: string; text: string }
export interface TurnFulfillmentPacket {
  policy: "turn-completeness/v1";
  source: { jobId: string; baseSha: string; headSha: string; turnDigest: string;
    planVersion: number; planDigest: string; scopeReviewDigest: string;
    adaptive?: { version: number; digest: string; amendments: string[] };
    milestonePlans?: Array<{ milestoneId: string; digest: string; eventHead: string }>;
    checkpoints: Array<{ commitSha: string; assignmentId: string; proofDigest: string;
      review: string; assignmentDigest: string }> };
  goal: string;
  originalRequest: string;
  /** The original author promise, unaffected by later approved work amendments. */
  contract: TurnEvidence["contract"];
  /** The current controller-approved execution scope; its history is verified. */
  approvedContract: TurnEvidence["contract"];
  criteria: NarrativeDeliveryCriteria;
  objectives: TurnObjective[];
  plannedWork: Array<{ id: string; kind: string; targets: string[]; status: string;
    outcome?: string; dependsOn?: string[]; omission?: {
      sourceSha: string; path: string; evidence: string; reviewerSnapshot: string } }>;
  /** Pinned canonical Creative Direction, whether or not it changed this Turn. */
  interactionSources?: string[];
  canonical: Array<{ path: string; content: string }>;
  digest: string;
}
export interface TurnFulfillmentVerdict {
  digest: string;
  verdict: "complete" | "incomplete";
  checks: Array<{ objectiveId: string; fulfilled: boolean;
    evidence: Array<{ path: string; line: number; explanation: string }> }>;
  findings: Array<{ objectiveId: string; message: string;
    followUp: { assignmentId: string; outcome: string; targets: string[] } | null }>;
}
export interface TurnFulfillmentReceipt {
  version: 1;
  policy: TurnFulfillmentPacket["policy"];
  source: TurnFulfillmentPacket["source"];
  packetDigest: string;
  phase: "reviewing" | "completed";
  reviewer: string;
  verdict?: TurnFulfillmentVerdict;
  sessionFile?: string;
}
export type TurnFulfillmentEvaluator = (packet: Readonly<TurnFulfillmentPacket>,
  onSession: (file: string) => Promise<void>) => Promise<unknown>;

function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CONTEXT + 1024 });
}
function receiptPath(job: JobStartResult, packet: TurnFulfillmentPacket) {
  return join(job.stateDir, "turn-fulfillment", packet.digest + ".json");
}
/** Only Event commits that descend into the final verified Story may bring a
 * local private plan to the final independent reviewer. The plan is a set of
 * questions to verify, never an automatic completion receipt. */
async function reviewedMilestoneObjectives(job: JobStartResult, plan: Plan): Promise<{
  objectives: TurnObjective[];
  pins: NonNullable<TurnFulfillmentPacket["source"]["milestonePlans"]>;
  paths: string[];
}> {
  const dir = join(job.stateDir, "event-items");
  if (!existsSync(dir) || plan.contract.scope.depth === "architecture")
    return { objectives: [], pins: [], paths: [] };
  const names = (await readdir(dir)).filter(name =>
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.json$/.test(name)).sort();
  const objectives: TurnObjective[] = [];
  const pins: NonNullable<TurnFulfillmentPacket["source"]["milestonePlans"]> = [];
  const paths: string[] = [];
  const handoffs: ReviewedMilestoneHandoff[] = [];
  const authorized = new Set(plan.items.flatMap(item => item.targetIds));
  for (const name of names) {
    const milestoneId = "milestone." + name.slice(0, -5);
    const file = join(dir, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Unsafe Milestone obligation source receipt.");
    const event = JSON.parse(await readFile(file, "utf8")) as MilestoneEventSource;
    if (event.milestoneId !== milestoneId) throw Error("Milestone Event receipt identity changed.");
    if (event.phase !== "committed") continue; // Unfinished work is blocked by inventory.
    // A later authorized replan may narrow the current work inventory, but
    // must never erase obligations from a Milestone already committed in this
    // Turn. Earlier unrelated historical items remain out of scope.
    if (!authorized.has(milestoneId)) {
      if (!event.commitSha || !/^[a-f0-9]{40}$/.test(event.commitSha) ||
          !/^[a-f0-9]{40}$/.test(job.baseSha)) continue;
      try { git(job, "merge-base", "--is-ancestor", job.baseSha, event.commitSha); }
      catch { continue; }
    }
    const handoff = await reviewedMilestoneHandoff(job, event);
    if (!handoff) continue; // Explicit historical pre-Blueprint source.
    if (handoffs.length >= MAX_PATHS)
      throw Error("Final Milestone review exceeds bounded Story scope.");
    try { git(job, "merge-base", "--is-ancestor", handoff.eventHead, job.headSha); }
    catch { throw Error("Final Story lost the reviewed Milestone Event source ancestry."); }
    handoffs.push(handoff);
    pins.push({ milestoneId, digest: handoff.pin.digest, eventHead: handoff.eventHead });
    paths.push(...new Set([
      ...(event.assignment?.milestonePath ? [event.assignment.milestonePath] : []),
      ...handoff.design.events.flatMap(local => local.evidence.map(e => e.anchorPath)),
    ]));
    for (const [index, local] of handoff.design.events.entries()) {
      objectives.push({ id: "milestone-plan:" + milestoneId + ":local-event:" + index,
        text: "At " + milestoneId + ", verify actual canonical, reachable Event evidence and earned " +
          "knowledge against the reviewed provisional local design, not the plan's claims. " +
          JSON.stringify(local) + " (reviewed plan digest " + handoff.pin.digest + ")." });
    }
    for (const [index, obligation] of handoff.design.downstream.entries()) {
      if (plan.contract.scope.depth === "interactive" && obligation.owner === "composition")
        continue; // Composition is explicitly outside this Turn, not falsely fulfilled.
      objectives.push({ id: "milestone-plan:" + milestoneId + ":" + obligation.owner + ":" + index,
        text: "Required " + obligation.owner + " owner must discharge this reviewed " +
          "Milestone obligation with verified current canonical Story content: " +
          obligation.obligation + ". Planning or a deferred writer report is not fulfillment. " +
          "Plan digest " + handoff.pin.digest + "." });
    }
  }
  if (pins.length && plan.contract.scope.depth === "composition") {
    // Final goal acceptance is the first boundary authorized to require the
    // Milestone closeout itself. The Choice/Composition stages may legitimately
    // finish while completeness is partial and a closeout is still outstanding.
    const verified = await validateStoryJob(job);
    const report = verified.report as {
      records?: Array<{ metadata: Record<string, any> }>;
      coverage?: { milestoneRoutes?: Array<{ id: string; routes: Array<{ status: string }> }> };
    } | undefined;
    if (verified.status !== "passed" || !report?.records ||
        !report.coverage?.milestoneRoutes)
      throw Error("Final Story cannot discharge Milestone obligations without native validation.");
    for (const handoff of handoffs)
      assertMilestoneCanonicalClosure(handoff, handoff.pin.milestoneId,
        report.records, report.coverage.milestoneRoutes);
  }
  return { objectives, pins, paths };
}
async function regular(path: string) {
  if (!existsSync(path)) return null;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe Turn fulfillment receipt.");
  return JSON.parse(await readFile(path, "utf8")) as TurnFulfillmentReceipt;
}

/** Bounded *final Story* packet, independent of each assignment's own diff review.
 * Every source identity comes from the controller's immutable plan and Git proof. */
export async function prepareTurnFulfillment(job: JobStartResult,
  input: TurnFulfillmentContext): Promise<TurnFulfillmentPacket | null> {
  const turn = await readReviewTurnEvidence(job);
  if (!turn) {
    if (job.recoveryFork)
      throw Error("Recovered Story cannot claim full-Turn fulfillment without inherited review evidence.");
    return null; // Explicit legacy CLI contracts are not per-Turn plans.
  }
  if (git(job, "rev-parse", "HEAD").trim() !== job.headSha)
    throw new Error("Story HEAD changed since the controller verified the Turn.");
  if (git(job, "status", "--porcelain=v1", "--untracked-files=all").trim())
    throw new Error("Final Turn review cannot inspect a dirty or unpublished Story worktree.");
  if (turn.kind === "protected-amendment") return null;
  if (!input.scopeCurrent || !input.scopeComplete || !input.editorialPass ||
      input.headSha !== job.headSha || input.baseSha !== job.baseSha)
    throw new Error("Turn completeness requires a current native-validated and editorially reviewed Story.");
  const arch = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as {
    plan?: Plan; history: any[] };
  verifyPlanHistory(job, arch as Parameters<typeof verifyPlanHistory>[1]);
  if (!arch.plan || arch.plan.version !== input.planVersion ||
      JSON.stringify(arch.plan.contract) !== JSON.stringify(input.contract))
    throw new Error("Approved generation plan differs from the final Story scope.");
  assertTurnDeliveryHistory(turn.contract, arch.plan.contract, arch.history);
  // The original Architecture inventory is not the latest work plan once
  // controller-admitted amendments exist. Authenticate the private Thread/Turn
  // ledger, its original Pi transcript and sealed omission history before the
  // independent reviewer sees or can pass any amended obligations.
  const adaptiveState = await readAdaptiveState(job, turn.digest, arch.plan.version);
  if (adaptiveState) assertAdaptiveSettled(adaptiveState);
  const adaptive = adaptiveState?.entries.length ? projectAdaptiveFinal(adaptiveState) : null;
  const scopeReview = await readFile(join(job.stateDir, "narrative-review.json"), "utf8");
  const inspected = await inspectRecoveryCheckpoints(job);
  if (inspected.some(p => !p.eligible || !p.assurance))
    throw new Error("Turn contains invalid or untracked specialist checkpoints; cannot claim complete.");
  const checkpoints = inspected.map(p => ({ commitSha: p.commitSha, assignmentId: p.assurance!.assignmentId,
      proofDigest: p.proofDigest, review: p.semanticReview,
      assignmentDigest: p.assurance!.assignmentDigest })).sort((a, b) =>
      a.commitSha.localeCompare(b.commitSha));
  if (checkpoints.some(p => !["passed", "not-required"].includes(p.review)))
    throw new Error("Independent assignment reviews remain pending or failed; Turn cannot complete.");
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  // Include the APPROVED Story-wide Interaction profile even when no specialist
  // edited Creative Direction in this Turn. A reviewer cannot evaluate Story-
  // wide Choice distribution or Exploration/Puzzle promises from changed paths
  // alone. The canonical bytes are read at the same verified Git HEAD.
  const directionPaths = git(job, "ls-tree", "-r", "--name-only", job.headSha, "--",
    prefix + "creative-direction").split("\n").filter(Boolean)
    .filter(path => path.startsWith(prefix + "creative-direction/") && path.endsWith(".md"))
    .map(path => path.slice(prefix.length));
  if (adaptive && turn.kind === "full-story" && !directionPaths.length)
    throw Error("Amended whole-Story completion lacks an approved Creative Direction source.");
  const milestonePlans = await reviewedMilestoneObjectives(job, arch.plan);
  const paths = [...new Set([
    ...milestonePlans.paths,
    ...directionPaths,
    ...input.scopedPaths,
    ...turn.assignments.flatMap(a => a.authority.existingPaths),
    ...inspected.flatMap(p => p.assurance!.changedPaths),
  ])].sort();
  if (!paths.length || paths.length > MAX_PATHS || paths.some(p => !safePath.test(p)))
    throw new Error("Plan-level Story assessment has missing, unsafe, or unbounded canonical scope; author must narrow or replan.");
  const canonical = paths.map(path => {
    try { return { path, content: git(job, "show", job.headSha + ":" + prefix + path) }; }
    catch { throw new Error("Plan-level canonical evidence is missing at verified HEAD: " + path); }
  });
  if (Buffer.byteLength(JSON.stringify(canonical)) > MAX_CONTEXT)
    throw new Error("Plan-level Story context exceeds the bounded reviewer budget; require a scoped plan.");
  const criteria = deliveryCriteria(turn.kind, turn.contract);
  const objectives: TurnObjective[] = [
    { id: "goal", text: turn.goal },
    ...criteria.objectives,
    ...turn.contract.constraints.map((text, i) => ({ id: "constraint:" + i, text })),
    ...turn.contract.envelope.hardLimits.map((text, i) => ({ id: "hard-limit:" + i, text })),
    { id: "presentation", text: turn.contract.envelope.presentation },
    ...(turn.objective?.obligations.map((text, i) =>
      ({ id: "delivery-obligation:" + i, text })) ?? []),
    // Explicitly approved plan changes add obligations; they do not erase
    // original author intent or secretly make it "fulfilled".
    ...arch.plan.contract.constraints.map((text, i) => ({ id: "approved-constraint:" + i, text })),
    ...arch.plan.contract.envelope.hardLimits.map((text, i) =>
      ({ id: "approved-hard-limit:" + i, text })),
    { id: "approved-presentation", text: arch.plan.contract.envelope.presentation },
    ...arch.plan.contract.scope.targets.map((text, i) =>
      ({ id: "approved-target:" + i, text })),
    ...turn.assignments.filter(a => a.id !== "review").map(a =>
      ({ id: "assignment:" + a.id, text: a.outcome })),
    ...(adaptive?.objectives ?? []),
    ...milestonePlans.objectives,
  ];
  const source = { jobId: job.jobId, baseSha: job.baseSha, headSha: job.headSha,
    turnDigest: turn.digest, planVersion: arch.plan.version, planDigest: hash(arch.plan),
    scopeReviewDigest: hash(scopeReview),
    ...(adaptive ? { adaptive: adaptive.source } : {}),
    ...(milestonePlans.pins.length ? { milestonePlans: milestonePlans.pins } : {}),
    checkpoints };
  const originalWork = arch.plan.items.map(i => ({ id: i.id, kind: i.kind,
    targets: i.targetIds, status: i.status }));
  const latest = new Map<string, TurnFulfillmentPacket["plannedWork"][number]>(
    originalWork.map(item => [item.id, item]));
  // A split retires the fixed-plan aggregate; showing it as an additional
  // completed assignment would double-count the same Choice/Puzzle outcome.
  for (const retired of adaptive?.superseded ?? []) latest.delete(retired);
  for (const amended of adaptive?.plannedWork ?? []) latest.set(amended.id, amended);
  const body = { policy: "turn-completeness/v1" as const, source, goal: turn.goal,
    originalRequest: turn.originalRequest, contract: turn.contract,
    approvedContract: arch.plan.contract, criteria, objectives,
    ...(directionPaths.length ? { interactionSources: directionPaths } : {}),
    plannedWork: [...latest.values()], canonical };
  return { ...body, digest: hash(body) };
}

/** The evaluator's words cannot add writing scope, grant approvals or certify
 * an objective that is missing from its signed input. */
export function validateTurnFulfillment(packet: TurnFulfillmentPacket,
  raw: unknown): TurnFulfillmentVerdict {
  const v = raw as TurnFulfillmentVerdict | null;
  const objectives = new Set(packet.objectives.map(o => o.id));
  const assignmentIds = new Set(packet.objectives.filter(o => o.id.startsWith("assignment:"))
    .map(o => o.id.slice("assignment:".length)));
  // Amended executable work is independently admitted after the original
  // Turn. Its exact targets can receive a follow-up PROPOSAL, never a grant.
  const adaptiveTargets = new Map(packet.source.adaptive ? packet.plannedWork
    .filter(item => ["controller-admitted", "controller-refined"].includes(item.status))
    .map(item => [item.id, new Set(item.targets)] as const) : []);
  const allowedTargets = new Set(packet.plannedWork.flatMap(p => p.targets));
  const pathLines = new Map(packet.canonical.map(c => [c.path, c.content.split("\n")]));
  const expectedCriteria = deliveryCriteria(packet.criteria.breadth === "whole-story" ? "full-story" : "revision",
    packet.contract);
  const witnessRoot: Record<string, string[]> = {
    "delivery:architecture": ["arcs/", "milestones/"],
    "delivery:interactive": ["events/", "choice-points/", "puzzles/"],
    "delivery:composition": ["authored-content/"],
    "delivery:complete-story": ["authored-content/"],
    "delivery:payoff": ["authored-content/"],
  };
  const stageWitness = (id: string, path: string): boolean => {
    if (!id.startsWith("milestone-plan:")) return true;
    const owner = /^milestone-plan:milestone\.[a-z0-9-]+:(local-event|event|interactive|composition):\d+$/
      .exec(id)?.[1];
    if (!owner) return false;
    if (owner === "event" || owner === "local-event") return path.startsWith("events/");
    if (owner === "interactive") return ["events/", "choice-points/", "puzzles/"]
      .some(prefix => path.startsWith(prefix));
    return path.startsWith("authored-content/");
  };
  const expectedIds = expectedCriteria.objectives.map(o => o.id);
  const packetObjectives = new Map(packet.objectives.map(o => [o.id, o.text]));
  if (JSON.stringify(packet.criteria) !== JSON.stringify(expectedCriteria) ||
      expectedIds.some(id => packetObjectives.get(id) !== expectedCriteria.objectives.find(o => o.id === id)?.text) ||
      packetObjectives.size !== packet.objectives.length ||
      !v || v.digest !== packet.digest || !["complete", "incomplete"].includes(v.verdict) ||
      !Array.isArray(v.checks) || !Array.isArray(v.findings) ||
      v.checks.length !== objectives.size ||
      new Set(v.checks.map(c => c.objectiveId)).size !== objectives.size ||
      v.checks.some(c => !objectives.has(c.objectiveId) || typeof c.fulfilled !== "boolean" ||
        !Array.isArray(c.evidence) || c.evidence.some(e =>
          !pathLines.has(e.path) || !Number.isSafeInteger(e.line) || e.line < 1 ||
          e.line > pathLines.get(e.path)!.length || !pathLines.get(e.path)![e.line - 1]?.trim() ||
          !e.explanation?.trim()) ||
        (c.fulfilled && (!c.evidence.length ||
          (c.objectiveId.startsWith("delivery:branch:") &&
            !c.evidence.some(e => (packet.criteria.depth === "architecture"
              ? ["arcs/", "milestones/"] : ["events/", "choice-points/", "puzzles/"])
              .some(p => e.path.startsWith(p)))) ||
          (witnessRoot[c.objectiveId] &&
            !c.evidence.some(e => witnessRoot[c.objectiveId]!.some(p => e.path.startsWith(p)))) ||
          (c.objectiveId.startsWith("milestone-plan:") &&
            !c.evidence.some(e => stageWitness(c.objectiveId, e.path)))))) ||
      v.findings.some(f => !objectives.has(f.objectiveId) || !f.message?.trim() ||
        (f.followUp !== null && (!f.followUp ||
          !(assignmentIds.has(f.followUp.assignmentId) ||
            adaptiveTargets.has(f.followUp.assignmentId)) || !f.followUp.outcome?.trim() ||
          !Array.isArray(f.followUp.targets) || !f.followUp.targets.length ||
          f.followUp.targets.some(t => !allowedTargets.has(t) ||
            (adaptiveTargets.has(f.followUp!.assignmentId) &&
              !adaptiveTargets.get(f.followUp!.assignmentId)!.has(t)))))) ||
      (v.verdict === "complete" && (v.findings.length > 0 ||
        v.checks.some(c => !c.fulfilled))) ||
      (v.verdict === "incomplete" && (!v.findings.length ||
        !v.checks.some(c => !c.fulfilled) ||
        v.checks.filter(c => !c.fulfilled).some(c =>
          !v.findings.some(f => f.objectiveId === c.objectiveId)))) )
    throw new Error("Plan-level reviewer returned missing, unsupported or stale fulfillment evidence.");
  return v;
}
export async function readTurnFulfillment(job: JobStartResult,
  packet: TurnFulfillmentPacket): Promise<TurnFulfillmentReceipt | null> {
  const receipt = await regular(receiptPath(job, packet));
  if (!receipt) return null;
  if (receipt.version !== 1 || receipt.policy !== packet.policy ||
      receipt.packetDigest !== packet.digest ||
      JSON.stringify(receipt.source) !== JSON.stringify(packet.source) ||
      !receipt.reviewer?.trim() || !["reviewing", "completed"].includes(receipt.phase) ||
      (receipt.phase === "completed" && !receipt.verdict) ||
      (receipt.phase === "reviewing" && !!receipt.verdict))
    throw new Error("Plan-level review receipt is stale or unauthoritative.");
  if (receipt.verdict) validateTurnFulfillment(packet, receipt.verdict);
  return receipt;
}
async function save(path: string, receipt: TurnFulfillmentReceipt) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
export async function assessTurnFulfillment(job: JobStartResult, report: JobReport,
  reviewer: string, evaluator: TurnFulfillmentEvaluator) {
  const packet = await prepareTurnFulfillment(job, turnFulfillmentContext(report));
  if (!packet) return null;
  if (!reviewer.trim()) throw new Error("Turn completeness needs an independent reviewer.");
  const path = receiptPath(job, packet);
  const prior = await readTurnFulfillment(job, packet);
  if (prior) {
    if (prior.phase !== "completed")
      throw new Error("Interrupted plan-level review is fenced; inspect the saved session before reconciliation.");
    return prior;
  }
  await mkdir(join(job.stateDir, "turn-fulfillment"), { recursive: true });
  const initial: TurnFulfillmentReceipt = { version: 1, policy: packet.policy,
    source: packet.source, packetDigest: packet.digest, reviewer, phase: "reviewing" };
  try { await writeFile(path, JSON.stringify(initial, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Concurrent plan-level review is already recorded; do not replay an evaluator.");
    throw error;
  }
  const verdict = validateTurnFulfillment(packet, await evaluator(structuredClone(packet), async file => {
    initial.sessionFile = file;
    await save(path, initial);
  }));
  // A model may have worked against mutable files. A new Story HEAD or
  // approved plan invalidates its work before the controller seals anything.
  const current = await prepareTurnFulfillment(job, turnFulfillmentContext(report));
  if (!current || current.digest !== packet.digest)
    throw new Error("Story or approved plan changed during Turn completeness review.");
  const final: TurnFulfillmentReceipt = { ...initial, phase: "completed", verdict };
  await save(path, final);
  return final;
}
