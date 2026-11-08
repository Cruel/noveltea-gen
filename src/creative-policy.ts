/** Versioned author preference, never a capability grant.  It cannot override
 * protected-canon approval, the native validator, scope or reviewer policy. */
export type CreativeMode = "autonomous" | "collaborative";
export type CreativePolicy = Readonly<{ version: 1; mode: CreativeMode }>;
export const DEFAULT_CREATIVE_POLICY: CreativePolicy = Object.freeze({ version: 1, mode: "autonomous" });
export const DEFAULT_CREATIVE_POLICY_JSON = '{"version":1,"mode":"autonomous"}';

export function validCreativeMode(value: unknown): value is CreativeMode {
  return value === "autonomous" || value === "collaborative";
}
export function creativePolicy(mode: CreativeMode): CreativePolicy {
  if (!validCreativeMode(mode)) throw new Error("Unknown creative mode.");
  return { version: 1, mode };
}
export function parseCreativePolicy(value: unknown): CreativePolicy {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); }
    catch { throw new Error("Creative policy receipt is not valid JSON."); }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "mode,version" ||
      (candidate as CreativePolicy).version !== 1 ||
      !validCreativeMode((candidate as CreativePolicy).mode))
    throw new Error("Unknown or invalid creative policy receipt; do not reinterpret on restart.");
  return creativePolicy((candidate as CreativePolicy).mode);
}

export type CreativeChoiceKind = "routine" | "creative-ambiguity" | "consequential" |
  "blocked" | "protected-canon" | "invalid-change";
export type CreativeDisposition = "proceed" | "ask-author" | "deny";
/** Deterministic controller routing. Specialist text never establishes authority. */
export function routeCreativeChoice(policy: CreativePolicy, kind: CreativeChoiceKind): CreativeDisposition {
  const { mode } = parseCreativePolicy(policy);
  if (kind === "protected-canon" || kind === "invalid-change") return "deny";
  if (kind === "blocked" || kind === "consequential") return "ask-author";
  if (kind === "creative-ambiguity" && mode === "collaborative") return "ask-author";
  return "proceed";
}

/** Narrow, deterministic evidence for an unresolved ordinary alternative in
 * the request itself; not a semantic parser or an approval mechanism. */
export function hasExplicitCreativeAlternatives(request: string): boolean {
  return /\beither\b[^.!?\n]{1,180}\bor\b/i.test(request) ||
    /\b(?:choose|pick|decide)\s+between\b/i.test(request);
}

export function creativePolicyInstruction(policy: CreativePolicy): string {
  const mode = parseCreativePolicy(policy).mode;
  return mode === "collaborative"
    ? "CREATIVE INITIATIVE (Collaborative): Ask the author before resolving genuinely open creative alternatives or consequential artistic direction. Do not interrupt for syntax, validator repairs or mechanical details. "
    : "CREATIVE INITIATIVE (Autonomous): Resolve ordinary open artistic alternatives yourself within existing Story canon and the authorized scope. Ask only when truly blocked or when a consequential author choice cannot safely be inferred. ";
}
