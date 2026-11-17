import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBlueprintObligations, validateBlueprintObligations } from "../src/architecture-blueprint-obligations.js";
import { applyBlueprintPatch, allowedBlueprintPatchTargets, blueprintDigest,
  parseBlueprintPatch } from "../src/architecture-blueprint-patch.js";
import { parseCausalBlueprint, parseInitialBlueprint } from "../src/architecture-blueprint.js";
import type { BlueprintReview, CausalBlueprint } from "../src/architecture-blueprint.js";

const example: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v1",
  premise: "Find the truth without betraying the witness",
  beats: [
    { id: "catalog", purpose: "Identify original archive discrepancy", dependsOn: [],
      observations: [
        { source: "dated photo", observable: "The register initially shows a full page",
          supports: "Page was once present", limits: "No date of replacement" },
        { source: "inventory sheet", observable: "Ledger number matches a record",
          supports: "Ledger exists", limits: "Does not identify a custodian" },
      ], change: "Investigator follows physical evidence", decisions: [] },
    { id: "witness", purpose: "Secure testimony or corroborate refusal", dependsOn: ["catalog"],
      observations: [{ source: "preserved log", observable: "The clerk left at dusk",
        supports: "A departure occurred", limits: "Not a destination" }],
      change: "Both routes can investigate without exposing identity",
      decisions: Array.from({ length: 4 }, (_, i) => ({
        question: `Protect source route ${i}?`,
        alternatives: [
          { action: `Protect ${i}`, lastingEffect: `Privacy preserved ${i}` },
          { action: `Disclose ${i}`, lastingEffect: `Trust damaged ${i}` },
        ],
      })) },
    { id: "resolution", purpose: "Demonstrate what actually happened", dependsOn: ["witness"],
      observations: [{ source: "verified shelter register", observable: "Clerk arrived",
        supports: "Arrival is authenticated", limits: "Not proof of intent" }],
      change: "Choose protective or public accounting",
      decisions: Array.from({ length: 3 }, (_, i) => ({
        question: `Final accountability route ${i}?`,
        alternatives: [
          { action: `Publish ${i}`, lastingEffect: `Institution learns ${i}` },
          { action: `Protect ${i}`, lastingEffect: `Anonymity holds ${i}` },
        ],
      })) },
  ],
  resolution: { question: "Where did the clerk go?",
    conclusion: "The clerk was seen at the shelter but the motive is still uncertain.",
    supportedBy: ["witness", "resolution"], uncertainty: "The other record owner remains unknown." },
};
const clone = <T>(v: T): T => structuredClone(v);
const review: BlueprintReview = {
  status: "revise", findings: [
    { beatId: "witness", reason: "Witness refusal hides independent proof",
      correction: "Add a source that works without witness testimony" },
  ],
};
const patch = (operations: unknown[], base = example, verdict = review) => ({
  schema: "noveltea-blueprint-patch/v1",
  baseDigest: blueprintDigest(base), reviewDigest: blueprintDigest(verdict), operations,
});
const replace = (path: string, expected: string, value: string, findingBeatId = "witness") => ({
  kind: "replace", findingBeatId, path, expected, value,
});

test("source-quoted proof obligations bind to original task, foundation, contract and beat identity", () => {
  const sources = {
    task: "Make me a mystery game where the source may refuse cooperation",
    foundation: "Protect witnesses while resolving the central mystery.",
    contract: { hardLimits: ["Do not expose the source"] },
  };
  const items = [
    { id: "resolve-mystery", category: "what", source: "foundation",
      quote: "resolving the central mystery",
      question: "What happened?", proof: "Authenticated route-independent records",
      route: "Refusing testimony must still be playable", beatIds: ["witness", "resolution"] },
    { id: "maintain-privacy", category: "consequence", source: "contract",
      quote: "Do not expose the source", question: "Will the witness be protected?",
      proof: "Route-specific later state", route: "Each alternative must preserve its outcome",
      beatIds: ["witness", "resolution"] },
  ];
  const manifest = buildBlueprintObligations(items, example, sources);
  assert.deepEqual(validateBlueprintObligations(manifest, example, sources), manifest);
  assert.throws(() => validateBlueprintObligations(manifest, example,
    { ...sources, foundation: "a different protected choice" }), /quotes text absent/);
  assert.throws(() => buildBlueprintObligations([{ ...items[0], quote: "invented promise" }],
    example, sources), /resolve-mystery.*quotes text absent.*foundation source/);
  assert.throws(() => buildBlueprintObligations([{ ...items[0], beatIds: ["invented-beat"] }],
    example, sources), /unknown beat/);
  assert.throws(() => buildBlueprintObligations([items[0], items[0]], example, sources),
    /ungrounded/);
});

