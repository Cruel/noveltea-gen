/** #158: a release evidence gate, NOT an authority that can approve a Story.
 *
 * Inspect independently verified, source-bound controller output and a separate
 * human/third-party narrative assessment. All inputs are read-only. Returning
 * "eligible" means the supplied evidence is internally consistent; the caller
 * must authenticate the saved receipts, reviewer identity and Git content.
 */
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";

export type NewStoryMode = "autonomous" | "collaborative";
export const qualityDimensions = [
  "playable-opening",
  "clue-trail",
  "branch-consequences",
  "knowledge-continuity",
  "mystery-payoff",
  "meaningful-endings",
  "player-facing-prose",
] as const;
export type QualityDimension = (typeof qualityDimensions)[number];

export interface ExternalStoryQuality {
  schema: "noveltea-external-story-quality/v1";
  mode: NewStoryMode;
  headSha: string;
  reviewer: string;
  /** "external" is an attestation; production identity verification is separate. */
  relationship: "external";
  findings: Array<{
    dimension: QualityDimension;
    verdict: "pass" | "fail" | "uncertain";
    evidence: string[];
    analysis: string;
  }>;
}
export interface StudioStoryWitness {
  threadId: string;
  firstTurnId: string;
  sourceSha: string;
  approvedDigest: string;
  baselineQuestions: number;
  recommendationsPresented: boolean;
  exactApproval: boolean;
  continuedOriginalTurn: boolean;
  authorInteractionsReviewed: boolean;
  recoveryAndIsolationReviewed: boolean;
  evidenceReference: string;
}

/** Minimal typed projection of the verified controller receipts. Do not accept
 * unverified browser-provided objects as authenticated job evidence. */
export interface NewStoryEvidence {
  mode: NewStoryMode;
  /** Verified by the read-only CLI against controller-owned finalized fork
   * receipts and the original parent checkpoint at every hop. */
  lineage?: {
    originalJobId: string;
    originalSourceSha: string;
    terminalJobId: string;
    hops: Array<{
      sourceJobId: string;
      childJobId: string;
      sourceBaseSha: string;
      checkpointSha: string;
      proofDigest: string;
      verified: true;
    }>;
  };
  approval: {
    scope: string;
    jobId: string;
    firstTurnId: string;
    sourceSha: string;
    originalObjective: string;
    creativeMode: string;
    skillId: string;
    proposalDigest: string;
    provider: string;
    model: string;
  } | null;
  turn: {
    kind: string;
    originalRequest: string;
    source: { verifiedSha: string };
    digest: string;
    objective?: {
      breadth: string;
      deliveryDepth: string;
      obligations: string[];
    };
    creativePolicy?: { mode: string };
    contract: { scope: { kind: string; depth: string } };
  } | null;
  selection: {
    skillName: string;
    storySourceSha: string;
    turnPlanDigest: string | null;
    writeAuthority: string;
    role: string;
    reviewRole: string;
    skillSnapshot: { id: string; digest: string; commit: string };
  } | null;
  planning: {
    phase: string;
    sourceSha: string;
    turnDigest: string;
    snapshotId: string;
    provider: string;
    model: string;
    skillReads?: string[];
    sessionFile: string;
  } | null;
  /** Caller verified the real persisted session is a regular existing file. */
  plannerSessionVerified: boolean;
  report: {
    identity: { jobId: string; baseSha: string; headSha: string; clean: boolean };
    plan: { scope: { kind: string; depth: string } } | null;
    generation: {
      status: string;
      scopeFulfillment: string;
      planFulfillment: { status: string; headSha?: string | null };
      review: { worker: string; current: boolean } | null;
      blockers: string[];
    };
    evidence: {
      scope: {
        current: boolean;
        deterministic: string;
        headSha: string;
        scopedPaths: string[];
        routeCoverage: { representative: boolean; truncated: boolean };
        globalCatalog: { status: string; readiness: unknown; diagnostics: number; outstanding: number };
      } | null;
      protection: { status: string; verifiedHead: string | null };
      editorial: { verdict: string; findings: unknown[] };
      logicalUnverified: unknown[];
    };
  };
  /** Actual Git-tracked Story Markdown from the report's verified HEAD. */
  canonical: Record<string, string>;
  /** Reviewed externally against this exact HEAD (not Pi's self-assessment). */
  quality: ExternalStoryQuality | null;
  /** Human-checked interaction/restart transcript references. */
  studio: StudioStoryWitness | null;
}
export interface NewStoryAudit {
  status: "eligible" | "blocked";
  blockers: string[];
}

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const STORY_FILE = /^[a-z][a-z-]*\/[a-z0-9][a-z0-9._-]*\.md$/;
const requiredDirectories = [
  "creative-direction/",
  "arcs/",
  "milestones/",
  "characters/",
  "events/",
  "authored-content/",
];

