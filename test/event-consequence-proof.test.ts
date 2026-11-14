import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEventConsequenceProof, type EventProofSource } from "../src/event-consequence-proof.js";

const milestone = {
  path: "milestones/evidence.md",
  content: "---\ntype: milestone\nid: milestone.evidence\n---\n\nThe player weighs disputed testimony before deciding whether to expose a friend.\n",
  metadata: { type: "milestone", id: "milestone.evidence" },
};
const character = { path: "characters/ada.md", content: "Character baseline.",
  metadata: { type: "character", id: "character.ada",
    initial_knowledge: [{ fact: "fact.witnessed", value: "unknown" }] } };
const relationship = { path: "relationships/ada-neri.md", content: "Cautious partners.",
  metadata: { type: "relationship", id: "relationship.ada-neri",
    initial: "wary", characters: ["character.ada", "character.neri"] } };

const branch = (id: string, effects: object[] = [], conditions: object[] = []) =>
  ({ id, effects, conditions });
function eventSource(
  prose: string, branches: ReturnType<typeof branch>[] = [],
): EventProofSource {
  const frontmatter = [
    "---", "type: event", "id: event.testimony", "steps:",
    "  - id: account", "    branches:",
    ...branches.flatMap(b => [
      "      - id: " + b.id, "        conditions: []", "        effects:",
      ...b.effects.flatMap(e => [
        "          - kind: " + (e as { kind: string }).kind,
        ...Object.entries(e).filter(([k]) => k !== "kind")
          .map(([k, v]) => "            " + k + ": " + String(v)),
      ]),
    ]),
    "---", "", prose,
  ].join("\n");
  return { path: "events/testimony.md", content: frontmatter,
    metadata: { id: "event.testimony", type: "event",
      participants: ["character.ada", "character.neri"],
      prerequisites: { any_of: [{ completed: ["event.discovery"], not_completed: [] }] },
      after: ["event.discovery"], consequences: ["Ada weighs the account"],
      steps: [{ id: "account", branches }] } };
}
function proof(source: EventProofSource, obligations: string[] = []) {
  return buildEventConsequenceProof([milestone, character, relationship, source],
    "milestone.evidence", [source.path], obligations);
}

