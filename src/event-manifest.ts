import { lastSpecialistManifest } from "./specialist-manifest.js";
import type { CausalDiscovery } from "./causal-amendment.js";

export function parseEventManifest(text: string): { modifiedRecords: string[]; architecturalConflicts: string[];
  laterObligations: string[]; causalDiscovery?: CausalDiscovery;
  blueprintChallenge?: import("./blueprint-challenge.js").SpecialistBlueprintChallenge } {
  const obj = lastSpecialistManifest(text);
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(x => typeof x === "string" && x.trim().length > 0);
  if (!obj || !strings(obj.modifiedRecords) ||
      !strings(obj.architecturalConflicts) || !strings(obj.laterObligations) ||
      (!obj.modifiedRecords.length && !obj.architecturalConflicts.length &&
        !obj.laterObligations.length)) {
    throw new Error("Event specialist must return a JSON manifest with modifiedRecords, architecturalConflicts and laterObligations.");
  }
  let causalDiscovery: CausalDiscovery | undefined;
  if (obj.causalDiscovery !== undefined) {
    const claim = obj.causalDiscovery as Partial<CausalDiscovery> | null;
    const keys = ["sourcePath", "sourceQuote", "violatedObligation", "proposedCorrection"];
    if (!claim || typeof claim !== "object" || Array.isArray(claim) ||
        Object.keys(claim).sort().join("|") !== keys.sort().join("|") ||
        obj.modifiedRecords.length || !obj.architecturalConflicts.length ||
        keys.some(key => typeof claim[key as keyof CausalDiscovery] !== "string" ||
          !(claim[key as keyof CausalDiscovery] as string).trim() ||
          (claim[key as keyof CausalDiscovery] as string).length > 1000))
      throw Error("Causal discovery must be an exact no-write source-bound prerequisite claim.");
    causalDiscovery = claim as CausalDiscovery;
  }
  let blueprintChallenge: import("./blueprint-challenge.js").SpecialistBlueprintChallenge | undefined;
  if (obj.blueprintChallenge !== undefined) {
    const challenge = obj.blueprintChallenge as Record<string, unknown> | null;
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge) ||
        Object.keys(challenge).some(key => ![
          "path", "line", "pinDigest", "field", "before", "proposed", "sourceQuote", "violatedObligation",
        ].includes(key)) ||
        !obj.modifiedRecords.length || !challenge.path ||
        typeof challenge.path !== "string" || !obj.modifiedRecords.includes(challenge.path) ||
        !Number.isSafeInteger(challenge.line) || (challenge.line as number) < 1 ||
        !/^[0-9a-f]{64}$/.test(String(challenge.pinDigest)) ||
        typeof challenge.field !== "string" || !/^(events|downstream)\/[0-9]+\/[a-zA-Z]+$/.test(challenge.field) ||
        typeof challenge.sourceQuote !== "string" || challenge.sourceQuote.length < 8 ||
        typeof challenge.violatedObligation !== "string" ||
        challenge.violatedObligation.length < 8 ||
        challenge.before === undefined || challenge.proposed === undefined)
      throw Error("Event specialist Blueprint challenge must cite one changed Event source and approved field.");
    blueprintChallenge = challenge as unknown as import("./blueprint-challenge.js").SpecialistBlueprintChallenge;
  }
  return { modifiedRecords: obj.modifiedRecords, architecturalConflicts: obj.architecturalConflicts,
    laterObligations: obj.laterObligations, ...(causalDiscovery ? { causalDiscovery } : {}),
    ...(blueprintChallenge ? { blueprintChallenge } : {}) };
}
