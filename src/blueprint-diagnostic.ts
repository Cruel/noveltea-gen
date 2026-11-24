/** Independent, source-bound reassessment of a persistent Blueprint Review cycle.
 * Diagnoses inform trusted routing; only an independent current-stage review
 * can pass a draft. No semantic finding identity or second scheduler. */
import { createHash } from "node:crypto";
import type { CausalBlueprint } from "./architecture-blueprint.js";
import { cited, type ReviewRound, type ReviewCitation } from "./review-convergence.js";
import { sourceReviewDiagnosticTrigger } from "./review-cycle.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filled = (value: unknown, max = 1200): value is string =>
  typeof value === "string" && !!value.trim() && value.length >= 8 && value.length <= max;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export type DiagnosticTrigger = "stagnation" | "late-blockers" | "review-depth";
export type DiagnosticAction = "continue" | "replace" | "split" | "escalate";
export interface BlueprintDiagnosis {
  schema: "noveltea-blueprint-diagnosis/v1";
  action: DiagnosticAction;
  explanation: string;
  assessments: Array<{
    kind: "material" | "deferred" | "cosmetic" | "scope";
    reason: string;
    requirement: { source: "foundation" | "task" | "contract"; quote: string };
    evidence: ReviewCitation;
  }>;
}

export function diagnosticTrigger(rounds: readonly ReviewRound[], stalled: number,
  diagnosedCount = 0, lastDiagnosedRound = 0): DiagnosticTrigger | null {
  return sourceReviewDiagnosticTrigger(rounds.map(({ verdict }) => ({
    verdict: { status: verdict.status, findings: verdict.findings.map(finding => ({
      origin: "origin" in finding ? String(finding.origin) : undefined,
    })) },
  })), stalled, diagnosedCount, lastDiagnosedRound);
}

export function diagnosticEvidence(cycleId: string, rounds: readonly ReviewRound[],
  sources: { foundation: string; task: string; contract: unknown }): string {
  return digest({ schema: "noveltea-blueprint-diagnostic-evidence/v1", cycleId,
    sources, rounds: rounds.map(r => ({
      draft: digest(r.blueprint), verdict: digest(r.verdict),
    })) });
}

/** Repeated verdicts on identical actual source/obligations are one diagnostic
 * case, regardless of different wording about prior rounds or finding origins. */
export function diagnosticCaseFingerprint(cycleId: string, blueprint: CausalBlueprint,
  verdict: ReviewRound["verdict"],
  sources: { foundation: string; task: string; contract: unknown }): string {
  return digest({ schema: "noveltea-blueprint-diagnostic-case/v1", cycleId,
    blueprint: digest(blueprint), sources,
    blockers: verdict.findings.map(finding => ({
      beatId: finding.beatId, requirement: "requirement" in finding
        ? finding.requirement : null,
      evidence: "evidence" in finding ? finding.evidence : null,
    })),
  });
}

export function parseBlueprintDiagnosis(text: string, blueprint: CausalBlueprint,
  sources: { foundation: string; task: string; contract: unknown }): BlueprintDiagnosis {
  let value: unknown;
  try { value = JSON.parse(text.trim()); }
  catch { throw Error("Independent Blueprint diagnosis must be strict JSON."); }
  if (Buffer.byteLength(text) > 32000 ||
      !exact(value, ["schema", "action", "explanation", "assessments"]) ||
      value.schema !== "noveltea-blueprint-diagnosis/v1" ||
      !["continue", "replace", "split", "escalate"].includes(String(value.action)) ||
      !filled(value.explanation) || !Array.isArray(value.assessments) ||
      !value.assessments.length || value.assessments.length > 12)
    throw Error("Independent Blueprint diagnosis has an invalid bounded disposition.");
  const sourceText = { foundation: sources.foundation, task: sources.task,
    contract: JSON.stringify(sources.contract) };
  for (const assessment of value.assessments) {
    if (!exact(assessment, ["kind", "reason", "requirement", "evidence"]) ||
        !["material", "deferred", "cosmetic", "scope"].includes(String(assessment.kind)) ||
        !filled(assessment.reason) ||
        !exact(assessment.requirement, ["source", "quote"]) ||
        !Object.hasOwn(sourceText, String(assessment.requirement.source)) ||
        !filled(assessment.requirement.quote) ||
        !sourceText[assessment.requirement.source as keyof typeof sourceText]
          .includes(assessment.requirement.quote as string) ||
        !cited(blueprint, assessment.evidence))
      throw Error("Independent Blueprint diagnosis lacks a current, authorized source citation.");
  }
  return value as unknown as BlueprintDiagnosis;
}
