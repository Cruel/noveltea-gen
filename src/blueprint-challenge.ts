/** Untrusted source-backed challenges are proposals, never approval or repair authority.
 * Pure checks are shared by the independent review contract and the controller. */
import { isDeepStrictEqual as equal } from "node:util";
import type { MilestoneBlueprint } from "./milestone-blueprint.js";

export interface BlueprintChallenge {
  pinDigest: string;
  field: string;
  before: unknown;
  proposed: unknown;
  sourceQuote: string;
  /** Identifies the exact original promise claimed to be violated. */
  violatedObligation?: string;
}

export interface SpecialistBlueprintChallenge extends BlueprintChallenge {
  path: string;
  line: number;
}

const FIELD = /^(events|downstream)\/(0|[1-9]\d?)\/(purpose|dependsOn|evidence|participants|knowledge|routes|owner|obligation)$/;

export function proposedBlueprintField(design: MilestoneBlueprint, challenge: BlueprintChallenge): MilestoneBlueprint {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge) ||
      Object.keys(challenge).some(key => ![
        "pinDigest", "field", "before", "proposed", "sourceQuote", "violatedObligation",
        "path", "line",
      ].includes(key)) ||
      !/^[0-9a-f]{64}$/.test(challenge.pinDigest) ||
      typeof challenge.sourceQuote !== "string" ||
      challenge.sourceQuote !== challenge.sourceQuote.trim() ||
      challenge.sourceQuote.length < 8 || challenge.sourceQuote.length > 1000 ||
      challenge.violatedObligation !== undefined &&
        (typeof challenge.violatedObligation !== "string" ||
          challenge.violatedObligation.length < 8 || challenge.violatedObligation.length > 1000) ||
      challenge.proposed === undefined || !FIELD.test(challenge.field))
    throw Error("Invalid source-bound material Blueprint challenge.");
  const [, group, index, field] = FIELD.exec(challenge.field)!;
  if (group === "events" && ["owner", "obligation"].includes(field!) ||
      group === "downstream" && !["owner", "obligation"].includes(field!))
    throw Error("Blueprint challenge selects a field outside its material owner.");
  const result = structuredClone(design);
  const entry = result[group as "events" | "downstream"][Number(index)] as unknown as Record<string, unknown> | undefined;
  if (!entry || !Object.hasOwn(entry, field!) || !equal(entry[field!], challenge.before))
    throw Error("Blueprint finding does not match the original material field.");
  const original = typeof challenge.before === "string" ? challenge.before : JSON.stringify(challenge.before);
  if (challenge.violatedObligation && !original.includes(challenge.violatedObligation))
    throw Error("Blueprint challenge does not cite its original violated obligation.");
  entry[field!] = challenge.proposed;
  if (equal(result, design)) throw Error("Blueprint challenge does not change a material obligation.");
  return result;
}

/** The cited line must belong to the independent review's sealed canonical
 * packet, and to a record actually changed by the claimed specialist. */
export function sourceBoundBlueprintChallenge(
  design: MilestoneBlueprint, pinDigest: string, challenge: BlueprintChallenge,
  citation: { path: string; line: number }, source: { path: string; content: string } | undefined,
  changedPaths: readonly string[]): MilestoneBlueprint {
  const specialist = challenge as Partial<SpecialistBlueprintChallenge>;
  if (specialist.path !== undefined && specialist.path !== citation.path ||
      specialist.line !== undefined && specialist.line !== citation.line ||
      challenge?.pinDigest !== pinDigest || !source ||
      !changedPaths.includes(citation.path) || source.path !== citation.path ||
      !Number.isSafeInteger(citation.line) || citation.line < 1 ||
      source.content.split(/\r?\n/)[citation.line - 1]?.trim() !== challenge.sourceQuote)
    throw Error("Blueprint challenge is not bound to the reviewed specialist source.");
  return proposedBlueprintField(design, challenge);
}