test("targeted reviewer correction retains all seven Choices, another clue and original source promises", () => {
  const operations = [
    replace("beats/witness/observations/0/limits", "Not a destination",
      "Not a destination, and testimony is not required"),
    { kind: "append-observation", findingBeatId: "witness", beatId: "witness",
      value: { source: "dated independent arrival record", observable: "Clerk signed the public registry",
        supports: "Arrival independently established", limits: "Still does not establish motive" } },
    replace("beats/resolution/change", "Choose protective or public accounting",
      "Choose protective or public accounting while retaining all seven route-specific effects"),
  ];
  const result = parseBlueprintPatch(JSON.stringify(patch(operations)), example, review);
  assert.equal(result.blueprint.beats.reduce((total, beat) => total + beat.decisions.length, 0), 7);
  assert.deepEqual(result.blueprint.beats[0], example.beats[0]);
  assert.equal(result.blueprint.beats[1]!.observations.length, 2);
  assert.deepEqual(result.blueprint.beats[1]!.decisions, example.beats[1]!.decisions);
  assert.deepEqual(result.blueprint.beats[2]!.decisions, example.beats[2]!.decisions);
  assert.deepEqual(example.beats[1]!.observations.map(o => o.limits), ["Not a destination"],
    "patch application must not mutate a reviewed version");
  assert.deepEqual(applyBlueprintPatch(example, review, result.patch).blueprint, result.blueprint,
    "immutable patch deterministically reconstructs the exact reviewed draft");
});

test("strict JSONL initial blueprint and operations preserve exact normalized design and immutable review binding", () => {
  const sources = { foundation: "The witness remains protected during the mystery.",
    task: "Write a mystery with a protected witness", contract: {} };
  const obligation = {
    id: "protect-witness", category: "consequence", source: "foundation",
    quote: "witness remains protected", question: "Can the source be protected?",
    proof: "The final consequence names the available redaction route",
    route: "Refusal and cooperation", beatIds: ["witness", "resolution"],
  };
  const initialLines = [JSON.stringify(example), JSON.stringify(obligation)].join("\n");
  const parsed = parseInitialBlueprint(initialLines, sources);
  assert.deepEqual(parsed.blueprint, example);
  assert.equal(parsed.obligations.items[0]?.id, "protect-witness");
  const legacy = parseInitialBlueprint(
    JSON.stringify({ blueprint: example, obligations: [obligation] }), sources);
  assert.deepEqual(parsed, legacy, "legacy strict JSON document remains exact");
  const operation = replace("beats/witness/change",
    example.beats[1]!.change, "Refusal still preserves the trustworthy paper trail");
  const [header] = [patch([operation])];
  const { operations: _, ...headerOnly } = header;
  const result = parseBlueprintPatch([
    JSON.stringify(headerOnly), JSON.stringify(operation),
  ].join("\n"), example, review);
  assert.deepEqual(result, applyBlueprintPatch(example, review, header));
  assert.throws(() => parseInitialBlueprint(
    [JSON.stringify(example), JSON.stringify(obligation) + "}"].join("\n"), sources),
    /JSONL line 2 is invalid/);
  assert.throws(() => parseBlueprintPatch([
    JSON.stringify(headerOnly), JSON.stringify(operation) + "}",
  ].join("\n"), example, review), /JSONL line 2 is invalid/);
  assert.throws(() => parseBlueprintPatch(JSON.stringify(headerOnly), example, review),
    /stale or invalid/);
  assert.throws(() => parseInitialBlueprint(
    [JSON.stringify(example), JSON.stringify({ ...obligation, quote: "not from source" })]
      .join("\n"), sources), /quotes text absent/);
});

test("reviewed causal additions have real bounded headroom beyond a valid large initial design", () => {
  const large = clone(example);
  large.beats[0]!.purpose = "Inspect the independently reachable archive evidence. ".repeat(410);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 20_000);
  const admitted = parseCausalBlueprint(JSON.stringify(large));
  const expanded = applyBlueprintPatch(admitted, review, patch([{
    kind: "append-observation", findingBeatId: "witness", beatId: "witness",
    value: { source: "corroborated route evidence", observable: "An independently dated trace",
      supports: "Specific mechanism supported. ".repeat(160),
      limits: "Identity and motive remain separate unanswered questions." },
  }], admitted));
  assert.ok(Buffer.byteLength(JSON.stringify(expanded.blueprint)) > 24_000);
  assert.equal(expanded.blueprint.beats[1]!.decisions.length, 4);
  const tooBig = clone(admitted);
  tooBig.resolution.conclusion = "Unsupported fabricated filler. ".repeat(1800);
  assert.throws(() => parseCausalBlueprint(JSON.stringify(tooBig)), /bounded size/);
});

