/** Source-bound editorial follow-ups for the shared Review cycle. The author
 * remains scoped to the original Composition assignment; only current Story
 * bytes and an independent read-only verdict can establish a pass. */
import { sourceReviewConvergence } from "./review-cycle.js";

export const compositionReviewRequirements =
  "Shared entry must not assume unavailable route-specific clues or branch-exclusive truths. " +
  "Each reachable Choice outcome requires distinct playable responses and conditioned aftermath. " +
  "Puzzle solution text must respect accessible clue knowledge and typed route effects. " +
  "Every Authored Content document must own exactly one enacted Event and preserve protected decisions. " +
  "Optional witness testimony is not enacted without explicit typed routes and effects. " +
  "Review current prose, causal stage requirements, regressions and overlooked material defects, not cosmetic preferences.";

export interface CompositionReviewFinding {
  path: string;
  reason: string;
  correction: string;
  requirement: { source: "assignment" | "policy"; quote: string };
  evidence: { path: string; quote: string };
  origin: "initial" | "continuing" | "introduced" | "overlooked";
}
export interface CompositionReviewVerdict {
  schema: "noveltea-composition-review/v2";
  status: "pass" | "revise";
  findings: CompositionReviewFinding[];
  prior: Array<{
    round: number;
    findingIndex: number;
    status: "resolved" | "improved" | "persisting" | "regressed";
    reason: string;
    evidence: { path: string; quote: string };
  }>;
  sourceEvidence: string[];
}
export interface CompositionReviewRound {
  sources: Record<string, string>;
  verdict: CompositionReviewVerdict;
}
const exact = (value: unknown, fields: string[]): value is Record<string, any> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");
const filled = (value: unknown, min = 1, max = 750): value is string =>
  typeof value === "string" && value.trim().length >= min && value.length <= max;

