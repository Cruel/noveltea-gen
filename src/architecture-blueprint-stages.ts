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
/** Bounded first outline stage: fixes the causal solution and decision graph,
 * without asking the model to also serialize every route consequence. */
export type BlueprintOutlineCore = Omit<
  Extract<BlueprintOutline, { schema: "noveltea-causal-outline/v2" }>,
  "schema" | "routeConsequences"
> & { schema: "noveltea-causal-outline-core/v1" };

export type BlueprintOutlineHeader = {
  schema: "noveltea-causal-outline-header/v1";
  premise: string;
  beatIds: string[];
  resolution: BlueprintOutlineCore["resolution"];
  causalAnswer: BlueprintCausalAnswer;
};
export type BlueprintOutlineBeat = BlueprintOutlineCore["beats"][number];
export const BEAT_BATCH_SIZE = 2;

export type BlueprintChoiceKey = {
  beatId: string;
  decisionIndex: number;
  alternativeIndex: number;
  action: string;
};

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
    if (keys.has(key))
      throw Error("Causal outline has duplicate Choice-route consequences for " + key +
        "; each decision alternative must appear EXACTLY once.");
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
  if (keys.size !== expected) {
    const missing = full.beats.flatMap(beat => beat.decisions.flatMap((decision, decisionIndex) =>
      decision.alternatives.flatMap((_alternative, alternativeIndex) => {
        const key = beat.id + "/" + decisionIndex + "/" + alternativeIndex;
        return keys.has(key) ? [] : [key];
      })));
    throw Error("Causal outline must specify lasting state for EVERY Choice alternative. " +
      "Missing exact beat/decision/alternative keys: " + JSON.stringify(missing) + ".");
  }
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

/** Freeze the causal answer and beat graph first; v1/v2 final outlines retain
 * their historical parsers and recovery compatibility. */
function pendingOutlineBeat(id: string): BlueprintOutlineBeat {
  return { id, purpose: "Structural placeholder awaiting a separate beat stage",
    dependsOn: [], change: "Not authored; cannot count as evidence", decisions: [] };
}

/** First causal stage: a short proposed answer and fixed beat identities.
 * No beat prose or Choice rows are requested from the model yet. */
export function parseBlueprintOutlineHeader(text: string): BlueprintOutlineHeader {
  const wire = parseBlueprintWire(text, 10000);
  if (wire.format !== "json" ||
      !strict(wire.value, ["schema", "premise", "beatIds", "resolution", "causalAnswer"]) ||
      wire.value.schema !== "noveltea-causal-outline-header/v1" ||
      !Array.isArray(wire.value.beatIds) ||
      wire.value.beatIds.some(id => typeof id !== "string"))
    throw Error("Causal outline header requires premise, 2–16 unique ordered beat IDs, resolution and causalAnswer.");
  const core = parseBlueprintOutlineCore(JSON.stringify({
    schema: "noveltea-causal-outline-core/v1",
    premise: wire.value.premise,
    beats: wire.value.beatIds.map(id => pendingOutlineBeat(id as string)),
    resolution: wire.value.resolution, causalAnswer: wire.value.causalAnswer,
  }));
  return {
    schema: "noveltea-causal-outline-header/v1",
    premise: core.premise, beatIds: core.beats.map(beat => beat.id),
    resolution: core.resolution, causalAnswer: core.causalAnswer,
  };
}

/** Freeze each two-beat batch without rewriting earlier accepted identities,
 * decisions or source-bound causal answer. Future beats are placeholders for
 * structural checking only, never persisted or treated as authored content. */
export function parseBlueprintBeatBatch(
  text: string, header: BlueprintOutlineHeader,
  first: number, earlier: BlueprintOutlineBeat[],
): BlueprintOutlineBeat[] {
  if (!Number.isInteger(first) || first < 0 || first >= header.beatIds.length ||
      earlier.length !== first ||
      earlier.some((beat, i) => beat.id !== header.beatIds[i]))
    throw Error("Causal beat batch has stale earlier stages or an invalid starting index.");
  const wire = parseBlueprintWire(text, 11000);
  const rows = wire.format === "jsonl" ? wire.values : [wire.value];
  const expectedIds = header.beatIds.slice(first, first + BEAT_BATCH_SIZE);
  if (rows.length !== expectedIds.length ||
      rows.some((beat, i) =>
        (!strict(beat, ["id", "purpose", "dependsOn", "change", "decisions"]) &&
         !strict(beat, ["id", "purpose", "dependsOn", "change"])) ||
        beat.id !== expectedIds[i]))
    throw Error("Causal beat batch must contain exactly the requested beat IDs and fields, in header order: " +
      JSON.stringify(expectedIds) + ".");
  const checked = assembleBlueprintOutlineCore(
    header, [...earlier, ...(rows as BlueprintOutlineBeat[]),
      ...header.beatIds.slice(first + expectedIds.length).map(pendingOutlineBeat)],
  );
  return checked.beats.slice(first, first + expectedIds.length);
}

