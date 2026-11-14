import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSealedReviewContext, type SealedReviewRecord } from "./sealed-review-context.js";
import { reviewRepairTargets } from "./review-repair-amendment.js";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readTurnEvidence, type TurnAssignmentEvidence } from "./turn-plan-evidence.js";
import { sealIndependentReview, repairReviewAssignment,
  type CheckpointAssurance, type IndependentReviewResult } from "./checkpoint-assurance.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_ITEMS = 8;
const MAX_DIFF_BYTES = 128 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;

export interface SemanticReviewItem {
  assignment: TurnAssignmentEvidence;
  /** Exact committed unit; one Turn assignment can consist of multiple staged specialists. */
  reviewedWorkItem: string;
  unitOutcome: string;
  assurance: CheckpointAssurance;
  diff: string;
  /** Changed records are assurance.changedPaths; context membership NEVER grants writes. */
  canonicalContext: SealedReviewRecord[];
  /** Read-only sources include protected changed records which repair cannot edit. */
  readOnlyPaths: string[];
  /** Ceiling only: the repair controller must still authorize an amendment. */
  repairTargets: string[];
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
  /** Narrative or causal failure observed at the pinned source line. */
  message: string;
  /** Specific edit required to satisfy the assignment, not a generic retry. */
  requiredCorrection: string;
  /** Source records implicated by the defect. Only the changed path is writable. */
  affectedPaths: string[];
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

/** Review only the work actually authorized at this durable checkpoint.
 * Parent Turn goals still belong to the following units and final Turn review. */
export function semanticUnitOutcome(workItem: string, specialist?: string): string {
  if (workItem.startsWith("repair-") && specialist === "nt-event-design")
    return (
      "Correction of the original Event assignment only: no new paths, owner changes or protected writes. " +
      "Assess the corrected committed evidence against the original Milestone promise and source-linked findings. " +
      "Reject unsupported evidence-to-effect links; do not require future Choice or Composition work."
    );
  if (workItem === "global-architecture") return "Architecture planning only: Arc and Milestone prose must establish a causally coherent chain of selected turning points, not isolated dramatic labels. Require each Milestone's substantive enabling condition and resulting progression into a later Milestone (or its terminal aftermath) to be articulated in the source; generic promises that Events will discover the causes later are insufficient. However a planning-stage partial Milestone MUST have fulfillment.any_of: [] until actual Events exist; do NOT demand speculative Event IDs, Event prerequisites, completed fulfillment, concrete Choice/Puzzle instances, Character baselines, or Authored Content at this checkpoint. Those are separate downstream specialists. Review the actual approved scope, preserve creative uncertainty and reject unexplained plot jumps or contradictory Milestone ordering.";
  if (workItem === "world-foundations") return "World Foundations only: world entities, setting and relevant objective Facts. Character and relationship records are the NEXT separately committed character-foundations unit. Do not fail World Foundations solely for not writing Characters or relationships; do fail missing or contradictory World Foundations.";
  if (workItem === "character-foundations") return "Character Foundations: concrete Character and Relationship records required by the approved story architecture and existing World Foundations. The stage-specific Character specialist is ALSO authorized to extend ONLY the existing, planned Arc's characters array to link newly written Characters, preserving every other Arc field and all prose. The independent Character/World controller already checks this exact before/after Arc restriction and rejects unrelated Arc edits. Treat a verified link-only Arc update as a legitimate supporting change even though the high-level Turn assignment recordTypes lists character/relationship ownership; that simplified list is not a stricter replacement for the stage-specific writer contract. Reject any Arc body, decision, plot, or other-field edit. Review Character and Relationship obligations now; missing central Characters are a failure.";
  if (workItem.startsWith("event-"))
    return (
      "One source-bound Event-design Milestone cluster only. " +
      "The verified Event writer may author Events and connected new Facts/Revelations, plus " +
      "only the selected Milestone's completeness/fulfillment fields when justified by real routes. " +
      "The high-level Turn assignment.recordTypes=[event] does not override that narrower stage contract. " +
      "Reject unrelated records, protected retcons, false fulfillment, unwitnessed inference or typed " +
      "effects not supported by actual reachable evidence BEFORE relying on them. A complete Event " +
      "setup may legitimately leave a decision-dependent Milestone partial until the later Choice unit; " +
      "neither Choice binding nor final Composition belongs to this checkpoint."
    );
  if (workItem.startsWith("interactive-choice-")) return "Choice-point unit only. The stage-specific verified Choice author may write a Choice Point, the causal outcome effects/branches in connected existing Events (without changing their prerequisites), and player-facing Authored Content for the choice. The high-level Turn recordTypes=[choice-point,puzzle] is specialist ownership, not the exclusive file whitelist; reject unrelated or protected changes. Puzzle authoring, if planned, is a separate later interactive-puzzle unit, not a missing requirement in this checkpoint. Inspect actual branch consequences and later consumers.";
  if (workItem.startsWith("interactive-puzzle-")) return "Puzzle unit only. The stage-specific verified Puzzle author may add a connected Puzzle, accessible pre-solution clue Authored Content, and bounded new solution Events; existing Choice outcomes and original Event prerequisites remain immutable. The high-level Turn recordTypes is not an exclusive file whitelist. Assess real solvability, prerequisite accessibility, distinct consequences and fair-play clues; reject unrelated/unauthorized files or retcons. The preceding Choice unit was reviewed separately.";
  return "Review the exact committed work item against the author-approved assignment and its dependencies; defer only work explicitly assigned to later units.";
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
    const original = plan.assignments.find(a => a.id === assurance.assignmentId);
    if (!original) throw new Error("Pinned specialist assignment is absent.");
    const assignment = await repairReviewAssignment(job, point.workItem, original);
    if (hash(JSON.stringify(assignment)) !== assurance.assignmentDigest)
      throw new Error("Reviewer received a changed or unauthorized assignment version.");
    const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
    const diff = git(job, "diff", "--no-ext-diff", "--unified=3",
      point.parentSha, point.commitSha, "--", ...assurance.changedPaths.map(p => prefix + p));
    if (!diff || Buffer.byteLength(diff) > MAX_DIFF_BYTES ||
        hash(git(job, "diff", "--binary", "--no-ext-diff", point.parentSha, point.commitSha)) !== assurance.diffDigest)
      throw new Error("Reviewer Git diff differs from the validated source.");
    const dependencies = plan.assignments.filter(a => assignment.dependsOn.includes(a.id));
    // Creation-stage dependency assignments have no existingPaths. Their
    // verified committed outputs are causal context too, never new grants.
    const dependencyPaths = saved.filter(p => p.assurance?.turnDigest === plan.digest &&
      dependencies.some(a => a.id === p.assurance?.assignmentId)).flatMap(p => {
      try { git(job, "merge-base", "--is-ancestor", p.commitSha, point.commitSha); }
      catch { return []; }
      return p.assurance!.changedPaths;
    });
    const paths = [...new Set([...assurance.changedPaths, ...assignment.authority.existingPaths,
      ...dependencies.flatMap(a => a.authority.existingPaths), ...dependencyPaths])];
    const canonicalContext = await loadSealedReviewContext(job, point.commitSha, paths);
    const repairTargets = reviewRepairTargets(assurance.changedPaths, point.workItem);
    const readOnlyPaths = canonicalContext.map(c => c.path).filter(p => !repairTargets.includes(p));
    items.push({ assignment, reviewedWorkItem: point.workItem,
      unitOutcome: semanticUnitOutcome(point.workItem, assignment.specialist), assurance, diff, canonicalContext,
      readOnlyPaths, repairTargets });
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

/** Correct only an unambiguous near-complete (32–39 hex chars) omission in a
 * PASS review's evidence SHA after the read-only Pi correction turn. A model
 * can omit a run of repeated hex characters while copying a 40-char SHA.
 * The reviewer must have
 * supplied the assignment, actual changed path, valid line and explanation.
 * Never replace a full-length (possibly stale/foreign) SHA, infer a missing
 * citation, repair a negative finding, or bypass validateSemanticVerdict. */
export function normalizeOmittedSemanticEvidenceSha(packet: SemanticReviewPacket,
  raw: unknown): unknown {
  const value = raw as Partial<SemanticVerdict> | null;
  if (!value || value.sourceDigest !== packet.sourceDigest || value.verdict !== "pass" ||
      !Array.isArray(value.findings) || value.findings.length !== 0 ||
      !Array.isArray(value.evidence)) return raw;
  let fixed = false;
  const evidence = value.evidence.map(entry => {
    if (!entry || typeof entry.commitSha !== "string" ||
        !/^[a-f0-9]{32,39}$/.test(entry.commitSha) ||
        typeof entry.assignmentId !== "string" || typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.line) || entry.line < 1) return entry;
    const candidates = packet.items.filter(item => {
      if (item.assignment.id !== entry.assignmentId ||
          !item.assurance.changedPaths.includes(entry.path) ||
          !item.canonicalContext.some(c => c.path === entry.path &&
            entry.line <= c.content.split("\n").length)) return false;
      const expected = item.assurance.commitSha;
      if (!/^[a-f0-9]{40}$/.test(expected)) return false;
      let index = 0;
      for (const char of expected) if (entry.commitSha[index] === char) index++;
      return index === entry.commitSha.length;
    });
    if (candidates.length !== 1) return entry;
    fixed = true;
    return { ...entry, commitSha: candidates[0]!.assurance.commitSha };
  });
  return fixed ? { ...value, evidence } : raw;
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
        typeof f.message !== "string" || !f.message.trim() || f.message.length > 2000 ||
        typeof f.requiredCorrection !== "string" ||
        f.requiredCorrection.trim().length < 16 || f.requiredCorrection.length > 2000 ||
        /^(?:retry|try again|fix it|redo|improve it)[.!\s]*$/i.test(f.requiredCorrection) ||
        !Array.isArray(f.affectedPaths) || !f.affectedPaths.length || f.affectedPaths.length > 12 ||
        !f.affectedPaths.includes(f.path) || new Set(f.affectedPaths).size !== f.affectedPaths.length ||
        f.affectedPaths.some(path => !packet.items.find(item =>
          item.assurance.commitSha === f.commitSha && item.assignment.id === f.assignmentId)?.canonicalContext
          .some(record => record.path === path))) ||
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
        findings: findings.map(f => ({ path: f.path, message: f.path + ":" + f.line + " " + f.message,
          kind: f.kind, line: f.line, affectedPaths: f.affectedPaths,
          requiredCorrection: f.requiredCorrection })),
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
