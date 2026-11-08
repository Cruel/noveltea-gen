import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readTurnEvidence, type TurnAssignmentEvidence } from "./turn-plan-evidence.js";
import { sealIndependentReview, type CheckpointAssurance, type IndependentReviewResult } from "./checkpoint-assurance.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_ITEMS = 8;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PATHS = 32;

export interface SemanticReviewItem {
  assignment: TurnAssignmentEvidence;
  assurance: CheckpointAssurance;
  diff: string;
  canonicalContext: Array<{ path: string; content: string }>;
}
export interface SemanticReviewPacket {
  policy: "assignment-fidelity/v1";
  sourceDigest: string;
  items: SemanticReviewItem[];
}
export interface SemanticFinding {
  commitSha: string;
  assignmentId: string;
  path: string;
  line: number;
  kind: "missing-requirement" | "unrequested-change" | "continuity" | "other";
  message: string;
}
export interface SemanticVerdict {
  sourceDigest: string;
  verdict: "pass" | "fail";
  findings: SemanticFinding[];
  evidence: Array<{ commitSha: string; assignmentId: string; path: string; line: number; explanation: string }>;
}

/** Model output is untrusted. An evaluator receives only this immutable packet;
 * no job, filesystem handle, controller capabilities or writer tools. */
export type SemanticEvaluator = (packet: Readonly<SemanticReviewPacket>) => Promise<unknown>;

function git(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_DIFF_BYTES + MAX_CONTEXT_BYTES });
}

function packetDigest(items: SemanticReviewItem[]) {
  return hash(JSON.stringify({ policy: "assignment-fidelity/v1", items }));
}

export async function prepareSemanticReview(job: JobStartResult,
  requested: RecoveryCheckpoint[]): Promise<SemanticReviewPacket> {
  if (!requested.length || requested.length > MAX_ITEMS)
    throw new Error("Semantic review group must be bounded to 1–8 checkpoints.");
  const saved = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.assurance);
  const planHint = JSON.parse(await readFile(join(job.stateDir, "turn-plan.json"), "utf8"));
  const plan = await readTurnEvidence(job, planHint.contract);
  if (!plan) throw new Error("Semantic reviewer requires the pinned original Turn.");
  const seen = new Set<string>();
  const items: SemanticReviewItem[] = [];
  for (const point of requested) {
    const assurance = point.assurance;
    const current = saved.find(p => p.commitSha === point.commitSha &&
      p.proofDigest === point.proofDigest);
    if (!assurance || !current || JSON.stringify(current.assurance) !== JSON.stringify(assurance) ||
        assurance.reviewSelection.status !== "required-pending" || seen.has(point.commitSha))
      throw new Error("Semantic review requires a unique validated, review-pending checkpoint.");
    seen.add(point.commitSha);
    if (assurance.turnDigest !== plan.digest || assurance.baseSha !== job.baseSha)
      throw new Error("Reviewer assignment or source baseline is stale.");
    const assignment = plan.assignments.find(a => a.id === assurance.assignmentId);
    if (!assignment) throw new Error("Pinned specialist assignment is absent.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const diff = git(job, "diff", "--no-ext-diff", "--unified=3",
      point.parentSha, point.commitSha, "--", ...assurance.changedPaths.map(p => prefix + p));
    if (!diff || Buffer.byteLength(diff) > MAX_DIFF_BYTES ||
        hash(git(job, "diff", "--binary", "--no-ext-diff", point.parentSha, point.commitSha)) !== assurance.diffDigest)
      throw new Error("Reviewer Git diff differs from the validated source.");
    const dependencies = plan.assignments.filter(a => assignment.dependsOn.includes(a.id));
    const paths = [...new Set([...assurance.changedPaths, ...assignment.authority.existingPaths,
      ...dependencies.flatMap(a => a.authority.existingPaths)])];
    if (paths.length > MAX_PATHS) throw new Error("Reviewer context exceeds bounded path count.");
    const canonicalContext = paths.map(path => {
      if (!/^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(path))
        throw new Error("Reviewer context contains an unsafe Story path.");
      let content: string;
      try { content = git(job, "show", point.commitSha + ":" + prefix + path); }
      catch {
        // A missing record is valid for an authorized creation. A missing
        // previously owned record is not permission to silently omit context.
        if (assurance.changedPaths.includes(path) && assignment.authority.mayCreate)
          content = "[Record absent at this checkpoint]";
        else throw new Error("Pinned canonical review context is missing: " + path);
      }
      return { path, content };
    });
    if (Buffer.byteLength(JSON.stringify(canonicalContext)) > MAX_CONTEXT_BYTES)
      throw new Error("Reviewer canonical context exceeds bounded size.");
    items.push({ assignment, assurance, diff, canonicalContext });
  }
  // Group only commits on a single ancestry chain. Unrelated branches and
  // unrelated assignment batches are never silently combined.
  for (let i = 1; i < items.length; i++) {
    if (!items[i]!.assignment.dependsOn.includes(items[i - 1]!.assignment.id) &&
        !items[i - 1]!.assignment.dependsOn.includes(items[i]!.assignment.id) &&
        !items[i]!.assignment.targets.some(t => items[i - 1]!.assignment.targets.includes(t)))
      throw new Error("Group review requires related specialist assignments.");
    git(job, "merge-base", "--is-ancestor", items[i - 1]!.assurance.commitSha,
      items[i]!.assurance.commitSha);
  }
  return { policy: "assignment-fidelity/v1", sourceDigest: packetDigest(items), items };
}

