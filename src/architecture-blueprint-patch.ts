/** Deterministic, append-or-exact-replace corrections to one reviewed causal
 * blueprint version. A model cannot rewrite the prior design, grant scope or
 * erase unrelated evidence/Choice consequences. Semantic approval is separate. */
import { createHash } from "node:crypto";
import { parseCausalBlueprint, type BlueprintReview, type CausalBlueprint } from "./architecture-blueprint.js";
import { parseBlueprintWire } from "./architecture-blueprint-wire.js";

export const blueprintDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Beat = CausalBlueprint["beats"][number];
type Observation = Beat["observations"][number];
type Decision = Beat["decisions"][number];
type PatchOp =
  | { kind: "replace"; findingBeatId: string; path: string; expected: string; value: string }
  | { kind: "append-observation"; findingBeatId: string; beatId: string; value: Observation }
  | { kind: "append-decision"; findingBeatId: string; beatId: string; value: Decision }
  | { kind: "add-dependency"; findingBeatId: string; beatId: string; dependsOn: string }
  | { kind: "insert-beat"; findingBeatId: string; afterBeatId: string; beat: Beat }
  | { kind: "support-resolution"; findingBeatId: string; beatId: string };
export interface BlueprintPatch {
  schema: "noveltea-blueprint-patch/v1";
  baseDigest: string;
  reviewDigest: string;
  operations: PatchOp[];
}
const filled = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 24000;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
function parsePatchJson(text: string): unknown {
  const wire = parseBlueprintWire(text, 24000);
  if (wire.format === "json") return wire.value;
  if (wire.values.length < 2 || wire.values.length > 49)
    throw Error("Blueprint patch JSONL needs one header and 1–48 patch operations.");
  const [header, ...operations] = wire.values;
  if (!exact(header, ["schema", "baseDigest", "reviewDigest"]))
    throw Error("Blueprint JSONL patch header has unexpected fields.");
  return { ...header, operations };
}
function descendants(blueprint: CausalBlueprint, from: string) {
  const affected = new Set([from]);
  for (const beat of blueprint.beats)
    if (beat.dependsOn.some(id => affected.has(id))) affected.add(beat.id);
  return affected;
}

/** Explain exact reviewer-finding authority without granting any new patch scope. */
export function allowedBlueprintPatchTargets(base: CausalBlueprint, review: BlueprintReview) {
  const ids = [...new Set(review.findings.map(f => f.beatId))];
  return ids.map(findingBeatId => ({
    findingBeatId, targetBeatIds: [...descendants(base, findingBeatId)],
  }));
}

/** Parse then apply to a clone; only the resolved full blueprint is reviewed.
 * Every op must reference an actual finding from the immediately prior verdict. */