test("saved #158 patterns expose exact typed slots beside the prose without fabricating obligations", () => {
  const negative = [
    ["Missing inference effect: Ada learns the disputed Fact.", []],
    ["Premature knowledge: Ada knows the Fact before listening to Neri.", [
      { kind: "knowledge", character: "character.ada", fact: "fact.witnessed", value: "knows" }]],
    ["Disproportionate shift: a single hesitant answer makes them devoted.", [
      { kind: "relationship", relationship: "relationship.ada-neri", value: "trusting" }]],
  ] as const;
  for (const [prose, effects] of negative) {
    const map = proof(eventSource(prose, [branch("answer", [...effects])]));
    assert.equal(map.milestone.id, "milestone.evidence");
    assert.match(map.milestone.claim, /weighs disputed testimony/);
    assert.match(map.events[0]!.observation, new RegExp(prose.slice(0, 15)));
    assert.deepEqual(map.events[0]!.participants, ["character.ada", "character.neri"]);
    assert.equal(map.events[0]!.outcomes[0]!.effects.length, effects.length);
    assert.deepEqual(map.diagnostics, [], "A reviewer, not a prose heuristic, judges causal sufficiency");
    assert.equal(map.baselines.find(s => s.id === "relationship.ada-neri")!.state.initial, "wary");
    assert.deepEqual(map.routes[0]!.prerequisites,
      { any_of: [{ completed: ["event.discovery"], not_completed: [] }] });
    for (const effect of map.events[0]!.outcomes[0]!.effects) {
      assert.ok(effect.line > 0);
      assert.match(map.events[0]!.path, /^events\//);
      assert.match(effect.slot, /^(knowledge|relationship):/);
    }
  }
});

test("provable conflicting typed slot points to actual event/step/branch and line", () => {
  const map = proof(eventSource("Ada hears the account.", [branch("answer", [
    { kind: "knowledge", character: "character.ada", fact: "fact.witnessed", value: "knows" },
    { kind: "knowledge", character: "character.ada", fact: "fact.witnessed", value: "does-not-know" },
  ])]));
  assert.equal(map.diagnostics.length, 1);
  const mismatch = map.diagnostics[0]!;
  assert.deepEqual([mismatch.path, mismatch.event, mismatch.step, mismatch.branch],
    ["events/testimony.md", "event.testimony", "account", "answer"]);
  assert.match(mismatch.slot, /knowledge.*character.ada.*fact.witnessed/);
  assert.equal(mismatch.correction, "remove-contradictory-effect");
  assert.match(map.events[0]!.outcomes[0]!.effects[1]!.value, /does-not-know/);
  assert.ok(mismatch.line > map.events[0]!.outcomes[0]!.effects[0]!.line);
});

test("two indistinguishable pending outcomes remain a Choice-owner obligation, not an Event fake effect", () => {
  const source = eventSource("The player may protect Neri or confront her; neither has occurred.",
    [branch("protect"), branch("confront")]);
  const map = proof(source, ["Formal Choice binding will supply distinct effects and consumers."]);
  assert.deepEqual(map.diagnostics, []);
  assert.deepEqual(map.unresolvedChoiceOutcomes, [{
    event: "event.testimony", step: "account", branches: ["protect", "confront"],
    reason: "identical-typed-effects-await-choice-binding",
  }]);
  const formalOnly = proof(source, ["The formal choice remains deferred to a later owner."]);
  assert.deepEqual(formalOnly.unresolvedChoiceOutcomes, map.unresolvedChoiceOutcomes,
    "A formal-choice obligation must not silently become an Event-stage typed-effect demand");
  const unrelated = proof(source, ["Later composition will supply dialogue polish."]);
  assert.deepEqual(unrelated.unresolvedChoiceOutcomes, []);
});

test("provisional belief, non-state actions and distinct conditional outcomes carry no invented constraints", () => {
  const provisional = proof(eventSource(
    "Neri says she may have seen the witness; Ada treats it as a provisional account.",
    [branch("listen", [{ kind: "knowledge", character: "character.ada",
      fact: "fact.reported", value: "believes" }])]));
  assert.deepEqual(provisional.diagnostics, []);
  assert.equal(provisional.events[0]!.outcomes[0]!.effects[0]!.value, '"believes"');
  const description = proof(eventSource("Neri silently retrieves the satchel."));
  assert.deepEqual(description.events[0]!.outcomes, []);
  assert.deepEqual(description.diagnostics, []);
  const choice = proof(eventSource("These branches have distinct reachable outcomes.", [
    branch("protect", [{ kind: "relationship", relationship: "relationship.ada-neri", value: "trusting" }],
      [{ kind: "knowledge", character: "character.ada", fact: "fact.reported", value: "knows" }]),
    branch("confront", [{ kind: "relationship", relationship: "relationship.ada-neri", value: "wary" }]),
  ]), ["Choice Point binding and later conditional consumers remain."]);
  assert.deepEqual(choice.unresolvedChoiceOutcomes, []);
  assert.deepEqual(choice.diagnostics, []);
  assert.equal(choice.events[0]!.outcomes[0]!.conditions.length, 1);
  assert.notEqual(choice.events[0]!.outcomes[0]!.effects[0]!.value,
    choice.events[0]!.outcomes[1]!.effects[0]!.value);
});

test("source map rejects missing Milestone/native Event identities and oversized manifests", () => {
  const source = eventSource("An observation.", [branch("listen")]);
  assert.throws(() => buildEventConsequenceProof([source], "milestone.evidence", [source.path], []),
    /Milestone/);
  assert.throws(() => buildEventConsequenceProof([milestone, source], "milestone.evidence",
    ["events/missing.md"], []), /authored Event/);
  assert.throws(() => proof(source, Array(17).fill("other-owner task")), /bounded/);
});
