/** Independent, read-only Milestone Blueprint review-cycle diagnosis.
 * Diagnostic advice is never a review verdict, approval or write authority. */
import { createHash } from "node:crypto";
import type { MilestoneBlueprint, MilestoneBlueprintReview } from "./milestone-blueprint.js";
import { sourceReviewDiagnosticTrigger } from "./review-cycle.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const filled = (value: unknown, max = 1500): value is string =>
  typeof value === "string" && value.trim().length >= 8 && value.length <= max;
type Field = Exclude<keyof MilestoneBlueprint["events"][number], "id">;
const fields: readonly string[] = ["purpose", "dependsOn", "evidence", "participants", "knowledge", "routes"];
export type MilestoneDiagnosticAction = "continue" | "replace" | "split" | "escalate";
export type MilestoneDiagnosticTrigger = "stagnation" | "review-depth";
export interface MilestoneDiagnosis {
  schema: "noveltea-milestone-diagnosis/v1";
  action: MilestoneDiagnosticAction;
  explanation: string;
  assessments: Array<{
    kind: "material" | "deferred" | "cosmetic" | "scope";
    reason: string;
    requirement: { source: "task" | "contract"; quote: string };
    evidence: { eventId: string; field: Field; quote: string } |
      { target: "downstream"; index: number; field: "owner" | "obligation"; quote: string } |
      { target: "missing-downstream"; owner: "event" | "interactive" | "composition"; quote: string };
  }>;
}
export type MilestoneDiagnosticSources = { task: string; contract: unknown };

/** Diagnose only a still-negative review, after two nonproductive corrections or
 * a soft depth checkpoint. A completed diagnosis resets the assessment window,
 * not the underlying sealed semantic history. This is NOT a round cap. */
export function milestoneDiagnosticTrigger(
  rounds: readonly { review: { status: "pass" | "revise" } }[],
  diagnosedAt: readonly number[], stalled: number,
): MilestoneDiagnosticTrigger | null {
  // Milestone review evidence does not encode late-blocker origin; do not
  // fabricate it. The common policy still owns stagnation and depth.
  const trigger = sourceReviewDiagnosticTrigger(rounds.map(({ review }) => ({
    verdict: { status: review.status, findings: [] },
  })), rounds.length >= 3 ? stalled : 0, diagnosedAt.length, diagnosedAt.at(-1) ?? 0);
  return trigger === "late-blockers" ? null : trigger;
}

export function milestoneDiagnosticFingerprint(cycleId: string, draft: MilestoneBlueprint,
  findings: readonly MilestoneBlueprintReview["findings"][number][],
  sources: MilestoneDiagnosticSources): string {
  return hash({ schema: "noveltea-milestone-diagnostic-case/v1", cycleId,
    draft: hash(draft), sources, claims: findings.map(f => ({
      eventId: f.eventId, anchorPath: f.anchorPath,
      requirement: f.requirement, evidence: f.evidence ?? null,
    })) });
}
export function milestoneDiagnosticEvidence(cycleId: string,
  rounds: readonly { draftDigest: string; reviewDigest: string }[],
  sources: MilestoneDiagnosticSources): string {
  return hash({ schema: "noveltea-milestone-diagnostic-evidence/v1",
    cycleId, rounds, sources });
}

export function parseMilestoneDiagnosis(text: string, draft: MilestoneBlueprint,
  sources: MilestoneDiagnosticSources): MilestoneDiagnosis {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()); }
  catch { throw Error("Independent Milestone diagnosis is not strict JSON."); }
  if (Buffer.byteLength(text) > 24000 ||
      !exact(raw, ["schema", "action", "explanation", "assessments"]) ||
      raw.schema !== "noveltea-milestone-diagnosis/v1" ||
      !["continue", "replace", "split", "escalate"].includes(String(raw.action)) ||
      !filled(raw.explanation) || !Array.isArray(raw.assessments) ||
      !raw.assessments.length || raw.assessments.length > 12)
    throw Error("Independent Milestone diagnosis has an invalid bounded disposition.");
  const obligations = { task: sources.task, contract: JSON.stringify(sources.contract) };
  for (const item of raw.assessments) {
    if (!exact(item, ["kind", "reason", "requirement", "evidence"]) ||
        !["material", "deferred", "cosmetic", "scope"].includes(String(item.kind)) ||
        !filled(item.reason) || !exact(item.requirement, ["source", "quote"]) ||
        !Object.hasOwn(obligations, String(item.requirement.source)) ||
        !filled(item.requirement.quote) ||
        !obligations[item.requirement.source as keyof typeof obligations].includes(item.requirement.quote as string) ||
        !exactSourceAssessment(item.evidence, draft)) {
      throw Error("Independent Milestone diagnosis lacks a source-bound assessment.");
    }
  }
  return raw as unknown as MilestoneDiagnosis;
}

/** The diagnostician must cite exact material current fields, including
 * obligations already in the downstream list or a missing obligation's
 * exact full-list witness. This provides evidence, not revision authority. */
function exactSourceAssessment(evidence: unknown, draft: MilestoneBlueprint): boolean {
  if (exact(evidence, ["target", "index", "field", "quote"]) &&
      evidence.target === "downstream" &&
      Number.isSafeInteger(evidence.index) && (evidence.index as number) >= 0 &&
      ["owner", "obligation"].includes(String(evidence.field))) {
    const item = draft.downstream[evidence.index as number];
    if (!item) return false;
    const text = item[evidence.field as "owner" | "obligation"];
    const quote = evidence.quote;
    return typeof quote === "string" && !!quote &&
      (quote === text || quote.length >= 8 && text.includes(quote));
  }
  if (exact(evidence, ["target", "owner", "quote"]) &&
      evidence.target === "missing-downstream" &&
      ["event", "interactive", "composition"].includes(String(evidence.owner)))
    return evidence.quote === JSON.stringify(draft.downstream);
  if (!exact(evidence, ["eventId", "field", "quote"]) ||
      !fields.includes(String(evidence.field))) return false;
  const event = draft.events.find(e => e.id === evidence.eventId);
  if (!event) return false;
  const content = event[evidence.field as Field];
  const current = typeof content === "string" ? content : JSON.stringify(content);
  const quote = evidence.quote;
  return typeof quote === "string" && !!quote &&
    (quote === current || quote.length >= 8 && current.includes(quote));
}

/** The controller, never the diagnostician, owns the scheduling decision. */
export function milestoneDiagnosticDecision(action: MilestoneDiagnosticAction,
  repeatedCase: boolean): { kind: "continue" | "replace" | "stop"; reason?: string } {
  if (repeatedCase) return { kind: "stop",
    reason: "Unchanged material Milestone evidence has already received independent diagnostic review." };
  switch (action) {
    case "continue": return { kind: "continue" };
    case "replace": return { kind: "replace" };
    case "split": return { kind: "stop",
      reason: "Milestone diagnosis recommends a plan/scope restructuring; controller cannot expand the authorized plan." };
    case "escalate": return { kind: "stop",
      reason: "Milestone diagnosis requests escalation; unresolved scope or semantic authority cannot be waived." };
  }
}
