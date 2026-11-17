/** Private causal obligations derived from the approved source and independently reviewed
 * before canonical writing. These are not author consent or canonical Story records. */
import { createHash } from "node:crypto";
import type { CausalBlueprint } from "./architecture-blueprint.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const CATEGORIES = ["what", "when", "who", "how", "why", "consequence", "route", "other"] as const;
type Category = (typeof CATEGORIES)[number];
type Source = "foundation" | "task" | "contract";
export interface BlueprintObligation {
  id: string;
  category: Category;
  source: Source;
  quote: string;
  question: string;
  proof: string;
  route: string;
  beatIds: string[];
}
export interface BlueprintObligations {
  schema: "noveltea-blueprint-obligations/v1";
  sources: { foundationDigest: string; contractDigest: string; taskDigest: string };
  items: BlueprintObligation[];
}
export interface ObligationSources {
  foundation: string;
  task: string;
  contract: unknown;
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
const filled = (v: unknown, max = 4000): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function buildBlueprintObligations(raw: unknown, blueprint: CausalBlueprint,
  sources: ObligationSources): BlueprintObligations {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20)
    throw Error("Causal proof obligations require a bounded source-derived inventory.");
  const ids = new Set(blueprint.beats.map(beat => beat.id));
  const seen = new Set<string>();
  const texts: Record<Source, string> = {
    foundation: sources.foundation, task: sources.task, contract: JSON.stringify(sources.contract),
  };
  for (const item of raw) {
    if (!record(item, ["id", "category", "source", "quote", "question", "proof", "route", "beatIds"]) ||
        typeof item.id !== "string" || !SLUG.test(item.id) || seen.has(item.id) ||
        !CATEGORIES.includes(item.category as Category) ||
        !["foundation", "task", "contract"].includes(String(item.source)) ||
        !filled(item.quote) || item.quote.trim().length < 8 ||
        !texts[item.source as Source].includes(item.quote) ||
        !filled(item.question) || !filled(item.proof) || !filled(item.route) ||
        !Array.isArray(item.beatIds) || !item.beatIds.length || item.beatIds.length > 16 ||
        item.beatIds.some((id: unknown) => typeof id !== "string" || !ids.has(id)) ||
        new Set(item.beatIds).size !== item.beatIds.length)
      throw Error("Causal proof obligation is ungrounded, malformed or refers to an unknown beat.");
    seen.add(item.id);
  }
  return {
    schema: "noveltea-blueprint-obligations/v1",
    sources: {
      foundationDigest: digest(sources.foundation),
      contractDigest: digest(sources.contract),
      taskDigest: digest(sources.task),
    },
    items: raw as BlueprintObligation[],
  };
}
export function validateBlueprintObligations(value: unknown, blueprint: CausalBlueprint,
  sources: ObligationSources): BlueprintObligations {
  if (!record(value, ["schema", "sources", "items"]) ||
      value.schema !== "noveltea-blueprint-obligations/v1" ||
      !record(value.sources, ["foundationDigest", "contractDigest", "taskDigest"]))
    throw Error("Causal proof obligation manifest is missing or malformed.");
  const expected = buildBlueprintObligations(value.items, blueprint, sources);
  if (JSON.stringify(value.sources) !== JSON.stringify(expected.sources))
    throw Error("Causal proof obligations do not match their approved sources.");
  return expected;
}
