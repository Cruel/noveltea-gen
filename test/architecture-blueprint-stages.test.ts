import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBlueprintStages, EVIDENCE_BATCH_SIZE, parseBlueprintEvidence,
  parseBlueprintObligationStage, parseBlueprintOutline, parseCurrentBlueprintOutline } from "../src/architecture-blueprint-stages.js";
import { blueprintEvidencePrompt, blueprintOutlinePrompt,
  type CausalBlueprint } from "../src/architecture-blueprint.js";
import type { Plan } from "../src/architecture.js";

const blueprint: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v1", premise: "Investigate without exposing the witness",
  beats: [
    { id: "arrival", purpose: "Prove the departure occurred", dependsOn: [],
      change: "Look for an independent record", decisions: [],
      observations: [{ source: "dated register", observable: "Recorded departure at dusk",
        supports: "Departure happened", limits: "Not proof of destination" }] },
    { id: "refusal", purpose: "Cooperate or preserve privacy", dependsOn: ["arrival"],
      change: "The inquiry branches", decisions: [{
        question: "Ask or avoid a source?", alternatives: [
          { action: "Ask the source", lastingEffect: "Source knows inquiry occurred" },
          { action: "Protect the source", lastingEffect: "Source remains unexposed" },
        ],
      }], observations: [] },
    { id: "archive", purpose: "Authenticate the mechanism", dependsOn: ["refusal"],
      change: "Independent paper evidence survives both routes", decisions: [],
      observations: [{ source: "sealed records", observable: "Two matched dated entries",
        supports: "Timeline established without testimony", limits: "Does not prove motive" }] },
  ],
  resolution: { question: "Where did the clerk go?", conclusion: "Records locate a safe refuge",
    supportedBy: ["archive"], uncertainty: "The motive remains uncertain" },
};

const outlineValue = {
  schema: "noveltea-causal-outline/v1",
  premise: blueprint.premise,
  beats: blueprint.beats.map(({ observations: _observations, ...beat }) => beat),
  resolution: blueprint.resolution,
};
const outline = parseBlueprintOutline(JSON.stringify(outlineValue));
const evidence = blueprint.beats.map(({ id, observations }) => ({ id, observations }));

test("staged prompts demand concrete durable route effects, independent proof and bounded single-route pacing", () => {
  const contract = { scope: { kind: "full-story" }, envelope: { hardLimits: ["Keep source private"] } };
  const outlinePrompt = blueprintOutlinePrompt({ contract } as unknown as Plan, "Make a mystery");
  assert.match(outlinePrompt, /PERSISTENT CHOICE-STATE RULE/);
  assert.match(outlinePrompt, /PROVISIONAL DESIGN MUST ANSWER THE MYSTERY/);
  assert.match(outlinePrompt, /noveltea-causal-outline\/v2/);
  assert.match(outlinePrompt, /routeConsequences/);
  assert.doesNotMatch(outlinePrompt, /schema is noveltea-causal-outline\/v1/);
  assert.match(outlinePrompt, /specific.*knowledge.*evidence access.*relationship trust.*source exposure/s);
  assert.match(outlinePrompt, /REFUSE, be unavailable or withdraw/);
  assert.match(outlinePrompt, /single first-playthrough path/);
  assert.match(outlinePrompt, /Keep source private/);
  const evidencePrompt = blueprintEvidencePrompt(outline, 0);
  assert.match(evidencePrompt, /independently corroborated link between the ACT and the/);
  assert.match(evidencePrompt, /No evidence at a reconverged beat may silently restore/);
  assert.match(evidencePrompt, /testimony NEVER guarantees cooperation/);
  assert.match(evidencePrompt, /COMPLETE IMMUTABLE OUTLINE/);
  assert.doesNotMatch(evidencePrompt, /approved canon already exists/);
});

