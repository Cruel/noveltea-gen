import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { JobReport } from "./job-report.js";
import { verifyPlanHistory, type Plan } from "./architecture.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readTurnEvidence, type TurnEvidence } from "./turn-plan-evidence.js";
import { assertTurnDeliveryHistory, deliveryCriteria, type NarrativeDeliveryCriteria } from "./turn-delivery.js";

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
  plannedWork: Array<{ id: string; kind: string; targets: string[]; status: string }>;
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
  const path = join(job.stateDir, "turn-plan.json");
  if (!existsSync(path)) return null; // Explicit legacy CLI contracts are not per-Turn plans.
  if (git(job, "rev-parse", "HEAD").trim() !== job.headSha)
    throw new Error("Story HEAD changed since the controller verified the Turn.");
  const saved = JSON.parse(await readFile(path, "utf8")) as TurnEvidence;
  const turn = await readTurnEvidence(job, saved.contract);
  if (!turn || turn.kind === "protected-amendment") return null;
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
  const paths = [...new Set([
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
  ];
  const source = { jobId: job.jobId, baseSha: job.baseSha, headSha: job.headSha,
    turnDigest: turn.digest, planVersion: arch.plan.version, planDigest: hash(arch.plan),
    scopeReviewDigest: hash(scopeReview), checkpoints };
  const body = { policy: "turn-completeness/v1" as const, source, goal: turn.goal,
    originalRequest: turn.originalRequest, contract: turn.contract,
    approvedContract: arch.plan.contract, criteria, objectives,
    plannedWork: arch.plan.items.map(i => ({ id: i.id, kind: i.kind,
      targets: i.targetIds, status: i.status })), canonical };
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
            !c.evidence.some(e => witnessRoot[c.objectiveId]!.some(p => e.path.startsWith(p))))))) ||
      v.findings.some(f => !objectives.has(f.objectiveId) || !f.message?.trim() ||
        (f.followUp !== null && (!f.followUp ||
          !assignmentIds.has(f.followUp.assignmentId) || !f.followUp.outcome?.trim() ||
          !Array.isArray(f.followUp.targets) || !f.followUp.targets.length ||
          f.followUp.targets.some(t => !allowedTargets.has(t))))) ||
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