test("a Choice effect can only be extended, never erased or overwritten", () => {
  const path = "beats/witness/decisions/0/alternatives/0/lastingEffect";
  const good = replace(path, "Privacy preserved 0",
    "Privacy preserved 0; the later hearing must redact the source");
  assert.equal(applyBlueprintPatch(example, review, patch([good])).blueprint
    .beats[1]!.decisions[0]!.alternatives[0]!.lastingEffect, good.value);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    replace(path, "Privacy preserved 0", "Privacy sacrificed"),
  ])), /cannot erase/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    replace("beats/witness/decisions/0/alternatives/0/action", "Protect 0", "Abandon"),
  ])), /cannot replace/);
});

test("cross-beat corrections retain the REVIEW finding ID, not the edited target ID", () => {
  const verdict: BlueprintReview = { status: "revise", findings: [
    { beatId: "catalog", reason: "The whole route is too short",
      correction: "Develop the narrative load across the dependent beats" },
    { beatId: "resolution", reason: "Final evidence is weak",
      correction: "Add corroborating physical evidence" },
  ] };
  assert.deepEqual(allowedBlueprintPatchTargets(example, verdict), [
    { findingBeatId: "catalog", targetBeatIds: ["catalog", "witness", "resolution"] },
    { findingBeatId: "resolution", targetBeatIds: ["resolution"] },
  ]);
  const old = example.beats[1]!.purpose;
  const invalid = replace("beats/witness/purpose", old,
    "Give the interview actual dialogue and evidence exchanges", "witness");
  const invalid2 = replace("beats/resolution/purpose", example.beats[2]!.purpose,
    "Develop the final inquiry evidence", "forged");
  assert.throws(() => applyBlueprintPatch(example, verdict,
    patch([invalid, invalid2], example, verdict)),
    error => error instanceof Error &&
      /missing reviewer finding/.test(error.message) &&
      /"index":0,"findingBeatId":"witness"/.test(error.message) &&
      /"index":1,"findingBeatId":"forged"/.test(error.message) &&
      /"findingBeatId":"catalog","targetBeatIds":\["catalog","witness","resolution"\]/.test(error.message) &&
      /reviewer concern, NOT the edited target beat/.test(error.message));
  const valid = { ...invalid, findingBeatId: "catalog" };
  const corrected = applyBlueprintPatch(example, verdict, patch([valid], example, verdict));
  assert.equal(corrected.blueprint.beats[1]!.purpose, valid.value,
    "a source-bound earlier finding can authorize its causal descendant");
});

test("stale, unrelated, duplicate, invented and partially valid patches fail closed", () => {
  const valid = replace("beats/witness/change",
    "Both routes can investigate without exposing identity",
    "All routes preserve their promised access");
  assert.throws(() => applyBlueprintPatch(example, review, {
    ...patch([valid]), baseDigest: "0".repeat(64),
  }), /stale/);
  assert.throws(() => applyBlueprintPatch(example, review, {
    ...patch([valid]), reviewDigest: "0".repeat(64),
  }), /stale/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    replace("beats/catalog/purpose", example.beats[0]!.purpose, "Unrelated rewrite"),
  ])), /outside reviewer findings/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    replace("beats/witness/change", "not actual old value", "new"),
  ])), /stale/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([valid, valid])),
    /conflicting/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    { ...valid, unexpectedGrant: "yes" },
  ])), /invalid/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    { kind: "append-observation", findingBeatId: "invented-finding",
      beatId: "witness", value: example.beats[0]!.observations[0] },
  ])), /missing reviewer finding/);
  assert.throws(() => parseBlueprintPatch('{"partial":', example, review), /not JSON/);
  assert.throws(() => applyBlueprintPatch(example, review, patch([
    { kind: "add-dependency", findingBeatId: "witness", beatId: "witness",
      dependsOn: "resolution" },
  ])), /beat relationships/);
});

test("bounded new beat and resolution evidence preserve prior IDs, decisions and alternatives", () => {
  const newBeat = {
    id: "independent-proof", purpose: "Verify disappearance without testimony",
    dependsOn: ["witness"], observations: [
      { source: "dated registrar", observable: "A signed archival handover",
        supports: "Verified custody after witness departure", limits: "Does not establish motive" },
    ], change: "Evidence remains accessible after refusal", decisions: [],
  };
  const result = applyBlueprintPatch(example, review, patch([
    { kind: "insert-beat", findingBeatId: "witness", afterBeatId: "witness", beat: newBeat },
    { kind: "support-resolution", findingBeatId: "witness", beatId: "independent-proof" },
  ]));
  assert.deepEqual(result.blueprint.beats.map(b => b.id),
    ["catalog", "witness", "independent-proof", "resolution"]);
  assert.deepEqual(result.blueprint.beats[1]!.decisions, example.beats[1]!.decisions);
  assert.deepEqual(result.blueprint.resolution.supportedBy,
    ["witness", "resolution", "independent-proof"]);
});
