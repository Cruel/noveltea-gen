/** Idea planning and independent review are reports, not Story write grants.
 * The format contract deliberately accepts negative semantic verdicts. */
import type { ResponseContractFailure } from "./response-contract-recovery.js";

export type IdeaResponse = {
  verdict: "pass" | "block";
  evidence: string[];
  reason: string;
  target?: string | null;
};

export function ideaResponseFailures(text: string, selecting: boolean): ResponseContractFailure[] {
  let value: unknown;
  try { value = JSON.parse(text.trim()); }
  catch { return [{ path: "$.JSON", expected: "one complete JSON object" }]; }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "$", expected: "one report object" }];
  const v = value as Record<string, unknown>;
  const failures: ResponseContractFailure[] = [];
  const fields = selecting ? ["verdict", "evidence", "reason", "target"] : ["verdict", "evidence", "reason"];
  if (Object.keys(v).some(k => !fields.includes(k)))
    failures.push({ path: "$", expected: "no unknown report fields" });
  if (v.verdict !== "pass" && v.verdict !== "block")
    failures.push({ path: "$.verdict", expected: "pass or block" });
  if (!Array.isArray(v.evidence) || !v.evidence.every(e => typeof e === "string" && e.trim().length > 0))
    failures.push({ path: "$.evidence", expected: "array of nonempty evidence strings" });
  if (typeof v.reason !== "string" || !v.reason.trim())
    failures.push({ path: "$.reason", expected: "nonempty reason" });
  if (selecting && !(v.target === null || typeof v.target === "string" && v.target.trim()))
    failures.push({ path: "$.target", expected: "nonempty candidate ID or null" });
  return failures;
}

export function parseIdeaResponse(text: string, selecting: boolean): IdeaResponse {
  if (ideaResponseFailures(text, selecting).length)
    throw Error("Invalid idea response contract");
  return JSON.parse(text.trim()) as IdeaResponse;
}
