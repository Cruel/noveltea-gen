import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSealedReviewContext, type SealedReviewRecord } from "./sealed-review-context.js";
import { reviewRepairTargets } from "./review-repair-amendment.js";
import { CHOICE_PAYOFF_REVIEW } from "./choice-payoff-guidance.js";
import { PUZZLE_GOAL_REVIEW } from "./puzzle-goal-fidelity.js";
import { eventConsequenceProofDigest,
  type EventConsequenceProof } from "./event-consequence-proof.js";
import type { JobStartResult } from "./job.js";
import type { RecoveryCheckpoint } from "./recovery-checkpoints.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { type TurnAssignmentEvidence } from "./turn-plan-evidence.js";
import { readReviewTurnEvidence } from "./fork-review-turn.js";
import { sealIndependentReview, inspectCheckpointReview, repairReviewAssignment, readRepairCommitProof,
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
  /** Signed Event correction exception; no other Milestone fields may change. */
  eventMilestoneFieldGrant?: { id: string; path: string;
    fields: ["completeness", "fulfillment"] };
  /** Advisory inventory from the native-validated Event checkpoint, not a verdict. */
  eventConsequenceProof?: EventConsequenceProof;
  /** Historical failed promise, not an additional grant or inherited verdict. */
  rejectedEventComparison?: { sourceCommitSha: string; findings: IndependentReviewResult["findings"];
    originalProof: EventConsequenceProof };
  /** Every repaired specialist, not just Events, is reviewed against the
   * original sealed failure and the previous attempted correction. */
  priorNegative?: { sourceCommitSha: string; rootFailureSha: string;
    reviewDigest: string; findings: IndependentReviewResult["findings"];
    completedCorrections: number };
}
export interface ReviewDisputeClaim {
  sourceSha: string;
  reviewDigest: string;
  path: string;
  line: number;
  claim: string;
}
export interface SemanticReviewPacket {
  policy: "assignment-fidelity/v1";
  sourceDigest: string;
  items: SemanticReviewItem[];
  /** Independent adjudication is advisory and cannot erase a sealed failure. */
  dispute?: { negativeFindings: IndependentReviewResult["findings"];
    sourceSha: string; claim: string; path: string; line: number };
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

function packetDigest(items: SemanticReviewItem[], dispute?: SemanticReviewPacket["dispute"]) {
  return hash(JSON.stringify({ policy: "assignment-fidelity/v1", items,
    ...(dispute ? { dispute } : {}) }));
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
  if (workItem === "global-architecture") return "Architecture planning only: Arc and Milestone prose must establish a causally coherent chain of selected turning points, not isolated dramatic labels. Require each Milestone's substantive enabling condition and resulting progression into a later Milestone (or its terminal aftermath) to be articulated in the source; generic promises that Events will discover the causes later are insufficient. However a planning-stage partial Milestone MUST have fulfillment.any_of: [] until actual Events exist; do NOT demand speculative Event IDs, Event prerequisites, completed fulfillment, concrete Choice/Puzzle instances, Character baselines, or Authored Content at this checkpoint. Those are separate downstream specialists. Review the actual approved scope and canonical Creative Direction planning: across the WHOLE Story evaluate meaningful Choice frequency/impact, branching depth versus route-exclusive content, Adventure versus Custom Puzzle emphasis, and Narrative/Exploration playthrough pacing. An observational/short VN may legitimately have zero Puzzles and rare Choices; a Choice-heavy/deep-divergence brief cannot pass with one token late Choice. Require credible Milestone duration assumptions without fabricating exact route totals; flag source-backed hard Production limit breaches, missing estimates and material soft-budget expansion for author direction. A modest justified soft variance is a warning, not silent new authorization. Favor recurring cast/illustration concepts/narrative locations where sound, but preserve route-exclusive characters/scenes and stateful consequences after reconvergence. Never impose per-Milestone interaction quotas, a three-Act pattern or engine Room translation. Preserve creative uncertainty and reject unexplained plot jumps or contradictory Milestone ordering.";
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
  if (workItem.startsWith("interactive-choice-")) return "Choice-point unit only. The stage-specific verified Choice author may write a Choice Point, the causal outcome effects/branches in connected existing Events (without changing their prerequisites), and player-facing Authored Content for the choice. The high-level Turn recordTypes=[choice-point,puzzle] is specialist ownership, not the exclusive file whitelist; reject unrelated or protected changes. Puzzle authoring, if planned, is a separate later interactive-puzzle unit, not a missing requirement in this checkpoint. Inspect actual branch consequences and later consumers. " + CHOICE_PAYOFF_REVIEW;
  if (workItem.startsWith("interactive-puzzle-")) return "Puzzle unit only. The stage-specific verified Puzzle author may add a connected Puzzle, accessible pre-solution clue Authored Content, and bounded new solution Events; existing Choice outcomes and original Event prerequisites remain immutable. The high-level Turn recordTypes is not an exclusive file whitelist. Assess real solvability, prerequisite accessibility, distinct consequences and fair-play clues; reject unrelated/unauthorized files or retcons. The preceding Choice unit was reviewed separately. " + PUZZLE_GOAL_REVIEW;
  return "Review the exact committed work item against the author-approved assignment and its dependencies; defer only work explicitly assigned to later units.";
}

export async function prepareSemanticReview(job: JobStartResult,
  requested: RecoveryCheckpoint[], challenge?: ReviewDisputeClaim): Promise<SemanticReviewPacket> {
  if (!requested.length || requested.length > MAX_ITEMS)
    throw new Error("Semantic review group must be bounded to 1–8 checkpoints.");
  const saved = (await inspectRecoveryCheckpoints(job)).filter(p => p.eligible && p.assurance);
  const plan = await readReviewTurnEvidence(job);
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
    const { adaptiveReviewBinding } = await import("./adaptive-review-binding.js");
    const refinement = await adaptiveReviewBinding(job, plan.digest, point.planVersion,
      point.parentSha, point.workItem);
    if (JSON.stringify(refinement) !== JSON.stringify(assurance.adaptiveReview ?? null))
      throw new Error("Independent reviewer refinement differs from the original sealed checkpoint.");
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
    // New and existing Stories may use ANY canonical Creative Direction stem.
    // Bind the read-only baseline to the exact reviewed commit, not a guessed
    // filename or mutable filesystem lookup. This adds no repair write grant.
    const direction = point.workItem === 'global-architecture'
      ? git(job, 'ls-tree', '-r', '--name-only', point.commitSha, '--',
        prefix + 'creative-direction/').split('\n').filter(Boolean)
        .filter(path => path.startsWith(prefix + 'creative-direction/'))
        .map(path => path.slice(prefix.length)) : [];
    if (point.workItem === 'global-architecture' && (direction.length !== 1 ||
      !/^creative-direction\/[a-z0-9][a-z0-9._-]*\.md$/.test(direction[0]!)))
      throw new Error('Independent Architecture review needs one pinned canonical Creative Direction.');
    const paths = [...new Set([...assurance.changedPaths, ...assignment.authority.existingPaths,
      ...dependencies.flatMap(a => a.authority.existingPaths), ...dependencyPaths, ...direction])];
    const canonicalContext = await loadSealedReviewContext(job, point.commitSha, paths);
    let eventMilestone: import("./review-repair-amendment.js").EventMilestoneRepairGrant | undefined;
    if (point.workItem.startsWith("repair-")) {
      const source = point.workItem.slice(7);
      if (!/^[a-f0-9]{40}$/.test(source)) throw Error("Unsafe reviewed repair source.");
      const repair = JSON.parse(await readFile(join(job.stateDir, "review-repairs",
        source + ".json"), "utf8")) as {
        sourceCommitSha?: string;
        planAmendment?: { digest?: string; eventMilestone?: typeof eventMilestone };
      };
      const proof = await readRepairCommitProof(job, point.workItem);
      if (repair.sourceCommitSha !== source || !repair.planAmendment?.digest ||
          (proof.repairPlanDigest !== undefined
            ? repair.planAmendment.digest !== proof.repairPlanDigest
            : repair.planAmendment.eventMilestone !== undefined))
        throw Error("Reviewed Milestone repair has no signed source-bound field grant.");
      eventMilestone = repair.planAmendment.eventMilestone;
    }
    const repairTargets = reviewRepairTargets(assurance.changedPaths,
      eventMilestone ? "event-" + eventMilestone.id.slice("milestone.".length) : point.workItem,
      eventMilestone);
    const readOnlyPaths = canonicalContext.map(c => c.path).filter(p => !repairTargets.includes(p));
    let eventConsequenceProof: EventConsequenceProof | undefined;
    let milestoneBlueprintObligations = "";
    if (point.workItem.startsWith("event-")) {
      const slug = point.workItem.slice("event-".length);
      if (/^[a-z][a-z0-9-]*$/.test(slug)) {
        const file = join(job.stateDir, "event-items", slug + ".json");
        try {
          const receipt = JSON.parse(await readFile(file, "utf8")) as {
            commitSha?: string; expectedHead?: string; consequenceProof?: EventConsequenceProof;
            blueprintPin?: import("./milestone-blueprint.js").MilestoneBlueprintPin;
            assignment?: import("./event-specialist.js").EventAssignment };
          if (receipt.commitSha === point.commitSha && receipt.expectedHead === point.parentSha &&
              receipt.blueprintPin) {
            if (!receipt.assignment || !git(job, "log", "-1", "--format=%B", point.commitSha)
              .split("\n").includes("NovelTea-Milestone-Blueprint: " + receipt.blueprintPin.digest))
              throw Error("Reviewed Event lost its source-bound Milestone planning handoff.");
            const { readReviewedMilestoneBlueprint } = await import("./milestone-blueprint.js");
            const local = await readReviewedMilestoneBlueprint(job, receipt.blueprintPin, receipt.assignment);
            milestoneBlueprintObligations = "\nINDEPENDENTLY REVIEWED PRIVATE MILESTONE OBLIGATIONS: " +
              JSON.stringify(local) + ". Check actual committed Event evidence against current-stage " +
              "local promises; defer only named interactive/Composition obligations. " +
              "The private plan is NOT canonical Story proof and grants NO additional write scope.";
          }
          // A later Event receipt or an old checkpoint never supplies evidence
          // for this exact reviewed SHA. The sealed sources remain primary.
          if (receipt.commitSha === point.commitSha &&
              receipt.expectedHead === point.parentSha &&
              receipt.consequenceProof?.version === 1 &&
              receipt.consequenceProof.milestone.id === "milestone." + slug &&
              git(job, "log", "-1", "--format=%B", point.commitSha).split("\n")
                .includes("NovelTea-Event-Consequence: " +
                  eventConsequenceProofDigest(receipt.consequenceProof)) &&
              Array.isArray(receipt.consequenceProof.sourceHashes) &&
              receipt.consequenceProof.sourceHashes.every(source => {
                const record = canonicalContext.find(record => record.path === source.path);
                return !record || hash(record.content) === source.sha256;
              }) &&
              receipt.consequenceProof.events.every(event =>
                canonicalContext.some(record => record.path === event.path &&
                  event.outcomes.every(outcome => outcome.effects.every(effect =>
                    record.content.split(/\r?\n/)[effect.line - 1]?.includes("kind: " + effect.kind))))))
            eventConsequenceProof = receipt.consequenceProof;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    // A postcommit review must receive the same authenticated local obligations
    // that guided its writer. A specialist's self-reported "laterObligations"
    // cannot erase a reviewed downstream owner at this boundary.
    const localStage = /^(interactive-choice|interactive-puzzle|composition)-([a-z][a-z0-9-]*)$/
      .exec(point.workItem);
    if (localStage) {
      const [, stage, slug] = localStage;
      const milestoneId = "milestone." + slug;
      const stageFile = stage === "composition"
        ? join(job.stateDir, "composition-items", slug + ".json")
        : join(job.stateDir, "interactive-items", slug + ".json");
      const stageReceipt = JSON.parse(await readFile(stageFile, "utf8")) as {
        jobId: string; milestoneId: string; commitSha?: string; eventHead?: string;
        units?: Array<{ id: string; commitSha?: string }>;
      };
      const unit = stage === "composition" ? stageReceipt :
        stageReceipt.units?.find(item => item.id === point.workItem);
      if (stageReceipt.jobId !== job.jobId || stageReceipt.milestoneId !== milestoneId ||
          unit?.commitSha !== point.commitSha)
        throw Error("Independent downstream Milestone review lost its authenticated work item.");
      const source = JSON.parse(await readFile(join(job.stateDir, "event-items",
        slug + ".json"), "utf8")) as import("./milestone-obligation-handoff.js").MilestoneEventSource;
      const { reviewedMilestoneHandoff } = await import("./milestone-obligation-handoff.js");
      const handoff = await reviewedMilestoneHandoff(job, source);
      if (handoff) {
        git(job, "merge-base", "--is-ancestor", handoff.eventHead, point.commitSha);
        if (stage !== "composition" && stageReceipt.eventHead !== handoff.eventHead)
          throw Error("Interactive Milestone review lost its original Event baseline.");
        milestoneBlueprintObligations = "\nREVIEWED MILESTONE STAGE OBLIGATIONS (" +
          handoff.pin.digest + ", Event source " + handoff.eventHead + "): " +
          JSON.stringify(handoff.design) + ". Evaluate the actual committed canonical " +
          (stage === "composition" ? "prose, Events and conditional outcome knowledge" :
            "reachable Choice/Puzzle, clue-access routes and downstream consequences") +
          " for this specialist's named owner obligations. Defer other owners only; " +
          "private provisional plans and writer reports are not proof or write authority.";
      }
    }
    let priorNegative: SemanticReviewItem["priorNegative"];
    if (point.workItem.startsWith("repair-")) {
      const sourceSha = point.workItem.slice("repair-".length);
      if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error("Unsafe correction source identity.");
      const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
      const prior = await inspectRejectedRepair(job, sourceSha);
      if (prior.repairedCommitSha !== point.commitSha ||
          (challenge?.sourceSha === point.commitSha
            ? !["failed", "blocked"].includes(prior.phase)
            : prior.phase !== "reviewing"))
        throw Error("Independent successor review lost its sealed correction context.");
      priorNegative = { sourceCommitSha: sourceSha, rootFailureSha: prior.rootFailureSha,
        reviewDigest: prior.sourceReviewDigest, findings: prior.findings,
        completedCorrections: prior.attempts };
    }
    let rejectedEventComparison: SemanticReviewItem["rejectedEventComparison"];
    if (point.workItem.startsWith("repair-") && assignment.specialist === "nt-event-design") {
      const sourceCommitSha = point.workItem.slice("repair-".length);
      if (/^[a-f0-9]{40}$/.test(sourceCommitSha)) {
        const repairFile = join(job.stateDir, "review-repairs", sourceCommitSha + ".json");
        const repair = JSON.parse(await readFile(repairFile, "utf8")) as {
          sourceCommitSha: string; findings: IndependentReviewResult["findings"];
          origin: { workItem: string } };
        if (repair.sourceCommitSha !== sourceCommitSha ||
            !repair.origin.workItem.startsWith("event-"))
          throw Error("Repaired Event review lost its original rejected assignment.");
        const slug = repair.origin.workItem.slice("event-".length);
        if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw Error("Unsafe original Event work item.");
        const originFile = join(job.stateDir, "event-items", slug + ".json");
        const origin = JSON.parse(await readFile(originFile, "utf8")) as {
          commitSha?: string; consequenceProof?: EventConsequenceProof };
        if (origin.commitSha === sourceCommitSha && origin.consequenceProof?.version === 1 &&
            git(job, "log", "-1", "--format=%B", sourceCommitSha).split("\n")
              .includes("NovelTea-Event-Consequence: " +
                eventConsequenceProofDigest(origin.consequenceProof)))
          rejectedEventComparison = { sourceCommitSha, findings: repair.findings,
            originalProof: origin.consequenceProof };
      }
    }
    items.push({ assignment, reviewedWorkItem: point.workItem,
      unitOutcome: semanticUnitOutcome(point.workItem, assignment.specialist) + milestoneBlueprintObligations +
        (refinement ? " Additional controller-admitted, source-bound assignment outcome (" +
          refinement.item + ", " + (refinement.sourcePath ?? "verified Architecture") + " at " + refinement.sourceSha +
          "): " + refinement.outcome +
          ". Judge its applicable part in THIS unit against the committed evidence; " +
          "this text grants no additional path, domain or protected-decision authority." : ""),
      assurance, diff, canonicalContext,
      readOnlyPaths, repairTargets,
      ...(eventMilestone ? { eventMilestoneFieldGrant: { ...eventMilestone,
        fields: ["completeness", "fulfillment"] as ["completeness", "fulfillment"] } } : {}),
      ...(eventConsequenceProof ? { eventConsequenceProof } : {}),
      ...(rejectedEventComparison ? { rejectedEventComparison } : {}),
      ...(priorNegative ? { priorNegative } : {}) });
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
  let dispute: SemanticReviewPacket["dispute"];
  if (challenge) {
    if (requested.length !== 1 || requested[0]!.commitSha !== challenge.sourceSha ||
        !/^[a-f0-9]{40}$/.test(challenge.sourceSha) ||
        !/^[a-f0-9]{64}$/.test(challenge.reviewDigest) ||
        !Number.isSafeInteger(challenge.line) || challenge.line < 1 ||
        typeof challenge.claim !== "string" || !challenge.claim.trim() || challenge.claim.length > 1000)
      throw Error("Adjudication is not bound to one sealed failed review.");
    const sealed = await inspectCheckpointReview(job, requested[0]!);
    if (sealed?.status !== "failed" || !sealed.result ||
        hash(JSON.stringify(sealed.result)) !== challenge.reviewDigest ||
        !sealed.result.findings.some(f => f.path === challenge.path && f.line === challenge.line))
      throw Error("Disputed claim does not identify the exact sealed negative evidence.");
    dispute = { sourceSha: challenge.sourceSha, claim: challenge.claim,
      path: challenge.path, line: challenge.line, negativeFindings: sealed.result.findings };
  }
  return { policy: "assignment-fidelity/v1", sourceDigest: packetDigest(items, dispute),
    items, ...(dispute ? { dispute } : {}) };
}

/** Correct only unambiguous transcription errors in a PASS review's evidence
 * SHA after the read-only Pi correction turn: omitted hex chars (32–39) or a
 * contiguous duplicated span (41–80). Never replace a full-length possibly
 * stale/foreign SHA, invent a citation, change a negative verdict, or bypass
 * validateSemanticVerdict. Exact assignment, changed path and line are required. */
export function normalizeOmittedSemanticEvidenceSha(packet: SemanticReviewPacket,
  raw: unknown): unknown {
  const value = raw as Partial<SemanticVerdict> | null;
  if (!value || value.sourceDigest !== packet.sourceDigest || value.verdict !== "pass" ||
      !Array.isArray(value.findings) || value.findings.length !== 0 ||
      !Array.isArray(value.evidence)) return raw;
  let fixed = false;
  const evidence = value.evidence.map(entry => {
    if (!entry || typeof entry.commitSha !== "string" ||
        !/^[a-f0-9]{32,39}$|^[a-f0-9]{41,80}$/.test(entry.commitSha) ||
        typeof entry.assignmentId !== "string" || typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.line) || entry.line < 1 ||
        typeof entry.explanation !== "string" || !entry.explanation.trim()) return entry;
    const candidates = packet.items.filter(item => {
      if (item.assignment.id !== entry.assignmentId ||
          !item.canonicalContext.some(c => c.path === entry.path &&
            entry.line <= c.content.split("\n").length)) return false;
      const expected = item.assurance.commitSha;
      if (!/^[a-f0-9]{40}$/.test(expected)) return false;
      if (entry.commitSha.length < 40) {
        let index = 0;
        for (const char of expected) if (entry.commitSha[index] === char) index++;
        return index === entry.commitSha.length;
      }
      // Only an EXACT adjacent repetition of a contiguous part of the
      // canonical SHA can be collapsed. This is not fuzzy SHA matching.
      for (let start = 0; start < expected.length; start++)
        for (let end = start + 1; end <= expected.length; end++) {
          const span = expected.slice(start, end);
          if (entry.commitSha === expected.slice(0, start) + span + span + expected.slice(end))
            return true;
        }
      return false;
    });
    if (candidates.length !== 1) return entry;
    fixed = true;
    return { ...entry, commitSha: candidates[0]!.assurance.commitSha };
  });
  return fixed ? { ...value, evidence } : raw;
}

/** #158/#166: A failed review cannot be erased because Luna emitted a
 * descriptive rather than enum-conforming finding kind. Only normalize a
 * bounded unknown taxonomy label to the broad 'other' category on a FAIL;
 * retain exact SHA, path, line, message, required correction and finding count.
 * The normal provenance validator still checks every source and attribution.
 * No passing verdict or structurally invalid finding can be rehabilitated. */
export function normalizeFailedSemanticFindingKinds(raw: unknown): unknown {
  const value = raw as Partial<SemanticVerdict> | null;
  if (!value || value.verdict !== "fail" || !Array.isArray(value.findings) ||
      value.findings.length < 1 || value.findings.length > 100) return raw;
  const allowed = new Set(["missing-requirement", "unrequested-change", "continuity", "other"]);
  let changed = false;
  const findings = value.findings.map(finding => {
    if (!finding || typeof finding.kind !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(finding.kind) || allowed.has(finding.kind)) return finding;
    changed = true;
    return { ...finding, kind: "other" as const };
  });
  return changed ? { ...value, findings } : raw;
}

export function validateSemanticVerdict(packet: SemanticReviewPacket, raw: unknown): SemanticVerdict {
  const verdict = raw as SemanticVerdict;
  if (!verdict || verdict.sourceDigest !== packet.sourceDigest ||
      !["pass", "fail"].includes(verdict.verdict) ||
      !Array.isArray(verdict.findings) || !Array.isArray(verdict.evidence) ||
      verdict.findings.length > 100 || verdict.evidence.length > 100)
    throw new Error("Semantic reviewer returned malformed or stale findings.");
  const belongs = (sha: string, id: string, path: string, line: number,
    changedOnly = false) =>
    packet.items.some(item => item.assurance.commitSha === sha && item.assignment.id === id &&
      (!changedOnly || item.assurance.changedPaths.includes(path)) &&
      Number.isSafeInteger(line) && line > 0 &&
      item.canonicalContext.some(c => c.path === path &&
        line <= c.content.split("\n").length));
  if (verdict.findings.some(f => !f || !belongs(f.commitSha, f.assignmentId, f.path, f.line, true) ||
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
          e.assignmentId === item.assignment.id &&
          item.assurance.changedPaths.includes(e.path)) &&
        !verdict.findings.some(f => f.commitSha === item.assurance.commitSha &&
          f.assignmentId === item.assignment.id &&
          item.assurance.changedPaths.includes(f.path))))
    throw new Error("Semantic reviewer lacks assignment-specific, source-linked evidence.");
  return verdict;
}

/** Pure projection of the validated reviewer response into independent
 * controller receipts. Offline replay and production sealing use the same path. */
export function independentReviewResults(packet: SemanticReviewPacket, verdict: SemanticVerdict,
  reviewer: string): IndependentReviewResult[] {
  if (!reviewer.trim()) throw new Error("Independent reviewer identity is required.");
  return packet.items.map(item => {
    const findings = verdict.findings.filter(f => f.commitSha === item.assurance.commitSha &&
      f.assignmentId === item.assignment.id);
    return {
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
    } satisfies IndependentReviewResult;
  });
}

/** Independent evaluator is not allowed to seal or write. Only the controller
 * converts verified findings to immutable per-checkpoint review receipts. */
export async function reviewBoundedAssignments(job: JobStartResult,
  points: RecoveryCheckpoint[], evaluator: SemanticEvaluator, reviewer: string,
  seal = false, challenge?: ReviewDisputeClaim): Promise<{ packet: SemanticReviewPacket; verdict: SemanticVerdict }> {
  if (!reviewer.trim()) throw new Error("Independent reviewer identity is required.");
  if (challenge && seal)
    throw Error("Adjudication may not overwrite or re-seal a negative checkpoint.");
  const packet = await prepareSemanticReview(job, points, challenge);
  const verdict = validateSemanticVerdict(packet, await evaluator(structuredClone(packet)));
  if (seal) {
    const results = independentReviewResults(packet, verdict, reviewer);
    for (let i = 0; i < packet.items.length; i++) {
      const point = points.find(p => p.commitSha === packet.items[i]!.assurance.commitSha)!;
      await sealIndependentReview(job, point, results[i]!);
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
    reviewer: string; seal?: boolean; challenge?: ReviewDisputeClaim;
  }) {
  const { reviewSpecialistAssignments } = await import("./narrative-review-specialist.js");
  return reviewBoundedAssignments(job, points,
    packet => reviewSpecialistAssignments(job, options.snapshot, packet,
      options.provider, options.model, options.thinking, options.onSession),
    options.reviewer, options.seal ?? true, options.challenge);
}
