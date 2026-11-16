import assert from "node:assert/strict";
import { test } from "node:test";
import { routeEventPrerequisite } from "../src/event-prerequisite-routing.js";

const head = "a".repeat(40), digest = "f".repeat(64);
const input = {
  milestone: "milestone.resolution", activeStage: "event", expectedHead: head,
  verifiedHead: head, reportDigest: digest, alreadyRerouted: false,
  conflicts: ["Needs distinct player Choice and ending outcomes outside Event authority."],
  obligations: ["Choice specialist must bind later outcomes and conditional consumers."],
};

test("S14 #173: the preserved access-interval no-write symptom is owned by a bounded Event setup", () => {
  const route = routeEventPrerequisite({
    ...input, milestone: "milestone.disappearance-established",
    conflicts: ["The selected Milestone lacks material evidence of which spaces and people " +
      "were accessible during the relevant interval. The current Event does not establish " +
      "that access; marking it fulfilled would falsely claim a reachable completed Milestone."],
    obligations: [],
  });
  assert.equal(route.kind, "event-setup");
  if (route.kind !== "event-setup") return;
  assert.equal(route.reportDigest, digest);
  assert.match(route.task, /IN-SCOPE EVENT EVIDENCE/);
  assert.match(route.task, /EXISTING participants/);
  assert.match(route.task, /in-scene evidence/);
  assert.match(route.task, /native-verified reachable Event IDs/);
  assert.match(route.task, /separately approved/);
  assert.doesNotMatch(route.task, /create new Character|write new Fact/i);
});

test("S14 #173: saved competing-accounts no-write report stays Event-local, not an invented World Fact", () => {
  const report = "The assigned Milestone requires conflicting accounts and an independent observation " +
    "relevant to their conflict. Canonical sources establish neither: the existing Event shows " +
    "only the broken seal, open latch and normal-position brake handle. No supported account " +
    "conflicts on a consequential point, and the existing observation cannot test one without " +
    "inventing claims or off-screen history.";
  const route = routeEventPrerequisite({
    ...input, milestone: "milestone.accounts-tested",
    conflicts: [report], obligations: [],
  });
  assert.equal(route.kind, "event-setup", "Current on-page testimony is an Event-owned creative task");
  if (route.kind !== "event-setup") return;
  assert.match(route.task, /materially DIFFERENT, attributable statements/);
  assert.match(route.task, /distinct independent observation/);
  assert.match(route.task, /new on-page testimony/);
  assert.match(route.task, /subjective claims do not become objective World Facts/);
  assert.match(route.task, /native-verified reachable Event IDs/);
  for (const unsafe of [
    report + " A new Fact is required to establish the observation.",
    report + " Need a new Character to supply that testimony.",
    report + " Another Milestone must be revised first.",
    report + " A protected decision must be retconned.",
  ]) assert.equal(routeEventPrerequisite({
    ...input, milestone: "milestone.accounts-tested", conflicts: [unsafe], obligations: [],
  }).kind, "replan-required", unsafe);
});

test("S14 #173: unsafe, mixed-owner, stale and vague access reports cannot grant a retry", () => {
  const scoped = {
    ...input, milestone: "milestone.disappearance-established",
    conflicts: ["The selected Milestone lacks evidence of who had access during the relevant interval."],
    obligations: [],
  };
  for (const conflict of [
    "Need a new Character to attest prior access; the selected Milestone lacks evidence.",
    "The selected Milestone lacks access evidence, so create a Fact in upstream World canon.",
    "The selected Milestone is missing evidence, but another Milestone is blocked.",
    "The selected Milestone lacks evidence requiring protected approval.",
    "The current Event is missing support; an earlier Event needs revision.",
    "Missing evidence somewhere, perhaps later.",
  ]) {
    assert.equal(routeEventPrerequisite({ ...scoped, conflicts: [conflict] }).kind,
      "replan-required", conflict);
  }
  assert.equal(routeEventPrerequisite({ ...scoped, obligations: [
    "The Event requires a separately authorized new Character."
  ] }).kind, "replan-required");
  for (const change of [
    { alreadyRerouted: true }, { verifiedHead: "b".repeat(40) },
    { reportDigest: "missing" }, { activeStage: "composition" },
    { milestone: "milestone.other", conflicts: [
      "milestone.disappearance-established lacks material evidence of interval access"
    ] },
  ]) assert.equal(routeEventPrerequisite({ ...scoped, ...change }).kind, "replan-required");
});

test("clean Choice-owner reports become one same-Event setup request, not a Choice grant", () => {
  const route = routeEventPrerequisite(input);
  assert.equal(route.kind, "event-setup");
  if (route.kind !== "event-setup") return;
  assert.equal(route.reportDigest, digest);
  assert.match(route.task, /reachable scene/);
  assert.match(route.task, /Do not bind Choice outcomes/);
  assert.match(route.task, /partial fulfillment/);
});

test("same source report cannot cause repeated or stale reassignment", () => {
  for (const change of [
    { alreadyRerouted: true }, { verifiedHead: "b".repeat(40) },
    { reportDigest: "invalid" }, { activeStage: "interactive" },
    { milestone: "milestone.../../escape" },
  ]) assert.equal(routeEventPrerequisite({ ...input, ...change }).kind, "replan-required");
});

test("upstream, protected and out-of-scope work never receives an Event-only retry", () => {
  for (const claim of ["requires protected Choice approval", "a new Fact and Choice",
    "must change an upstream Event before Choice", "out-of-scope author permission for ending",
    "add a second Character and Choice"]) {
    const route = routeEventPrerequisite({ ...input, conflicts: [claim], obligations: [] });
    assert.equal(route.kind, "replan-required", claim);
  }
  assert.equal(routeEventPrerequisite({ ...input, conflicts: ["A previous Event is missing"],
    obligations: [] }).kind, "replan-required");
  assert.equal(routeEventPrerequisite({ ...input, conflicts: [], obligations: [] }).kind, "replan-required");
});