export function assembleBlueprintOutlineCore(
  header: BlueprintOutlineHeader, beats: BlueprintOutlineBeat[],
): BlueprintOutlineCore {
  if (beats.length !== header.beatIds.length ||
      beats.some((beat, i) => beat.id !== header.beatIds[i]))
    throw Error("Causal outline beat stages are missing, reordered or changed.");
  return parseBlueprintOutlineCore(JSON.stringify({
    schema: "noveltea-causal-outline-core/v1", premise: header.premise,
    beats, resolution: header.resolution, causalAnswer: header.causalAnswer,
  }));
}

export function parseBlueprintOutlineCore(text: string): BlueprintOutlineCore {
  const wire = parseBlueprintWire(text, 18000);
  if (wire.format !== "json" ||
      !strict(wire.value, ["schema", "premise", "beats", "resolution", "causalAnswer"]) ||
      wire.value.schema !== "noveltea-causal-outline-core/v1")
    throw Error("Causal outline core must have exact schema,premise,beats,resolution,causalAnswer fields.");
  const base = parseBlueprintOutline(JSON.stringify({
    schema: "noveltea-causal-outline/v1",
    premise: wire.value.premise, beats: wire.value.beats, resolution: wire.value.resolution,
  }));
  const full = parseCausalBlueprint(JSON.stringify({
    schema: "noveltea-causal-blueprint/v1",
    premise: base.premise, resolution: base.resolution,
    beats: base.beats.map(beat => ({ ...beat, observations: [PLACEHOLDER] })),
  }));
  return {
    schema: "noveltea-causal-outline-core/v1",
    premise: base.premise, beats: base.beats, resolution: base.resolution,
    causalAnswer: parseCausalAnswer(wire.value.causalAnswer, full),
  };
}

/** Enumerate exact keys so the route stage cannot accidentally duplicate a
 * decision while omitting another. Also used in controller error feedback. */
export function requiredBlueprintRouteChoices(core: BlueprintOutlineCore): BlueprintChoiceKey[] {
  return core.beats.flatMap(beat => beat.decisions.flatMap((decision, decisionIndex) =>
    decision.alternatives.map((alternative, alternativeIndex) => ({
      beatId: beat.id, decisionIndex, alternativeIndex, action: alternative.action,
    }))));
}

export function assembleCurrentBlueprintOutline(
  core: BlueprintOutlineCore, routeConsequences: BlueprintRouteConsequence[],
): Extract<BlueprintOutline, { schema: "noveltea-causal-outline/v2" }> {
  const { schema: _schema, ...body } = core;
  return parseCurrentBlueprintOutline(JSON.stringify({
    schema: "noveltea-causal-outline/v2", ...body, routeConsequences,
  }));
}

export function parseBlueprintRouteStage(text: string, core: BlueprintOutlineCore): BlueprintRouteConsequence[] {
  const required = requiredBlueprintRouteChoices(core);
  if (!required.length) {
    if (text.trim()) throw Error("Causal outline has no Choices; route stage must be empty.");
    return assembleCurrentBlueprintOutline(core, []).routeConsequences;
  }
  const wire = parseBlueprintWire(text, 12000);
  const rows = wire.format === "jsonl" ? wire.values : [wire.value];
  if (rows.length !== required.length)
    throw Error("Causal route stage requires exactly " + required.length +
      " distinct alternative rows; received " + rows.length +
      ". Required beat/decision/alternative keys: " +
      JSON.stringify(required.map(v => [v.beatId, v.decisionIndex, v.alternativeIndex])) + ".");
  return assembleCurrentBlueprintOutline(core, rows as BlueprintRouteConsequence[]).routeConsequences;
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
