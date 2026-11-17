/** Bounded, controller-assembled causal planning stages. The outline establishes
 * protected decision consequences first; evidence is supplied in small independent
 * batches. No stage is canon, and only the final assembled blueprint can be reviewed. */
import { parseCausalBlueprint, type CausalBlueprint } from "./architecture-blueprint.js";
import { parseBlueprintWire } from "./architecture-blueprint-wire.js";
import { buildBlueprintObligations, type ObligationSources } from "./architecture-blueprint-obligations.js";

type OutlineBody = Omit<CausalBlueprint, "schema" | "beats"> & {
  beats: Array<Omit<CausalBlueprint["beats"][number], "observations">>;
};
export type BlueprintCausalAnswer = {
  question: string;
  answer: string;
  mechanism: string;
  responsibility: string;
  motive: string;
  misdirection: { signal: string; falseInference: string; actualExplanation: string };
  proof: { directTest: string; corroboration: string; refusalFallback: string; beatIds: string[] };
};
export type BlueprintRouteConsequence = {
  beatId: string;
  decisionIndex: number;
  alternativeIndex: number;
  laterBeatId: string;
  preserved: string;
  foregone: string;
  persistentEffect: string;
};
export type BlueprintOutline = OutlineBody &
  (
    | { schema: "noveltea-causal-outline/v1" }
    | {
        schema: "noveltea-causal-outline/v2";
        causalAnswer: BlueprintCausalAnswer;
        routeConsequences: BlueprintRouteConsequence[];
      }
  );
export type BlueprintEvidence = {
  id: string;
  observations: CausalBlueprint["beats"][number]["observations"];
};
export const EVIDENCE_BATCH_SIZE = 2;
const PLACEHOLDER = {
  source: "Internal structural validation only",
  observable: "Pending independently specified evidence",
  supports: "Pending evidence",
  limits: "No proof before completion",
};
const strict = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const filled = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 1500;
// A proposed solution may not be punted to later writing. Uncertainty is
// legitimate, but the central answer must be a concrete testable hypothesis.
const DEFERRED_ANSWER =
  /\b(?:will (?:later )?be (?:determined|established|designed|specified)|(?:remain|remains) to be (?:determined|established|designed|specified)|not yet (?:specified|determined|known)|(?:culprit|mechanism|motive|answer) (?:is|remains) (?:unknown|undetermined)|foundation does not (?:specify|determine)|to be developed in later)\b/i;
const answerKeys = ["question", "answer", "mechanism", "responsibility", "motive", "misdirection", "proof"];

function parseCausalAnswer(value: unknown, full: CausalBlueprint): BlueprintCausalAnswer {
  if (!strict(value, answerKeys)) throw Error("Causal outline requires a complete proposed causal answer.");
  const misdirection = value.misdirection as Record<string, unknown>;
  const proof = value.proof as Record<string, unknown>;
  if (
    !["question", "answer", "mechanism", "responsibility", "motive"].every(
      (k) => filled(value[k]) && !DEFERRED_ANSWER.test(value[k] as string),
    ) ||
    !strict(misdirection, ["signal", "falseInference", "actualExplanation"]) ||
    !["signal", "falseInference", "actualExplanation"].every((k) => filled(misdirection[k])) ||
    !strict(proof, ["directTest", "corroboration", "refusalFallback", "beatIds"]) ||
    !["directTest", "corroboration", "refusalFallback"].every((k) => filled(proof[k])) ||
    !Array.isArray(proof.beatIds) ||
    !proof.beatIds.length ||
    proof.beatIds.length > full.beats.length ||
    proof.beatIds.some((id) => typeof id !== "string" || !full.resolution.supportedBy.includes(id)) ||
    new Set(proof.beatIds).size !== proof.beatIds.length ||
    DEFERRED_ANSWER.test(full.resolution.conclusion)
  )
    throw Error(
      "Causal outline must commit to a concrete testable answer, mechanism, responsibility and proof; do not defer the solution to Story writing.",
    );
  return value as BlueprintCausalAnswer;
}
function parseRouteConsequences(value: unknown, full: CausalBlueprint): BlueprintRouteConsequence[] {
  if (!Array.isArray(value) || value.length > 64)
    throw Error("Causal outline must enumerate exact persistent Choice-route consequences.");
  const byId = new Map(full.beats.map((beat, i) => [beat.id, i]));
  const keys = new Set<string>();
  const effects = new Map<string, Set<string>>();
  for (const consequence of value) {
    if (
      !strict(consequence, [
        "beatId",
        "decisionIndex",
        "alternativeIndex",
        "laterBeatId",
        "preserved",
        "foregone",
        "persistentEffect",
      ]) ||
      typeof consequence.beatId !== "string" ||
      !Number.isInteger(consequence.decisionIndex) ||
      !Number.isInteger(consequence.alternativeIndex) ||
      !filled(consequence.preserved) ||
      !filled(consequence.foregone) ||
      !filled(consequence.persistentEffect)
    )
      throw Error("Causal outline Choice-route entry must contain concrete, indexed lasting state.");
    const index = byId.get(consequence.beatId);
    const alt =
      index === undefined
        ? undefined
        : full.beats[index]?.decisions[consequence.decisionIndex as number]?.alternatives[
            consequence.alternativeIndex as number
          ];
    const later = byId.get(consequence.laterBeatId as string);
    const connected = new Set([consequence.beatId]);
    for (let j = (index ?? 0) + 1; later !== undefined && j <= later; j++) {
      const beat = full.beats[j]!;
      if (beat.dependsOn.some((id) => connected.has(id))) connected.add(beat.id);
    }
    if (
      !alt ||
      (consequence.laterBeatId !== "resolution" &&
        (later === undefined || later <= index! || !connected.has(consequence.laterBeatId as string)))
    )
      throw Error("Causal outline Choice-route entry must name a reachable later beat or the resolution.");
    const key = consequence.beatId + "/" + consequence.decisionIndex + "/" + consequence.alternativeIndex;
    if (keys.has(key)) throw Error("Causal outline has duplicate Choice-route consequences.");
    keys.add(key);
    const decisionKey = consequence.beatId + "/" + consequence.decisionIndex;
    const normalized = JSON.stringify([
      consequence.preserved,
      consequence.foregone,
      consequence.persistentEffect,
    ]);
    const other = effects.get(decisionKey) ?? new Set<string>();
    if (other.has(normalized))
      throw Error("Causal outline Choice alternatives have indistinguishable persistent outcomes.");
    other.add(normalized);
    effects.set(decisionKey, other);
  }
  const expected = full.beats.reduce(
    (sum, beat) => sum + beat.decisions.reduce((n, d) => n + d.alternatives.length, 0),
    0,
  );
  if (keys.size !== expected)
    throw Error("Causal outline must specify lasting state for EVERY Choice alternative.");
  return value as BlueprintRouteConsequence[];
}