export function applyBlueprintPatch(base: CausalBlueprint, review: BlueprintReview,
  raw: unknown): { patch: BlueprintPatch; blueprint: CausalBlueprint } {
  if (review.status !== "revise" || !review.findings.length)
    throw Error("A blueprint patch requires an independent revise verdict.");
  if (!exact(raw, ["schema", "baseDigest", "reviewDigest", "operations"]) ||
      raw.schema !== "noveltea-blueprint-patch/v1" ||
      raw.baseDigest !== blueprintDigest(base) ||
      raw.reviewDigest !== blueprintDigest(review) ||
      !Array.isArray(raw.operations) || !raw.operations.length || raw.operations.length > 48)
    throw Error("Blueprint patch has stale or invalid review and source digests.");
  const patch = raw as unknown as BlueprintPatch;
  const next: CausalBlueprint = structuredClone(base);
  const findings = new Set(review.findings.map(f => f.beatId));
  const invalid = patch.operations.map((op, index) => ({
    index, findingBeatId: op && typeof op === "object" && "findingBeatId" in op
      ? op.findingBeatId : "(missing)",
  })).filter(op => !findings.has(op.findingBeatId));
  if (invalid.length)
    throw Error("Blueprint patch refers to a missing reviewer finding: " +
      JSON.stringify(invalid) + ". Only the ORIGINAL reviewer findingBeatId " +
      "values and their descendant targetBeatIds are permitted: " +
      JSON.stringify(allowedBlueprintPatchTargets(base, review)) +
      ". The findingBeatId names the reviewer concern, NOT the edited target beat.");
  const touched = new Set<string>();
  const inserted = new Map<string, string>();
  for (const op of patch.operations) {
    const permitted = descendants(base, op.findingBeatId);
    const target = "beatId" in op ? op.beatId :
      "afterBeatId" in op ? op.afterBeatId : undefined;
    if (target !== undefined && !permitted.has(target) &&
        inserted.get(target) !== op.findingBeatId)
      throw Error("Blueprint patch modifies an unrelated beat without a reviewer finding.");
    const unique = op.kind === "replace" ? op.path :
      op.kind === "insert-beat" ? "insert:" + op.beat.id :
      op.kind + ":" + target;
    if (touched.has(unique) && op.kind !== "append-observation" && op.kind !== "append-decision")
      throw Error("Blueprint patch has conflicting operations.");
    touched.add(unique);

    if (op.kind === "replace") {
      if (!exact(op, ["kind", "findingBeatId", "path", "expected", "value"]) ||
          !filled(op.expected) || !filled(op.value) || op.expected === op.value)
        throw Error("Blueprint patch contains an invalid exact text replacement.");
      let holder: Record<string, unknown>;
      let key: string;
      if (base.schema === "noveltea-causal-blueprint/v2" &&
          (op.path.startsWith("causalAnswer/") || op.path.startsWith("feasibility/"))) {
        const parts = op.path.split("/");
        const [section, field] = parts;
        const allowed = section === "causalAnswer" ?
          ["answer", "mechanism", "responsibility", "motive", "proofApproach"] :
          ["playthrough", "interaction", "production", "endings"];
        if (parts.length !== 2 || !field || !allowed.includes(field))
          throw Error("Compact Blueprint patch may not rewrite original protected questions.");
        holder = next[section as "causalAnswer" | "feasibility"] as Record<string, unknown>;
        key = field;
      } else if (base.schema === "noveltea-causal-blueprint/v2" &&
                 op.path.startsWith("arcs/")) {
        const parts = op.path.split("/");
        const arc = parts.length === 3 && parts[2] === "goal" &&
          next.arcs?.find(item => item.id === parts[1]);
        if (!arc) throw Error("Compact Blueprint patch references an unknown Arc goal.");
        holder = arc as unknown as Record<string, unknown>;
        key = "goal";
      } else if (op.path.startsWith("resolution/")) {
        key = op.path.slice("resolution/".length);
        if (!["conclusion", "uncertainty"].includes(key))
          throw Error("Blueprint patch may not rewrite its source-grounded question.");
        holder = next.resolution as unknown as Record<string, unknown>;
      } else {
        const parts = op.path.split("/");
        if (parts[0] !== "beats" || parts.length < 3 ||
            !permitted.has(parts[1]!) || !next.beats.some(b => b.id === parts[1]))
          throw Error("Blueprint patch replacement is outside reviewer findings.");
        const beat = next.beats.find(b => b.id === parts[1])!;
        if (parts.length === 3 && ["purpose", "change"].includes(parts[2]!)) {
          holder = beat as unknown as Record<string, unknown>;
          key = parts[2]!;
        } else if (parts.length === 5 && parts[2] === "observations" &&
                   /^(0|[1-9][0-9]*)$/.test(parts[3]!) &&
                   ["source", "observable", "supports", "limits"].includes(parts[4]!)) {
          const obs = beat.observations[Number(parts[3])];
          if (!obs) throw Error("Blueprint patch references missing evidence.");
          holder = obs as unknown as Record<string, unknown>;
          key = parts[4]!;
        } else if (parts.length === 7 && parts[2] === "decisions" &&
                   /^(0|[1-9][0-9]*)$/.test(parts[3]!) &&
                   parts[4] === "alternatives" &&
                   /^(0|[1-9][0-9]*)$/.test(parts[5]!) &&
                   parts[6] === "lastingEffect") {
          const alt = beat.decisions[Number(parts[3])]?.alternatives[Number(parts[5])];
          if (!alt) throw Error("Blueprint patch references missing alternative.");
          holder = alt as unknown as Record<string, unknown>;
          key = "lastingEffect";
          if (!op.value.includes(op.expected))
            throw Error("Blueprint patch cannot erase a prior Choice consequence.");
        } else throw Error("Blueprint patch path cannot replace decisions, IDs or structure.");
      }
      if (holder[key] !== op.expected) throw Error("Blueprint patch expected old value is stale.");
      holder[key] = op.value;
    } else if (op.kind === "append-observation") {
      if (base.schema === "noveltea-causal-blueprint/v2")
        throw Error("Compact Story Blueprint corrections cannot add local evidence inventories.");
      if (!exact(op, ["kind", "findingBeatId", "beatId", "value"]))
        throw Error("Blueprint patch evidence operation is malformed.");
      const beat = next.beats.find(b => b.id === op.beatId);
      if (!beat) throw Error("Blueprint patch references unknown beat.");
      beat.observations.push(op.value);
    } else if (op.kind === "append-decision") {
      if (!exact(op, ["kind", "findingBeatId", "beatId", "value"]))
        throw Error("Blueprint patch decision operation is malformed.");
      const beat = next.beats.find(b => b.id === op.beatId);
      if (!beat) throw Error("Blueprint patch references unknown beat.");
      beat.decisions.push(op.value);
    } else if (op.kind === "add-dependency") {
      if (!exact(op, ["kind", "findingBeatId", "beatId", "dependsOn"]))
        throw Error("Blueprint patch dependency operation is malformed.");
      const beat = next.beats.find(b => b.id === op.beatId);
      if (!beat || typeof op.dependsOn !== "string" ||
          beat.dependsOn.includes(op.dependsOn))
        throw Error("Blueprint patch dependency is duplicate or unknown.");
      beat.dependsOn.push(op.dependsOn);
    } else if (op.kind === "insert-beat") {
      if (!exact(op, ["kind", "findingBeatId", "afterBeatId", "beat"]) ||
          next.beats.some(b => b.id === op.beat?.id))
        throw Error("Blueprint patch insertion duplicates an existing beat.");
      const index = next.beats.findIndex(b => b.id === op.afterBeatId);
      if (index < 0) throw Error("Blueprint patch insertion anchor is unknown.");
      next.beats.splice(index + 1, 0, op.beat);
      inserted.set(op.beat.id, op.findingBeatId);
    } else if (op.kind === "support-resolution") {
      if (!exact(op, ["kind", "findingBeatId", "beatId"]) ||
          !next.beats.some(b => b.id === op.beatId) ||
          next.resolution.supportedBy.includes(op.beatId))
        throw Error("Blueprint patch adds invalid resolution support.");
      next.resolution.supportedBy.push(op.beatId);
    } else throw Error("Blueprint patch operation is not authorized.");
  }
  // Validate the whole design after every patch; this also detects new cycles,
  // structurally invalid evidence and additions that break the byte budget.
  const resolved = parseCausalBlueprint(JSON.stringify(next));
  if (resolved.schema === "noveltea-causal-blueprint/v2" &&
      resolved.beats.some(beat => beat.observations.length))
    throw Error("Compact Story Blueprint correction introduced local evidence inventory.");
  // No preexisting beat, decision, alternative, observation or source promise
  // can disappear just because the model rewrote its proposed patch.
  const oldIds = base.beats.map(b => b.id);
  const retained = resolved.beats.filter(b => oldIds.includes(b.id));
  if (JSON.stringify(retained.map(b => b.id)) !== JSON.stringify(oldIds) ||
      base.beats.some(b => {
        const after = resolved.beats.find(n => n.id === b.id)!;
        return after.decisions.length < b.decisions.length ||
          after.observations.length < b.observations.length ||
          b.decisions.some((d, i) => {
            const current = after.decisions[i]!;
            return current.question !== d.question ||
              current.alternatives.length !== d.alternatives.length ||
              d.alternatives.some((a, j) =>
                current.alternatives[j]?.action !== a.action ||
                !current.alternatives[j]?.lastingEffect.includes(a.lastingEffect));
          });
      }))
    throw Error("Blueprint patch erased existing choices, evidence or beat continuity.");
  return { patch, blueprint: resolved };
}
export function parseBlueprintPatch(text: string, base: CausalBlueprint,
  review: BlueprintReview) {
  return applyBlueprintPatch(base, review, parsePatchJson(text));
}
