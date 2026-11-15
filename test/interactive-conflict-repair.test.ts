import assert from "node:assert/strict";
import { test } from "node:test";
import { interactiveConflictRepairFeedback } from "../src/interactive-work.js";
import { CHOICE_PAYOFF_AUTHOR, CHOICE_PAYOFF_REPAIR } from "../src/choice-payoff-guidance.js";

const changed = [
  "choice-points/response-to-evidence.md",
  "events/evidence-directed-response.md",
  "events/response-enacted.md",
];
// Exact symptom and source locations from the preserved GPT-6 Luna #173 run.
const diagnostics = [
  ...[29, 41, 55, 61].map(line => ({
    path: "events/response-enacted.md", line, column: 9,
    code: "impossible-branch",
    message: "event.response-enacted: Revise contradictory prerequisites, chronology or effects; no declared history can fulfill this requirement.",
  })),
  {
    path: "events/response-enacted.md", line: 22, column: 3,
    code: "impossible-prerequisite",
    message: "event.response-enacted: Revise contradictory prerequisites, chronology or effects; no declared history can fulfill this requirement.",
  },
];
const conflict = [
  "The choice has no executable selection point: event.response-enacted tests for outcomes " +
  "that no reachable Event branch sets. The validator reports its prerequisite and all four branches impossible.",
];

test("saved Luna self-conditioned Choice draft gets native diagnostics for same-session correction", () => {
  const feedback = interactiveConflictRepairFeedback(conflict, changed, diagnostics);
  assert.ok(feedback);
  assert.equal(feedback.length, 6);
  assert.match(feedback[0]!, /events\/response-enacted\.md:29:9 impossible-branch/);
  assert.match(feedback[4]!, /events\/response-enacted\.md:22:3 impossible-prerequisite/);
  assert.match(feedback[5]!, /SAME Pi session/);
  assert.match(feedback[5]!, /grants no new scope/);
  assert.match(CHOICE_PAYOFF_AUTHOR, /NEVER test an outcome as a prerequisite/);
  assert.match(CHOICE_PAYOFF_REPAIR, /first assignment of an outcome/);
  assert.match(CHOICE_PAYOFF_AUTHOR, /conditions: \[\]/);
  assert.match(CHOICE_PAYOFF_AUTHOR, /Only LATER steps or Events/);
});

test("cross-owner or protected source diagnostics cannot be converted to repair permissions", () => {
  assert.equal(interactiveConflictRepairFeedback(conflict, changed,
    [...diagnostics, { ...diagnostics[0]!, path: "milestones/evidence-directed-response.md" }]), undefined);
  assert.equal(interactiveConflictRepairFeedback(conflict, changed,
    [{ ...diagnostics[0]!, path: "events/other-owner.md" }]), undefined);
  assert.equal(interactiveConflictRepairFeedback(conflict, changed, []), undefined);
  assert.equal(interactiveConflictRepairFeedback([], changed, diagnostics), undefined);
  assert.equal(interactiveConflictRepairFeedback(conflict, changed,
    [{ ...diagnostics[0]!, code: "" }]), undefined);
  assert.equal(interactiveConflictRepairFeedback(conflict, changed,
    [{ ...diagnostics[0]!, message: "" }]), undefined);
});
