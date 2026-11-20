/** Independent reassessment of a stalled precommit Architecture review.
 * A diagnostic recommendation never approves Story content or grants writes. */
import type { ArchitectureDraftRound } from "./architecture-draft-review.js";

export interface ArchitectureDraftDiagnosis {
  schema: "noveltea-architecture-draft-diagnosis/v1";
  action: "continue" | "replace" | "split" | "escalate";
  explanation: string;
  assessments: Array<{
    kind: "material" | "cosmetic" | "deferred" | "scope";
    reason: string;
    requirement: { source: "foundation" | "contract" | "task" | "blueprint"; quote: string };
    evidence: { path: string; quote: string };
  }>;
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const filled = (text: unknown, min = 8): text is string =>
  typeof text === "string" && text.trim().length >= min && text.length <= 750;

export function parseArchitectureDraftDiagnosis(raw: string,
  sources: Record<string, string>,
  requirements: Record<"foundation" | "contract" | "task" | "blueprint", string>,
  history: readonly ArchitectureDraftRound[],
): ArchitectureDraftDiagnosis {
  if (!history.length || history.at(-1)?.verdict.status !== "revise")
    throw Error("Architecture diagnostic requires a sealed negative review.");
  let input: unknown;
  try { input = JSON.parse(raw.trim()); }
  catch { throw Error("Architecture diagnostic response is not valid JSON."); }
  if (!exact(input, ["schema", "action", "explanation", "assessments"]) ||
      input.schema !== "noveltea-architecture-draft-diagnosis/v1" ||
      !["continue", "replace", "split", "escalate"].includes(String(input.action)) ||
      !filled(input.explanation) ||
      !Array.isArray(input.assessments) ||
      input.assessments.length < 1 || input.assessments.length > 8)
    throw Error("Architecture diagnostic response is not a bounded independent reassessment.");
  const diagnosis = input as unknown as ArchitectureDraftDiagnosis;
  for (const item of diagnosis.assessments) {
    if (!exact(item, ["kind", "reason", "requirement", "evidence"]) ||
        !["material", "cosmetic", "deferred", "scope"].includes(item.kind) ||
        !filled(item.reason) ||
        !exact(item.requirement, ["source", "quote"]) ||
        !Object.hasOwn(requirements, item.requirement.source) ||
        !filled(item.requirement.quote) ||
        !requirements[item.requirement.source]?.includes(item.requirement.quote) ||
        !exact(item.evidence, ["path", "quote"]) ||
        !Object.hasOwn(sources, item.evidence.path) ||
        !filled(item.evidence.quote) ||
        !sources[item.evidence.path]?.includes(item.evidence.quote))
      throw Error("Architecture diagnosis requires exact existing source and requirement citations.");
  }
  return diagnosis;
}