test("outline freezes the causal graph and protected Choice consequences without pretending it has evidence", () => {
  assert.deepEqual(outline, outlineValue);
  assert.equal(EVIDENCE_BATCH_SIZE, 2);
  assert.ok(!JSON.stringify(outline).includes("Internal structural validation only"));
  assert.deepEqual(assembleBlueprintStages(outline, evidence), blueprint);
  const noDecisionField = structuredClone(outlineValue);
  delete (noDecisionField.beats[0] as Partial<typeof noDecisionField.beats[0]>).decisions;
  assert.deepEqual(parseBlueprintOutline(JSON.stringify(noDecisionField)), outline);
  assert.throws(() => parseBlueprintOutline(JSON.stringify({
    ...outlineValue, beats: [{ ...outlineValue.beats[0], observations: [] }, ...outlineValue.beats.slice(1)],
  })), /outline beats/);
  assert.throws(() => parseBlueprintOutline(JSON.stringify({
    ...outlineValue, beats: [{ ...outlineValue.beats[0], dependsOn: ["archive"] }, ...outlineValue.beats.slice(1)],
  })), /relationships/);
  assert.throws(() => parseBlueprintOutline(JSON.stringify({
    ...outlineValue, beats: outlineValue.beats.map(b => ({ ...b,
      decisions: b.decisions.map(d => ({ ...d, alternatives: d.alternatives.slice(0, 1) })) })),
  })), /lasting alternatives/);
});

test("evidence batches are independent bounded JSON objects and must align with the outline", () => {
  const batch1 = evidence.slice(0, 2).map(x => JSON.stringify(x)).join("\n");
  const batch2 = JSON.stringify(evidence[2]);
  assert.deepEqual(parseBlueprintEvidence(batch1, outline, 0), evidence.slice(0, 2));
  assert.deepEqual(parseBlueprintEvidence(batch2, outline, 2), evidence.slice(2));
  assert.throws(() => parseBlueprintEvidence(JSON.stringify(evidence[0]), outline, 0),
    /exactly 2/);
  assert.throws(() => parseBlueprintEvidence([
    JSON.stringify(evidence[0]), JSON.stringify({ ...evidence[1], id: "wrong" }),
  ].join("\n"), outline, 0), /identity/);
  assert.throws(() => parseBlueprintEvidence([
    JSON.stringify(evidence[0]), JSON.stringify({ ...evidence[1], badField: "silent" }),
  ].join("\n"), outline, 0), /identity/);
  assert.throws(() => parseBlueprintEvidence(JSON.stringify({
    ...evidence[2], observations: [{ source: "record", observable: "a fact", supports: "time" }],
  }), outline, 2), /evidence must separate/);
  assert.throws(() => parseBlueprintEvidence(batch1 + "}", outline, 0), /JSONL line 2/);
  assert.throws(() => assembleBlueprintStages(outline, evidence.slice(0, 2)),
    /missing or out of outline order/);
  const withoutProof = evidence.map(e => ({ ...e, observations: [] }));
  assert.throws(() => assembleBlueprintStages(outline, withoutProof), /evidence chain/);
});

