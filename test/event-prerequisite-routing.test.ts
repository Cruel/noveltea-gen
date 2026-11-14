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
