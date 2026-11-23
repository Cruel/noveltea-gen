import assert from "node:assert/strict";
import { test } from "node:test";
import { eventOnlySourceCandidate } from "../src/interactive-event-only.js";

function source(change: string, milestone = "milestone.wrong-credit",
  event = "event.wrong-credit") {
  return {
    records: [
      { path: "milestones/" + milestone.slice(10) + ".md", metadata: {
        type: "milestone", id: milestone, status: "approved",
        completeness: "complete", change,
        fulfillment: { any_of: [[event]] },
      } },
      { path: "events/" + event.slice(6) + ".md", metadata: {
        type: "event", id: event, status: "approved",
      } },
    ],
    coverage: {
      search: { truncated: false },
      eventProgress: [{ id: event, status: "reachable" }],
      milestoneRoutes: [{ id: milestone,
        routes: [{ status: "reachable", witness: [event] }] }],
      branchProgress: [],
    },
  };
}
const eligible = (value: ReturnType<typeof source>,
  milestone = "milestone.wrong-credit", event = "event.wrong-credit") =>
  eventOnlySourceCandidate(value, milestone, [event]);

test("#243: native Event-only review eligibility does not depend on English Milestone wording", () => {
  for (const change of [
    "Ada identifies the forged attribution and understands who originally supplied the invoice.",
    "The audience sees the invoice being verified before the later consequential Choice.",
    "La preuve établit que le registre a été falsifié.",
    "A source text without any of the old observation keywords",
  ]) assert.equal(eligible(source(change)), true, change);
  assert.equal(eligible(source("Ada must choose between consequences.")), true,
    "This is eligibility for independent review, NEVER a positive omission verdict");
  assert.equal(eligible(source("The archive establishes the witness was present.",
    "milestone.archive-entry", "event.witness-proof"),
    "milestone.archive-entry", "event.witness-proof"), true,
    "a second Milestone/Event ID cannot depend on an incident-specific exception");
});

test("#243: canonical reachability and genuine Choice/Puzzle links still block omission review", () => {
  const noRoute = source("The disputed credit is settled");
  noRoute.coverage.milestoneRoutes[0]!.routes[0]!.status = "impossible";
  assert.equal(eligible(noRoute), false);
  const truncated = source("The disputed credit is settled");
  truncated.coverage.search.truncated = true;
  assert.equal(eligible(truncated), false);
  const notReachable = source("The disputed credit is settled");
  notReachable.coverage.eventProgress[0]!.status = "unverified";
  assert.equal(eligible(notReachable), false);
  const partial = source("The disputed credit is settled");
  partial.records[0]!.metadata.completeness = "partial";
  assert.equal(eligible(partial), false);
  const choice = source("The disputed credit is settled");
  choice.records.push({ path: "choice-points/disclosure.md", metadata: {
    type: "choice-point", id: "choice-point.disclosure", status: "approved",
    events: ["event.wrong-credit"],
  } } as typeof choice.records[number]);
  assert.equal(eligible(choice), false);
  const puzzle = source("The disputed credit is settled");
  puzzle.records.push({ path: "puzzles/disclosure.md", metadata: {
    type: "puzzle", id: "puzzle.disclosure", status: "approved",
    solutions: ["event.wrong-credit"],
  } } as typeof puzzle.records[number]);
  assert.equal(eligible(puzzle), false);
});