function sourceWitness(text: string, canonical: Record<string, string>): boolean {
  const match = /^([a-z][a-z-]*\/[a-z0-9][a-z0-9._-]*\.md):(\d+)$/.exec(text);
  if (!match) return false;
  const lines = canonical[match[1]!]?.split("\n");
  const line = Number(match[2]);
  return (
    !!lines && Number.isSafeInteger(line) && line > 0 && line <= lines.length && !!lines[line - 1]?.trim()
  );
}
function stage(blockers: string[], ok: boolean, problem: string) {
  if (!ok) blockers.push(problem);
}
function nonempty(value: unknown): boolean {
  return typeof value === "string" && !!value.trim();
}
export function auditNewStory(evidence: NewStoryEvidence): NewStoryAudit {
  const failures: string[] = [];
  const { mode, approval, turn, selection, planning, report, canonical, quality, studio, lineage } = evidence;
  const { identity, generation, plan } = report;
  const originalJobId = lineage?.originalJobId ?? identity.jobId;
  const originalSourceSha = lineage?.originalSourceSha ?? identity.baseSha;
  let lineageJob = originalJobId;
  let lineageBase = originalSourceSha;
  const hops = lineage?.hops ?? [];
  const visited = new Set([lineageJob]);
  let validLineage = !lineage || (hops.length > 0 && hops.length <= 16 &&
    SHA.test(originalSourceSha));
  for (const hop of hops) {
    validLineage &&= hop.verified === true &&
      hop.sourceJobId === lineageJob && hop.sourceBaseSha === lineageBase &&
      SHA.test(hop.checkpointSha) && DIGEST.test(hop.proofDigest) &&
      !visited.has(hop.childJobId);
    lineageJob = hop.childJobId;
    lineageBase = hop.checkpointSha;
    visited.add(lineageJob);
  }
  if (lineage) validLineage &&= lineageJob === lineage.terminalJobId &&
    lineageJob === identity.jobId && lineageBase === identity.baseSha;
  stage(failures, validLineage, "Verified checkpoint continuation lineage missing or inconsistent.");
  const { scope, protection, editorial, logicalUnverified } = report.evidence;
  stage(failures, mode === "autonomous" || mode === "collaborative", "Unknown creative mode.");
  stage(
    failures,
    !!approval &&
      approval.scope === "whole-story" &&
      approval.creativeMode === mode &&
      approval.jobId === originalJobId &&
      approval.firstTurnId === originalJobId &&
      SHA.test(approval.sourceSha) &&
      approval.sourceSha === originalSourceSha &&
      DIGEST.test(approval.proposalDigest) &&
      DIGEST.test(approval.skillId) &&
      nonempty(approval.originalObjective) &&
      nonempty(approval.provider) &&
      nonempty(approval.model),
    "Exact approved new-Story foundation and job/source/creative-mode provenance missing.",
  );
  stage(
    failures,
    !!turn &&
      turn.kind === "full-story" &&
      !!approval &&
      turn.originalRequest === approval.originalObjective &&
      turn.source.verifiedSha === originalSourceSha &&
      DIGEST.test(turn.digest) &&
      turn.objective?.breadth === "whole-story" &&
      turn.objective.deliveryDepth === "composition" &&
      Array.isArray(turn.objective.obligations) &&
      turn.objective.obligations.length > 0 &&
      turn.contract.scope.kind === "full-story" &&
      turn.contract.scope.depth === "composition" &&
      turn.creativePolicy?.mode === mode,
    "Original whole-Story Turn objective or composition depth is missing or changed.",
  );
  stage(
    failures,
    !!selection &&
      !!turn &&
      selection.skillName === "nt-story-orchestrate" &&
      selection.storySourceSha === originalSourceSha &&
      selection.turnPlanDigest === turn.digest &&
      selection.role === "orchestrator" &&
      selection.reviewRole === "reviewer" &&
      selection.writeAuthority === "controller-only" &&
      DIGEST.test(selection.skillSnapshot.id) &&
      selection.skillSnapshot.digest === selection.skillSnapshot.id &&
      SHA.test(selection.skillSnapshot.commit),
    "Pinned portable-method selection or controller-only role is unverified.",
  );
  // Planning receipts must also pass readPinnedObjectivePlanning (which checks
  // their signed exact assignment order and the immutable snapshot).
  const resources = requiredOrchestratorSkillReads(mode);
  const loaded = planning?.skillReads ?? [];
  stage(
    failures,
    !!planning &&
      !!selection &&
      !!turn &&
      !!approval &&
      planning.phase === "planned" &&
      planning.sourceSha === originalSourceSha &&
      planning.turnDigest === turn.digest &&
      planning.snapshotId === selection.skillSnapshot.id &&
      planning.provider === approval.provider &&
      planning.model === approval.model &&
      nonempty(planning.sessionFile) &&
      evidence.plannerSessionVerified &&
      Array.isArray(planning.skillReads) &&
      resources.every((resource) =>
        loaded.some((path) => path === resource || path.endsWith("/skills/" + resource)),
      ) &&
      (mode !== "autonomous" || !loaded.some((path) => path.includes("nt-story-collaborate/"))),
    "Real Pi orchestrator session or mode-specific pinned methodology reads unverified.",
  );
  stage(
    failures,
    !!studio &&
      !!approval &&
      studio.firstTurnId === approval.firstTurnId &&
      studio.threadId === "root:" + approval.firstTurnId &&
      studio.sourceSha === approval.sourceSha &&
      studio.approvedDigest === approval.proposalDigest &&
      Number.isSafeInteger(studio.baselineQuestions) &&
      studio.baselineQuestions >= 1 &&
      studio.recommendationsPresented &&
      studio.exactApproval &&
      studio.continuedOriginalTurn &&
      studio.authorInteractionsReviewed &&
      studio.recoveryAndIsolationReviewed &&
      nonempty(studio.evidenceReference),
    "Studio baseline interview, exact approval, original-Thread continuation or restart/isolation evidence missing.",
  );
  stage(
    failures,
    SHA.test(identity.headSha) &&
      identity.headSha !== identity.baseSha &&
      identity.clean &&
      plan?.scope.kind === "full-story" &&
      plan.scope.depth === "composition" &&
      generation.status === "completed" &&
      generation.scopeFulfillment === "complete-in-scope" &&
      generation.planFulfillment.status === "passed" &&
      generation.planFulfillment.headSha === identity.headSha &&
      generation.review?.worker === "pi" &&
      generation.review.current &&
      Array.isArray(generation.blockers) &&
      generation.blockers.length === 0,
    "Verified complete real-Pi whole-Story generation/plan-level review missing.",
  );
  stage(
    failures,
    scope?.current === true &&
      scope.deterministic === "passed" &&
      scope.headSha === identity.headSha &&
      protection.status === "checked" &&
      protection.verifiedHead === identity.headSha &&
      editorial.verdict === "pass" &&
      Array.isArray(editorial.findings) &&
      editorial.findings.length === 0 &&
      Array.isArray(logicalUnverified) &&
      logicalUnverified.length === 0,
    "Native Story checks, protection, independent editorial review or progression remain incomplete.",
  );
  stage(
    failures,
    !!scope &&
      scope.routeCoverage?.representative === true &&
      scope.routeCoverage.truncated === false &&
      scope.globalCatalog?.status === "passed" &&
      scope.globalCatalog.outstanding === 0 &&
      scope.globalCatalog.readiness !== null &&
      scope.globalCatalog.readiness !== undefined,
    "Native global readiness or bounded Story progression remains unverified.",
  );
  const entries = Object.entries(canonical);
  stage(
    failures,
    entries.length > 0 &&
      entries.length <= 128 &&
      entries.every(([path, body]) => STORY_FILE.test(path) && typeof body === "string" && !!body.trim()),
    "Verified Git Story records missing, empty or outside canonical scope.",
  );
  for (const directory of requiredDirectories)
    stage(
      failures,
      entries.some(([path, body]) => path.startsWith(directory) && !!body.trim()),
      "Missing actual authored Story evidence under " + directory,
    );
  stage(
    failures,
    entries.some(([path]) => path.startsWith("choice-points/") || path.startsWith("puzzles/")),
    "No actual player choice or puzzle is recorded.",
  );
  stage(
    failures,
    !!scope &&
      Array.isArray(scope.scopedPaths) &&
      scope.scopedPaths.length > 0 &&
      scope.scopedPaths.every((path) => typeof canonical[path] === "string"),
    "Final native scope is not backed by the inspected Git Story content.",
  );
  stage(
    failures,
    !!quality &&
      quality.schema === "noveltea-external-story-quality/v1" &&
      quality.mode === mode &&
      quality.headSha === identity.headSha &&
      nonempty(quality.reviewer) &&
      quality.relationship === "external" &&
      Array.isArray(quality.findings) &&
      quality.findings.length === qualityDimensions.length &&
      new Set(quality.findings.map((f) => f.dimension)).size === qualityDimensions.length &&
      qualityDimensions.every((dimension) =>
        quality.findings.some(
          (f) =>
            f.dimension === dimension &&
            f.verdict === "pass" &&
            nonempty(f.analysis) &&
            Array.isArray(f.evidence) &&
            f.evidence.length > 0 &&
            f.evidence.every((ref) => sourceWitness(ref, canonical)),
        ),
      ),
    "External narrative quality assessment is missing, stale, unsupported or reports a failing/uncertain dimension.",
  );
  return { status: failures.length === 0 ? "eligible" : "blocked", blockers: failures };
}

