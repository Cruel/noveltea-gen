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

type DiagnosticBinding = { signature: string; proofRef: string };

export function validateRecoveryDiagnosticProposal(raw: string, bound: DiagnosticBinding):
  import("./response-contract-recovery.js").ResponseContractFailure[] {
  if (Buffer.byteLength(raw) > 5_000) return [{ path: "$", expected: "JSON at most 5000 bytes" }];
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch { return [{ path: "$", expected: "strict JSON object" }]; }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "$", expected: "plain JSON object" }];
  const v = value as Record<string, unknown>;
  const failures: import("./response-contract-recovery.js").ResponseContractFailure[] = [];
  const check = (ok: boolean, path: string, expected: string) => {
    if (!ok) failures.push({ path, expected });
  };
  check(Object.keys(v).sort().join("|") === fields, "$", "exact keys: " + fields.split("|").join(", "));
  check(v.schema === "noveltea-recovery-diagnostic-proposal/v1", "$.schema", "noveltea-recovery-diagnostic-proposal/v1");
  check(v.signature === bound.signature, "$.signature", "exact controller signature " + JSON.stringify(bound.signature));
  check(v.sourceRef === bound.proofRef, "$.sourceRef", "exact original sourceRef " + JSON.stringify(bound.proofRef));
  check(categories.includes(v.category as string), "$.category", categories.join(" | "));
  check(bounded(v.diagnosis), "$.diagnosis", "nonempty 4–500 character string without control characters");
  check(strategies.includes(v.strategy as DiagnosticStrategy), "$.strategy", strategies.join(" | "));
  check(v.owner === null || bounded(v.owner, 120), "$.owner", "null or 4–120 character string without control characters");
  check(v.scopeRef === null || bounded(v.scopeRef, 1024), "$.scopeRef", "null or 4–1024 character string without control characters");
  if (!Array.isArray(v.prerequisites) || v.prerequisites.length > 5)
    failures.push({ path: "$.prerequisites", expected: "array of at most five strings" });
  else v.prerequisites.forEach((item, index) =>
    check(bounded(item, 160), "$.prerequisites[" + index + "]", "4–160 character string without control characters"));
  check(bounded(v.uncertainty, 300), "$.uncertainty", "4–300 character string without control characters");
  return failures;
}

export function parseRecoveryDiagnosticProposal(raw: string, bound: DiagnosticBinding): RecoveryDiagnosticProposal {
  const failures = validateRecoveryDiagnosticProposal(raw, bound);
  if (failures.length)
    throw Error("Diagnostic proposal failed its typed, source-bound contract: " +
      failures.map(f => f.path + " expects " + f.expected).join("; "));
  return JSON.parse(raw.trim()) as RecoveryDiagnosticProposal;
}

/** The original invocation is already bound to its authenticated source by
 * the controller. A model need not transcribe opaque identities. Explicit
 * conflicting or incomplete identity claims are still rejected. */
function diagnosticModelPayload(raw: string, bound: DiagnosticBinding): string {
  if (Buffer.byteLength(raw) > 5000) return raw;
  try {
    const v = JSON.parse(raw.trim());
    if (v && typeof v === "object" && !Array.isArray(v) &&
        !Object.hasOwn(v, "signature") && !Object.hasOwn(v, "sourceRef"))
      return JSON.stringify({ ...v, signature: bound.signature, sourceRef: bound.proofRef });
  } catch { /* The shared validator reports the exact malformed JSON. */ }
  return raw;
}

export function validateDiagnosticModelResponse(raw: string, bound: DiagnosticBinding) {
  return validateRecoveryDiagnosticProposal(diagnosticModelPayload(raw, bound), bound);
}

export function parseDiagnosticModelResponse(raw: string, bound: DiagnosticBinding) {
  return parseRecoveryDiagnosticProposal(diagnosticModelPayload(raw, bound), bound);
}