export function parseBlueprintOutline(text: string): BlueprintOutline {
  const wire = parseBlueprintWire(text, 24000);
  const v2 =
    wire.format === "json" &&
    !!wire.value &&
    typeof wire.value === "object" &&
    "schema" in wire.value &&
    wire.value.schema === "noveltea-causal-outline/v2";
  if (
    wire.format !== "json" ||
    !strict(
      wire.value,
      v2
        ? ["schema", "premise", "beats", "resolution", "causalAnswer", "routeConsequences"]
        : ["schema", "premise", "beats", "resolution"],
    ) ||
    !["noveltea-causal-outline/v1", "noveltea-causal-outline/v2"].includes(String(wire.value.schema)) ||
    !Array.isArray(wire.value.beats)
  )
    throw Error("Causal outline must be one complete JSON object with exact outline fields.");
  for (const beat of wire.value.beats) {
    if (
      !strict(beat, ["id", "purpose", "dependsOn", "change", "decisions"]) &&
      !strict(beat, ["id", "purpose", "dependsOn", "change"])
    )
      throw Error("Causal outline beats must declare identity, dependencies, change and decisions only.");
  }
  // Reuse the FULL blueprint's strict identity, dependency, resolution and
  // lasting-decision checks. Placeholder evidence is discarded, never persisted,
  // and never presented to the reviewer as an actual planned observation.
  const full = parseCausalBlueprint(
    JSON.stringify({
      schema: "noveltea-causal-blueprint/v1",
      premise: wire.value.premise,
      resolution: wire.value.resolution,
      beats: wire.value.beats.map((beat: Record<string, unknown>) => ({
        ...beat,
        observations: [PLACEHOLDER],
      })),
    }),
  );
  const body = {
    premise: full.premise,
    beats: full.beats.map(({ observations: _observations, ...beat }) => beat),
    resolution: full.resolution,
  };
  if (v2)
    return {
      schema: "noveltea-causal-outline/v2",
      ...body,
      causalAnswer: parseCausalAnswer(wire.value.causalAnswer, full),
      routeConsequences: parseRouteConsequences(wire.value.routeConsequences, full),
    };
  return { schema: "noveltea-causal-outline/v1", ...body };
}

/** New unapproved planning must supply a testable causal answer and concrete
 * Choice-route states. Historical v1 receipts remain readable for recovery. */
export function parseCurrentBlueprintOutline(
  text: string,
): Extract<BlueprintOutline, { schema: "noveltea-causal-outline/v2" }> {
  const outline = parseBlueprintOutline(text);
  if (outline.schema !== "noveltea-causal-outline/v2")
    throw Error("New causal plans require the complete v2 answer and per-Choice route-state contract.");
  return outline;
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
