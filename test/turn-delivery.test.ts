import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompletionContract } from "../src/architecture.js";
import { deliveryCriteria, assertDeliveryNotReduced,
  assertTurnDeliveryHistory } from "../src/turn-delivery.js";

const contract = (kind: "partial" | "full-story", depth: "architecture" | "interactive" | "composition",
  targets: string[] = ["arc.archive", "milestone.revelation"], branches: string[] = []): CompletionContract => ({
  scope: { kind, depth, targets: kind === "full-story" ? [] : targets, branches },
  constraints: ["The player learns who hid the ledger"],
  envelope: { presentation: "Playable mystery", hardLimits: [], preferences: [] },
});

test("architecture outline stops at connected Arc/Milestone outcomes without prose obligations", () => {
  const criteria = deliveryCriteria("revision", contract("partial", "architecture"));
  assert.deepEqual(criteria.version, 1);
  assert.equal(criteria.depth, "architecture");
  assert.deepEqual(criteria.targets, ["arc.archive", "milestone.revelation"]);
  assert.ok(criteria.objectives.some(o => o.id === "delivery:architecture"));
  assert.ok(criteria.objectives.every(o => !["delivery:interactive", "delivery:composition", "delivery:complete-story"].includes(o.id)));
});

test("an outline may sketch branching consequences without demanding an executable Event", () => {
  const criteria = deliveryCriteria("revision", contract("partial", "architecture",
    ["arc.archive", "milestone.revelation"], ["confess"]));
  assert.ok(criteria.objectives.some(o => o.id === "delivery:branch:0" &&
    o.text.includes("outline") && !o.text.includes("reachable")));
  assert.ok(!criteria.objectives.some(o => o.id === "delivery:interactive"));
});

test("interactive structure demands authored consequences, prerequisites and reachable branching but not final scenes", () => {
  const criteria = deliveryCriteria("revision", contract("partial", "interactive",
    ["arc.archive", "milestone.revelation"], ["confess", "conceal"]));
  assert.ok(criteria.objectives.some(o => o.id === "delivery:interactive"));
  assert.deepEqual(criteria.objectives.filter(o => o.id.startsWith("delivery:branch:")).map(o => o.text.length > 0), [true, true]);
  assert.ok(!criteria.objectives.some(o => o.id === "delivery:composition"));
});

test("complete Story must independently prove player-facing prose, branch endings and meaningful payoffs", () => {
  const criteria = deliveryCriteria("full-story", contract("full-story", "composition"));
  for (const id of ["delivery:architecture", "delivery:interactive", "delivery:composition",
    "delivery:complete-story", "delivery:payoff"]) {
    assert.ok(criteria.objectives.some(o => o.id === id), id);
  }
  assert.equal(criteria.breadth, "whole-story");
});

test("a focused Character edit is not silently escalated to a whole Arc or required to create scenes", () => {
  const criteria = deliveryCriteria("revision", contract("partial", "composition", ["character.nia"]));
  assert.deepEqual(criteria.objectives.map(o => o.id), ["delivery:focus"]);
});

test("focused interactive records and authored scenes still carry their specific delivery obligations", () => {
  const choice = deliveryCriteria("revision",
    contract("partial", "interactive", ["choice-point.confession"], ["confess"]));
  assert.deepEqual(choice.objectives.map(o => o.id),
    ["delivery:focus", "delivery:interactive", "delivery:branch:0"]);
  const prose = deliveryCriteria("revision",
    contract("partial", "composition", ["authored-content.confession"]));
  assert.deepEqual(prose.objectives.map(o => o.id),
    ["delivery:focus", "delivery:composition"]);
});

test("review refuses an unsigned change of the original contract or a substituted plan history", () => {
  const original = contract("partial", "architecture");
  const expanded = contract("partial", "interactive");
  assert.doesNotThrow(() => assertTurnDeliveryHistory(original, original, []));
  assert.throws(() => assertTurnDeliveryHistory(original, expanded, []), /original|history|approval/i);
  assert.throws(() => assertTurnDeliveryHistory(original, expanded, [
    { plan: { contract: expanded } },
  ]), /original|history|approval/i);
  assert.doesNotThrow(() => assertTurnDeliveryHistory(original, expanded, [
    { plan: { contract: original } },
  ]));
});

test("versioned amendments cannot reduce original breadth, targets, branches or delivery depth", () => {
  const original = contract("partial", "interactive", ["arc.archive", "milestone.revelation"], ["confess"]);
  assert.doesNotThrow(() => assertDeliveryNotReduced(original,
    contract("partial", "composition", ["arc.archive", "milestone.revelation", "milestone.ending"], ["confess", "hide"])));
  assert.throws(() => assertDeliveryNotReduced(original,
    contract("partial", "architecture", ["arc.archive", "milestone.revelation"], ["confess"])), /delivery|depth/i);
  assert.throws(() => assertDeliveryNotReduced(original,
    contract("partial", "interactive", ["arc.archive"], ["confess"])), /target/i);
  assert.throws(() => assertDeliveryNotReduced(original,
    contract("partial", "interactive", ["arc.archive", "milestone.revelation"], [])), /branch/i);
  assert.throws(() => assertDeliveryNotReduced(contract("full-story", "composition"),
    contract("partial", "composition")), /breadth/i);
  assert.doesNotThrow(() => assertDeliveryNotReduced(original, contract("full-story", "composition")));
});