/** Two different exact Story/Thread lineages must be certified; twice checking
 * one Story or reusing the same review result cannot satisfy both creative modes. */
export function auditNewStoryMatrix(evidence: NewStoryEvidence[]): NewStoryAudit {
  const blockers: string[] = [];
  if (
    evidence.length !== 2 ||
    new Set(evidence.map((item) => item.mode)).size !== 2 ||
    !evidence.some((item) => item.mode === "autonomous") ||
    !evidence.some((item) => item.mode === "collaborative")
  )
    blockers.push("Certification requires exactly one independent run per creative mode.");
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (
    !unique(evidence.map((e) => e.lineage?.originalJobId ?? e.report.identity.jobId)) ||
    !unique(evidence.map((e) => e.lineage?.originalSourceSha ?? e.report.identity.baseSha)) ||
    !unique(evidence.map((e) => e.report.identity.jobId)) ||
    !unique(evidence.map((e) => e.report.identity.headSha)) ||
    !unique(evidence.map((e) => e.studio?.threadId ?? ""))
  )
    blockers.push("Creative-mode witnesses reuse a job, source, final Story HEAD or Thread.");
  for (const item of evidence) {
    const audit = auditNewStory(item);
    blockers.push(...audit.blockers.map((problem) => item.mode + ": " + problem));
  }
  return { status: blockers.length === 0 ? "eligible" : "blocked", blockers };
}
