/** Bounded, controller-assembled causal planning stages. The outline establishes
 * protected decision consequences first; evidence is supplied in small independent
 * batches. No stage is canon, and only the final assembled blueprint can be reviewed. */
import { parseCausalBlueprint, type CausalBlueprint } from "./architecture-blueprint.js";
import { parseBlueprintWire } from "./architecture-blueprint-wire.js";
import { buildBlueprintObligations, type ObligationSources } from "./architecture-blueprint-obligations.js";

export type BlueprintOutline = Omit<CausalBlueprint, "schema" | "beats"> & {
  schema: "noveltea-causal-outline/v1";
  beats: Array<Omit<CausalBlueprint["beats"][number], "observations">>;
};
export type BlueprintEvidence = { id: string; observations: CausalBlueprint["beats"][number]["observations"] };
export const EVIDENCE_BATCH_SIZE = 2;
const PLACEHOLDER = { source: "Internal structural validation only",
  observable: "Pending independently specified evidence",
  supports: "Pending evidence", limits: "No proof before completion" };
const strict = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join("|") === [...keys].sort().join("|");

export function parseBlueprintOutline(text: string): BlueprintOutline {
  const wire = parseBlueprintWire(text, 18000);
  if (wire.format !== "json" ||
      !strict(wire.value, ["schema", "premise", "beats", "resolution"]) ||
      wire.value.schema !== "noveltea-causal-outline/v1" ||
      !Array.isArray(wire.value.beats))
    throw Error("Causal outline must be one complete JSON object with exact outline fields.");
  for (const beat of wire.value.beats) {
    if (!strict(beat, ["id", "purpose", "dependsOn", "change", "decisions"]) &&
        !strict(beat, ["id", "purpose", "dependsOn", "change"]))
      throw Error("Causal outline beats must declare identity, dependencies, change and decisions only.");
  }
  // Reuse the FULL blueprint's strict identity, dependency, resolution and
  // lasting-decision checks. Placeholder evidence is discarded, never persisted,
  // and never presented to the reviewer as an actual planned observation.
  const full = parseCausalBlueprint(JSON.stringify({
    schema: "noveltea-causal-blueprint/v1",
    premise: wire.value.premise, resolution: wire.value.resolution,
    beats: wire.value.beats.map((beat: Record<string, unknown>) => ({
      ...beat, observations: [PLACEHOLDER],
    })),
  }));
  return {
    schema: "noveltea-causal-outline/v1", premise: full.premise,
    beats: full.beats.map(({ observations: _observations, ...beat }) => beat),
    resolution: full.resolution,
  };
}

export function parseBlueprintEvidence(text: string, outline: BlueprintOutline,
  first: number): BlueprintEvidence[] {
  if (!Number.isInteger(first) || first < 0 || first >= outline.beats.length)
    throw Error("Causal evidence batch has an invalid starting beat.");
  const wire = parseBlueprintWire(text, 10000);
  const rows = wire.format === "jsonl" ? wire.values : [wire.value];
  const expected = outline.beats.slice(first, first + EVIDENCE_BATCH_SIZE);
  if (rows.length !== expected.length)
    throw Error("Causal evidence batch must provide exactly " + expected.length +
      " complete beat object(s), in outline order.");
  return rows.map((row, i) => {
    if (!strict(row, ["id", "observations"]) || row.id !== expected[i]?.id ||
        !Array.isArray(row.observations) || row.observations.length > 8)
      throw Error("Causal evidence batch changed outline beat identity or evidence fields.");
    for (const item of row.observations) {
      if (!strict(item, ["source", "observable", "supports", "limits"]) ||
          ["source", "observable", "supports", "limits"].some(field =>
            typeof item[field] !== "string" || !item[field].trim() || item[field].length > 24000))
        throw Error("Causal blueprint evidence must separate source, observation, support and limits.");
    }
    return row as BlueprintEvidence;
  });
}

export function assembleBlueprintStages(outline: BlueprintOutline,
  evidence: BlueprintEvidence[]): CausalBlueprint {
  if (evidence.length !== outline.beats.length ||
      outline.beats.some((beat, i) => beat.id !== evidence[i]?.id))
    throw Error("Causal evidence stages are missing or out of outline order.");
  return parseCausalBlueprint(JSON.stringify({
    schema: "noveltea-causal-blueprint/v1", premise: outline.premise,
    beats: outline.beats.map((beat, i) => ({
      ...beat, observations: evidence[i]!.observations,
    })),
    resolution: outline.resolution,
  }));
}

export function parseBlueprintObligationStage(text: string, blueprint: CausalBlueprint,
  sources: ObligationSources) {
  const wire = parseBlueprintWire(text, 16000);
  const items = wire.format === "jsonl" ? wire.values : [wire.value];
  return buildBlueprintObligations(items, blueprint, sources);
}