export function validateSemanticVerdict(packet: SemanticReviewPacket, raw: unknown): SemanticVerdict {
  const verdict = raw as SemanticVerdict;
  if (!verdict || verdict.sourceDigest !== packet.sourceDigest ||
      !["pass", "fail"].includes(verdict.verdict) ||
      !Array.isArray(verdict.findings) || !Array.isArray(verdict.evidence) ||
      verdict.findings.length > 100 || verdict.evidence.length > 100)
    throw new Error("Semantic reviewer returned malformed or stale findings.");
  const belongs = (sha: string, id: string, path: string, line: number) =>
    packet.items.some(item => item.assurance.commitSha === sha && item.assignment.id === id &&
      item.assurance.changedPaths.includes(path) &&
      Number.isSafeInteger(line) && line > 0 &&
      item.canonicalContext.some(c => c.path === path &&
        line <= c.content.split("\n").length));
  if (verdict.findings.some(f => !f || !belongs(f.commitSha, f.assignmentId, f.path, f.line) ||
        !["missing-requirement", "unrequested-change", "continuity", "other"].includes(f.kind) ||
        typeof f.message !== "string" || !f.message.trim()) ||
      verdict.evidence.some(e => !e || !belongs(e.commitSha, e.assignmentId, e.path, e.line) ||
        typeof e.explanation !== "string" || !e.explanation.trim()) ||
      (verdict.verdict === "pass" && verdict.findings.length > 0) ||
      (verdict.verdict === "fail" && !verdict.findings.length) ||
      packet.items.some(item =>
        !verdict.evidence.some(e => e.commitSha === item.assurance.commitSha &&
          e.assignmentId === item.assignment.id) &&
        !verdict.findings.some(f => f.commitSha === item.assurance.commitSha &&
          f.assignmentId === item.assignment.id)))
    throw new Error("Semantic reviewer lacks assignment-specific, source-linked evidence.");
  return verdict;
}

/** Independent evaluator is not allowed to seal or write. Only the controller
 * converts verified findings to immutable per-checkpoint review receipts. */
export async function reviewBoundedAssignments(job: JobStartResult,
  points: RecoveryCheckpoint[], evaluator: SemanticEvaluator, reviewer: string,
  seal = false): Promise<{ packet: SemanticReviewPacket; verdict: SemanticVerdict }> {
  if (!reviewer.trim()) throw new Error("Independent reviewer identity is required.");
  const packet = await prepareSemanticReview(job, points);
  const verdict = validateSemanticVerdict(packet, await evaluator(structuredClone(packet)));
  if (seal) {
    for (const item of packet.items) {
      const findings = verdict.findings.filter(f => f.commitSha === item.assurance.commitSha &&
        f.assignmentId === item.assignment.id);
      const result: IndependentReviewResult = {
        version: 1,
        source: { jobId: item.assurance.jobId, commitSha: item.assurance.commitSha,
          turnDigest: item.assurance.turnDigest, assignmentId: item.assurance.assignmentId,
          assignmentDigest: item.assurance.assignmentDigest, diffDigest: item.assurance.diffDigest,
          validationProofDigest: item.assurance.validationProofDigest },
        reviewer, status: findings.length ? "failed" : "passed",
        findings: findings.map(f => ({ path: f.path, message: f.path + ":" + f.line + " " + f.message })),
        evidence: JSON.stringify({ policy: packet.policy, sourceDigest: packet.sourceDigest,
          evidence: verdict.evidence.filter(e => e.commitSha === item.assurance.commitSha &&
            e.assignmentId === item.assignment.id) }),
      };
      const point = points.find(p => p.commitSha === item.assurance.commitSha)!;
      await sealIndependentReview(job, point, result);
    }
  }
  return { packet, verdict };
}

/** Production adapter, deliberately separate from the controller receipt
 * writer. Pi only obtains read-only narrative-review tools. */
export async function runPiAssignmentReview(job: JobStartResult,
  points: RecoveryCheckpoint[], options: {
    snapshot: import("./snapshot.js").SkillSnapshot;
    provider: string; model: string; thinking?: "low" | "high";
    onSession: (file: string) => Promise<void>;
    reviewer: string; seal?: boolean;
  }) {
  const { reviewSpecialistAssignments } = await import("./narrative-review-specialist.js");
  return reviewBoundedAssignments(job, points,
    packet => reviewSpecialistAssignments(job, options.snapshot, packet,
      options.provider, options.model, options.thinking, options.onSession),
    options.reviewer, options.seal ?? true);
}