export function parseCompositionReview(
  raw: string,
  paths: readonly string[],
  sources: Record<string, string>,
  requirements: { assignment: string; policy: string },
  previous: readonly CompositionReviewRound[] = [],
): CompositionReviewVerdict {
  let value: unknown;
  try {
    value = JSON.parse(
      raw
        .trim()
        .replace(/^\`\`\`(?:json)?\\s*\\n/i, "")
        .replace(/\\n\`\`\`\\s*$/, ""),
    );
  } catch {
    throw Error("Composition reviewer returned invalid JSON.");
  }
  if (
    !exact(value, ["schema", "status", "findings", "prior", "sourceEvidence"]) ||
    value.schema !== "noveltea-composition-review/v2" ||
    !["pass", "revise"].includes(value.status) ||
    !Array.isArray(value.findings) ||
    value.findings.length > 8 ||
    !Array.isArray(value.prior) ||
    !Array.isArray(value.sourceEvidence) ||
    value.sourceEvidence.length > 48 ||
    value.sourceEvidence.some((e: unknown) => !filled(e, 8, 1000)) ||
    (value.status === "pass"
      ? value.findings.length !== 0 || !value.sourceEvidence.length
      : value.findings.length === 0)
  )
    throw Error("Composition review has invalid source-linked schema or verdict.");
  const review = value as CompositionReviewVerdict;
  const citation = (ref: unknown, expectedPath?: string): boolean =>
    exact(ref, ["path", "quote"]) &&
    typeof ref.path === "string" &&
    paths.includes(ref.path) &&
    (!expectedPath || expectedPath === ref.path) &&
    filled(ref.quote, 8) &&
    (sources[ref.path]?.includes(ref.quote) ?? false);
  for (const [index, f] of review.findings.entries()) {
    if (f && (previous.length ? f.origin === "initial" : f.origin !== "initial"))
      throw Error("findings[" + index + "].origin: " + (previous.length
        ? "use continuing, introduced or overlooked; initial is forbidden after round zero."
        : "must be initial in round zero."));
    if (
      !exact(f, ["path", "reason", "correction", "requirement", "evidence", "origin"]) ||
      !paths.includes(f.path) ||
      !f.path.startsWith("authored-content/") ||
      !filled(f.reason) ||
      !filled(f.correction) ||
      !["initial", "continuing", "introduced", "overlooked"].includes(f.origin) ||
      (previous.length ? f.origin === "initial" : f.origin !== "initial") ||
      !exact(f.requirement, ["source", "quote"]) ||
      !["assignment", "policy"].includes(f.requirement.source) ||
      !filled(f.requirement.quote, 8) ||
      !requirements[f.requirement.source]?.includes(f.requirement.quote) ||
      !citation(f.evidence, f.path)
    )
      throw Error("Composition finding lacks a current source quote or authorized requirement.");
    if (
      f.origin === "continuing" &&
      !previous.some((round) => round.verdict.findings.some((old) => old.path === f.path))
    )
      throw Error("Composition continuing finding has no prior blocker at that path.");
  }
  const expected = previous.reduce((n, round) => n + round.verdict.findings.length, 0);
  if (review.prior.length !== expected)
    throw Error("Composition review did not account for every previous material blocker.");
  const seen = new Set<string>();
  for (const p of review.prior) {
    if (
      !exact(p, ["round", "findingIndex", "status", "reason", "evidence"]) ||
      !Number.isSafeInteger(p.round) ||
      !Number.isSafeInteger(p.findingIndex) ||
      !["resolved", "improved", "persisting", "regressed"].includes(p.status) ||
      !filled(p.reason)
    )
      throw Error("Composition previous finding assessment is malformed.");
    const key = p.round + ":" + p.findingIndex;
    const old = previous[p.round]?.verdict.findings[p.findingIndex];
    if (!old || seen.has(key) || !citation(p.evidence, old.path))
      throw Error("Composition previous finding evidence has an invalid or stale source.");
    seen.add(key);
  }
  if (review.status === "pass" && review.prior.some((p) => p.status !== "resolved"))
    throw Error("Composition review cannot pass with unresolved previous findings.");
  return review;
}

/** Diagnostic evidence is a new, independent opinion, not a pass verdict. */
export interface CompositionDiagnosis {
  schema: "noveltea-composition-diagnosis/v1";
  action: "continue" | "replace" | "split" | "escalate";
  explanation: string;
  assessments: Array<{
    kind: "material" | "deferred" | "cosmetic" | "scope";
    reason: string;
    requirement: { source: "assignment" | "policy"; quote: string };
    evidence: { path: string; quote: string };
  }>;
}
export function parseCompositionDiagnosis(
  raw: string,
  paths: readonly string[],
  sources: Record<string, string>,
  requirements: { assignment: string; policy: string },
): CompositionDiagnosis {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw Error("Composition Diagnostic review returned invalid JSON.");
  }
  if (
    Buffer.byteLength(raw) > 32000 ||
    !exact(value, ["schema", "action", "explanation", "assessments"]) ||
    value.schema !== "noveltea-composition-diagnosis/v1" ||
    !["continue", "replace", "split", "escalate"].includes(value.action) ||
    !filled(value.explanation, 8, 1600) ||
    !Array.isArray(value.assessments) ||
    value.assessments.length === 0 ||
    value.assessments.length > 12
  )
    throw Error("Composition Diagnostic review has an invalid bounded disposition.");
  const diagnosis = value as CompositionDiagnosis;
  for (const item of diagnosis.assessments) {
    if (
      !exact(item, ["kind", "reason", "requirement", "evidence"]) ||
      !["material", "deferred", "cosmetic", "scope"].includes(item.kind) ||
      !filled(item.reason, 8) ||
      !exact(item.requirement, ["source", "quote"]) ||
      !["assignment", "policy"].includes(item.requirement.source) ||
      !filled(item.requirement.quote, 8) ||
      !requirements[item.requirement.source]?.includes(item.requirement.quote) ||
      !exact(item.evidence, ["path", "quote"]) ||
      typeof item.evidence.path !== "string" ||
      !paths.includes(item.evidence.path) ||
      !filled(item.evidence.quote, 8) ||
      !sources[item.evidence.path]?.includes(item.evidence.quote)
    )
      throw Error("Composition Diagnostic opinion has no current source and requirement citation.");
  }
  return diagnosis;
}

export const compositionReviewConvergence = sourceReviewConvergence;