test("new Architecture planning requires a concrete solution and route-state contract, while legacy recovery stays valid", () => {
  const proposed = {
    ...outlineValue,
    schema: "noveltea-causal-outline/v2",
    causalAnswer: {
      question: "Where did the clerk go?",
      answer: "The clerk entered a safe refuge with help from the shelter operator.",
      mechanism: "The operator opened the service gate and registered the clerk under a protective alias.",
      responsibility: "The shelter operator hid the clerk to protect them from a threatening creditor.",
      motive: "The operator feared the creditor would use a public arrival record to find the clerk.",
      misdirection: {
        signal: "A departure entry appears in the town ledger",
        falseInference: "The clerk left the town by bus",
        actualExplanation: "The entry was copied from the shelter's protective alias register",
      },
      proof: {
        directTest: "Compare the physical service-gate log with the shelter's entry book.",
        corroboration: "Match its dated gate opening to an independently signed guard shift record.",
        refusalFallback:
          "The shift and gate logs stay inspectable when the threatened source refuses to speak.",
        beatIds: ["archive"],
      },
    },
    routeConsequences: [
      {
        beatId: "refusal",
        decisionIndex: 0,
        alternativeIndex: 0,
        laterBeatId: "archive",
        preserved: "The clerk's identity remains private",
        foregone: "Source testimony is not available",
        persistentEffect: "The archive's independent logs prove passage without exposing the clerk",
      },
      {
        beatId: "refusal",
        decisionIndex: 0,
        alternativeIndex: 1,
        laterBeatId: "archive",
        preserved: "The inquiry openly names the source",
        foregone: "The source's trust and protection are lost",
        persistentEffect: "The archive only confirms passage; the final report acknowledges source exposure",
      },
    ],
  };
  assert.throws(() => parseCurrentBlueprintOutline(JSON.stringify(outlineValue)), /complete v2 answer/);
  const parsed = parseCurrentBlueprintOutline(JSON.stringify(proposed));
  assert.deepEqual(parsed, proposed);
  assert.deepEqual(
    assembleBlueprintStages(parsed, evidence),
    blueprint,
    "a source-bound provisional answer remains private, never copied into canonical source",
  );

  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          causalAnswer: {
            ...proposed.causalAnswer,
            mechanism: "The actual mechanism remains to be determined",
          },
        }),
      ),
    /concrete testable answer/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          resolution: {
            ...proposed.resolution,
            conclusion: "The culprit and motive will later be established",
          },
        }),
      ),
    /concrete testable answer/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          routeConsequences: proposed.routeConsequences.slice(0, 1),
        }),
      ),
    /EVERY Choice alternative/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          routeConsequences: [
            proposed.routeConsequences[0],
            { ...proposed.routeConsequences[1], alternativeIndex: 0 },
          ],
        }),
      ),
    /duplicate Choice-route/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          routeConsequences: [
            proposed.routeConsequences[0],
            { ...proposed.routeConsequences[1], laterBeatId: "arrival" },
          ],
        }),
      ),
    /reachable later beat/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          routeConsequences: [
            proposed.routeConsequences[0],
            {
              ...proposed.routeConsequences[1],
              persistentEffect: proposed.routeConsequences[0].persistentEffect,
              preserved: proposed.routeConsequences[0].preserved,
              foregone: proposed.routeConsequences[0].foregone,
            },
          ],
        }),
      ),
    /indistinguishable persistent outcomes/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          causalAnswer: {
            ...proposed.causalAnswer,
            proof: { ...proposed.causalAnswer.proof, beatIds: ["refusal"] },
          },
        }),
      ),
    /concrete testable answer/,
  );
  assert.throws(
    () =>
      parseCurrentBlueprintOutline(
        JSON.stringify({
          ...proposed,
          routeConsequences: [...proposed.routeConsequences, proposed.routeConsequences[1]],
        }),
      ),
    /duplicate Choice-route/,
  );
  assert.deepEqual(
    parseBlueprintOutline(JSON.stringify(outlineValue)),
    outline,
    "an earlier verified source-bound v1 checkpoint remains restorable",
  );
});

test("source quote collection is separately retryable without rewriting reviewed outline or evidence", () => {
  const sources = {
    foundation: "Preserve the witness and establish where the clerk went.",
    task: "Make me a story with consequences", contract: { constraint: "Never reveal the witness" },
  };
  const obligation = {
    id: "protect-source", category: "consequence", source: "foundation",
    quote: "Preserve the witness", question: "Is the witness protected?",
    proof: "The player's refusal remains binding", route: "Both branches",
    beatIds: ["refusal", "archive"],
  };
  const parsed = parseBlueprintObligationStage(JSON.stringify(obligation), blueprint, sources);
  assert.equal(parsed.items[0]?.id, obligation.id);
  assert.throws(() => parseBlueprintObligationStage(JSON.stringify({
    ...obligation, quote: "Source is always protected",
  }), blueprint, sources), /quotes text absent/);
  assert.throws(() => parseBlueprintObligationStage(
    JSON.stringify({ ...obligation, beatIds: ["made-up"] }), blueprint, sources),
  /unknown beat/);
  assert.deepEqual(outline, outlineValue, "collecting obligations cannot mutate the blueprint");
});
