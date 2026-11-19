import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { recoverResponseContract, type ResponseContractFailure } from "./response-contract-recovery.js";

/** Extract the final JSON manifest without mistaking braces embedded in
 * quoted obligation text (e.g. `fulfillment: {any_of: []}`) for object delimiters.
 * Select the final JSON-shaped object regardless of key order so an earlier
 * valid manifest cannot conceal a later invalid correction. Balance braces
 * lexically rather than with a regex character class. */
export function lastSpecialistManifest(text: string): Record<string, unknown> | null {
  // An otherwise valid JSON object may list its keys in any order. Keep
  // support for a final standalone manifest preceded by ordinary prose.
  try {
    const direct: unknown = JSON.parse(text.trim());
    if (direct && typeof direct === "object" && !Array.isArray(direct))
      return direct as Record<string, unknown>;
  } catch { /* Fall back to the final manifest after prose. */ }
  const marker = [...text.matchAll(/\{\s*"[a-zA-Z][a-zA-Z0-9]*"\s*:/g)].at(-1);
  if (!marker) return null;
  const start = marker.index;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (--depth !== 0) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        /* invalid final manifest; never accept an earlier stale one */
      }
      return null;
    }
  }
  return null;
}

/** Report-only shape inspection. This is deliberately separate from
 * stage-specific semantics: a valid no-write conflict or failed source
 * verification is not a malformed response and must not become a retry. */
export function inspectSpecialistManifest(text: string): ResponseContractFailure[] {
  let value: unknown = lastSpecialistManifest(text);
  if (!value) {
    try { value = JSON.parse(text.trim()); }
    catch { return [{ path: "$.JSON", expected: "complete parseable JSON object" }]; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "$.JSON", expected: "JSON object" }];
  const report = value as Record<string, unknown>;
  const failed: ResponseContractFailure[] = [];
  for (const key of ["modifiedRecords", "architecturalConflicts", "laterObligations"]) {
    const entry = report[key];
    if (!Array.isArray(entry) || entry.some(s => typeof s !== "string" || !s.trim()))
      failed.push({ path: "$." + key, expected: "array of nonempty strings" });
  }
  return failed;
}

/** Shared policy through the Event and Interactive production authoring paths.
 * It only repairs malformed reports: original writer edits and the strict
 * independent changedPaths/native/review gates remain outside this helper. */
export async function requireSpecialistManifest<T>(
  session: AgentSession,
  parse: (text: string) => T,
  stage: "Event" | "Interactive",
  receiptFile?: string,
  beforeCorrection?: () => Promise<void>,
): Promise<T> {
  return recoverResponseContract({
    session, parse, validate: text => {
      const failures = inspectSpecialistManifest(text);
      if (failures.length || stage !== "Event") return failures;
      const obj = lastSpecialistManifest(text)!;
      if (["modifiedRecords", "architecturalConflicts", "laterObligations"]
        .every(key => (obj[key] as string[]).length === 0))
        return [{ path: "$.modifiedRecords|$.architecturalConflicts|$.laterObligations",
          expected: "at least one nonempty report array for an Event response" }];
      return [];
    },
    contract: "specialist.changed-paths.v1", receiptFile, beforeCorrection,
    prompt: text => promptStorySpecialist(session, text),
  });
}
