/** C05 read-only recommendations. The model has NO authority to select an adapter,
 * widen a scope, change a review verdict, or create a new assignment. */
export type DiagnosticStrategy =
  | "local-repair" | "dependency-plan" | "blueprint-or-work-plan-amend"
  | "review-adjudication" | "reconcile-original" | "no-write-omission-review"
  | "resource-or-author-pause" | "unsafe";

export interface RecoveryDiagnosticProposal {
  schema: "noveltea-recovery-diagnostic-proposal/v1";
  signature: string;
  /** Must cite the exact independently authenticated original source proof. */
  sourceRef: string;
  category: "defect" | "invalid-assignment" | "protocol" | "infrastructure" | "integrity";
  diagnosis: string;
  strategy: DiagnosticStrategy;
  owner: string | null;
  scopeRef: string | null;
  prerequisites: string[];
  uncertainty: string;
}

const strategies: readonly DiagnosticStrategy[] = [
  "local-repair", "dependency-plan", "blueprint-or-work-plan-amend",
  "review-adjudication", "reconcile-original", "no-write-omission-review",
  "resource-or-author-pause", "unsafe",
];
const categories = ["defect", "invalid-assignment", "protocol", "infrastructure", "integrity"];
const fields = ["schema", "signature", "sourceRef", "category", "diagnosis",
  "strategy", "owner", "scopeRef", "prerequisites", "uncertainty"].sort().join("|");
const bounded = (s: unknown, max = 500) =>
  typeof s === "string" && s.trim().length >= 4 && s.length <= max &&
  !/[\x00-\x1f\x7f]/.test(s);

export function parseRecoveryDiagnosticProposal(raw: string, bound: {
  signature: string; proofRef: string;
}): RecoveryDiagnosticProposal {
  if (Buffer.byteLength(raw) > 5_000) throw Error("Oversized diagnostic proposal");
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch { throw Error("Diagnostic proposal must be strict JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Diagnostic proposal must be a plain object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join("|") !== fields ||
      v.schema !== "noveltea-recovery-diagnostic-proposal/v1" ||
      v.signature !== bound.signature || v.sourceRef !== bound.proofRef ||
      !categories.includes(v.category as string) ||
      !strategies.includes(v.strategy as DiagnosticStrategy) ||
      !bounded(v.diagnosis) || !bounded(v.uncertainty, 300) ||
      !(v.owner === null || bounded(v.owner, 120)) ||
      !(v.scopeRef === null || bounded(v.scopeRef, 160)) ||
      !Array.isArray(v.prerequisites) || v.prerequisites.length > 5 ||
      !v.prerequisites.every((p: unknown) => bounded(p, 160)))
    throw Error("Diagnostic proposal failed its typed, source-bound contract");
  return v as unknown as RecoveryDiagnosticProposal;
}

