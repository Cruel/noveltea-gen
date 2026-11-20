/** Source-grounded progress accounting for a persistent independent Review cycle.
 * The reviewer judges causal improvement; the controller checks exact source
 * anchors, lineage, affected evidence and oscillation, without a finding ledger.
 * Diagnostic reassessment of stalled cycles belongs to the next boundary. */
import { createHash } from "node:crypto";
import type { CausalBlueprint } from "./architecture-blueprint.js";

export type ReviewCitation =
  | { beatId: string; quote: string; field?: never }
  | { beatId: "resolution"; field: "conclusion" | "uncertainty" | "supportedBy"; quote: string };
export interface ConvergentFinding {
  beatId: string;
  reason: string;
  correction: string;
  requirement: { source: "foundation" | "task" | "contract"; quote: string };
  evidence: ReviewCitation;
  origin: "initial" | "continuing" | "introduced" | "overlooked";
}
export interface PriorFindingStatus {
  round: number;
  findingIndex: number;
  status: "resolved" | "improved" | "persisting" | "regressed";
  reason: string;
  evidence: ReviewCitation;
}
export interface ConvergentReview {
  schema: "noveltea-blueprint-review/v2";
  status: "pass" | "revise";
  findings: ConvergentFinding[];
  prior: PriorFindingStatus[];
}
export interface ReviewRound {
  blueprint: CausalBlueprint;
  verdict: { status: "pass" | "revise"; findings: Array<{ beatId: string; reason: string; correction: string }> };
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filled = (value: unknown, max = 1200): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= max;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const statuses = ["resolved", "improved", "persisting", "regressed"];
const origins = ["initial", "continuing", "introduced", "overlooked"];
function cited(blueprint: CausalBlueprint, value: unknown, from?: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const citation = value as Partial<ReviewCitation>;
  if (!filled(citation.quote) || citation.quote.length < 8 ||
      typeof citation.beatId !== "string") return false;
  const candidates = new Set(from ? [from] : []);
  for (const beat of blueprint.beats)
    if (beat.dependsOn.some(id => candidates.has(id))) candidates.add(beat.id);
  if (citation.beatId === "resolution") {
    if (!exact(citation, ["beatId", "field", "quote"]) ||
        !["conclusion", "uncertainty", "supportedBy"].includes(String(citation.field)) ||
        (from && !blueprint.resolution.supportedBy.some(id => candidates.has(id))))
      return false;
    return JSON.stringify(blueprint.resolution[citation.field as
      "conclusion" | "uncertainty" | "supportedBy"]).includes(citation.quote);
  }
  if (!exact(citation, ["beatId", "quote"])) return false;
  const beat = blueprint.beats.find(beat => beat.id === citation.beatId);
  return !!beat && (!from || candidates.has(beat.id)) &&
    JSON.stringify(beat).includes(citation.quote);
}
function checkReviewShape(review: unknown, blueprint: CausalBlueprint,
  previous: readonly ReviewRound[], sources: { foundation: string; task: string; contract: unknown },
): asserts review is ConvergentReview {
  if (!exact(review, ["schema", "status", "findings", "prior"]) ||
      review.schema !== "noveltea-blueprint-review/v2" ||
      !["pass", "revise"].includes(String(review.status)) ||
      !Array.isArray(review.findings) || review.findings.length > 8 ||
      (review.status === "pass" ? review.findings.length > 0 : review.findings.length === 0) ||
      !Array.isArray(review.prior))
    throw Error("Convergent Blueprint review response has an invalid schema or verdict.");
  const sourceText = { foundation: sources.foundation, task: sources.task,
    contract: JSON.stringify(sources.contract) };
  for (const finding of review.findings) {
    if (!exact(finding, ["beatId", "reason", "correction", "requirement", "evidence", "origin"]) ||
        !filled(finding.reason) || !filled(finding.correction) ||
        !origins.includes(String(finding.origin)) ||
        (previous.length === 0 ? finding.origin !== "initial" : finding.origin === "initial") ||
        !exact(finding.requirement, ["source", "quote"]) ||
        typeof finding.requirement.source !== "string" ||
        !Object.hasOwn(sourceText, finding.requirement.source) ||
        !filled(finding.requirement.quote) ||
        finding.requirement.quote.length < 8 ||
        !sourceText[finding.requirement.source as keyof typeof sourceText]
          .includes(finding.requirement.quote as string) ||
        !cited(blueprint, finding.evidence, finding.beatId as string) ||
        !["resolution", finding.beatId].includes((finding.evidence as ReviewCitation).beatId))
      throw Error("Convergent Blueprint finding lacks a current beat and exact authorized source citation.");
    if (previous.length) {
      const earlier = previous.at(-1)!.blueprint;
      const existed = cited(earlier, finding.evidence);
      if ((finding.origin === "introduced" && existed) ||
          (finding.origin === "overlooked" && !existed))
        throw Error("Convergent Blueprint new-finding origin contradicts the prior draft.");
      if (finding.origin === "continuing" &&
          !previous.some(round => round.verdict.findings.some(f => f.beatId === finding.beatId)))
        throw Error("Convergent Blueprint continuing finding lacks a prior blocker.");
    }
  }
  const expected = previous.reduce((count, round) => count + round.verdict.findings.length, 0);
  if (review.prior.length !== expected) {
    throw Error("Convergent Blueprint verdict did not account for every previous material blocker.");
  }
  const keys = new Set<string>();
  for (const prior of review.prior) {
    if (!exact(prior, ["round", "findingIndex", "status", "reason", "evidence"]) ||
        !Number.isSafeInteger(prior.round) || !Number.isSafeInteger(prior.findingIndex) ||
        !statuses.includes(String(prior.status)) || !filled(prior.reason)) {
      throw Error("Convergent Blueprint previous-blocker assessment is malformed.");
    }
    const old = previous[prior.round as number]?.verdict.findings[prior.findingIndex as number];
    const key = prior.round + ":" + prior.findingIndex;
    if (!old || keys.has(key) || !cited(blueprint, prior.evidence, old.beatId)) {
      throw Error("Convergent Blueprint previous-blocker evidence is stale, duplicated or outside its cause.");
    }
    keys.add(key);
  }
}
export function evaluateReviewConvergence(
  review: unknown, blueprint: CausalBlueprint, previous: readonly ReviewRound[],
  sources: { foundation: string; task: string; contract: unknown }, stalledBefore = 0,
): { review: ConvergentReview; productive: boolean; stalled: number; reassess: boolean; oscillating: boolean } {
  checkReviewShape(review, blueprint, previous, sources);
  const reviewValid = review as ConvergentReview;
  if (reviewValid.status === "pass" && reviewValid.prior.some(p => p.status !== "resolved"))
    throw Error("Convergent Blueprint cannot approve a persisting, improved-only or regressed blocker.");
  // A future version may retain an old verdict verbatim, but a "pass" still
  // needs to account for all historical blockers. Never infer progress from
  // fresh blocker discovery or the number of added words.
  const last = previous.at(-1)?.blueprint;
  const oscillating = previous.some(item => digest(item.blueprint) === digest(blueprint));
  const material = !!last && reviewValid.prior.some(prior => {
    if (prior.status !== "resolved" && prior.status !== "improved") return false;
    const old = previous[prior.round]!.verdict.findings[prior.findingIndex]!;
    return cited(blueprint, prior.evidence, old.beatId) &&
      !cited(last, prior.evidence);
  });
  const regressed = reviewValid.prior.some(item => item.status === "regressed");
  const productive = !!last && !oscillating && material && !regressed;
  if (reviewValid.status === "pass" && last && !productive)
    throw Error("Convergent Blueprint pass has no verified material source progress or repeats an old draft.");
  const stalled = !last || productive ? 0 : stalledBefore + 1;
  return { review: reviewValid, productive, stalled,
    reassess: reviewValid.status === "revise" && stalled >= 2, oscillating };
}
