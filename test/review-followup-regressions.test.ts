import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompositionReviewerMatch } from "../src/composition-work.js";
import { milestoneReviewStagnation, parseMilestoneBlueprintReview,
  type MilestoneBlueprint } from "../src/milestone-blueprint.js";

test("#209 publication gate accepts identical sealed Composition verdicts irrespective of object key order", () => {
  const copied = {
    verdict: "pass" as const,
    sourceEvidence: ["event.refusal#choice/refused"],
    concerns: [],
    sessionFile: "/pinned/reviewer.jsonl",
  };
  const verified = {
    verdict: "pass" as const,
    concerns: [],
    sourceEvidence: ["event.refusal#choice/refused"],
    sessionFile: "/pinned/reviewer.jsonl",
  };
  assertCompositionReviewerMatch(verified, copied);
  assert.throws(() => assertCompositionReviewerMatch(
    { ...verified, sourceEvidence: ["fabricated source"] }, copied,
  ), /copied reviewer receipt differs/);
  assert.throws(() => assertCompositionReviewerMatch(verified, undefined), /copied reviewer receipt differs/);
});

test("#207 sealed Milestone rounds detect repeated blockers despite cosmetic rewrites and restart", () => {
  const draft = (purpose: string): MilestoneBlueprint => ({
    schema: "noveltea-milestone-blueprint/v1",
    milestoneId: "milestone.test",
    events: [{
      id: "event-one", purpose, dependsOn: [], evidence: [],
      participants: [], knowledge: "knowledge", routes: [],
    }],
    downstream: [],
  });
  const revise = (reason: string) => ({
    schema: "noveltea-milestone-blueprint-review/v1" as const,
    status: "revise" as const,
    findings: [{ eventId: "event-one", anchorPath: "milestones/test.md",
      requirement: "Show an independently verifiable source", reason, correction: "Add evidence" }],
  });
  const rounds = [
    { draft: draft("old"), review: revise("same blocker"), draftDigest: "a", reviewDigest: "1" },
    { draft: draft("cosmetic A"), review: revise("same blocker restated"),
      draftDigest: "b", reviewDigest: "2" },
    { draft: draft("cosmetic B"), review: revise("same blocker again"),
      draftDigest: "c", reviewDigest: "3" },
  ];
  assert.equal(milestoneReviewStagnation(rounds.slice(0, 2)), 1);
  assert.equal(milestoneReviewStagnation(rounds), 2);
  assert.equal(milestoneReviewStagnation(JSON.parse(JSON.stringify(rounds))), 2);
  assert.equal(milestoneReviewStagnation([...rounds.slice(0, 2),
    { ...rounds[2]!, draftDigest: "a" }]), 2);
  // A *resolved* finding on the changed Event is material progress.
  const improved = { draft: draft("evidence added"), review: { ...revise("fixed"), findings: [] },
    draftDigest: "d", reviewDigest: "4" };
  // Old v1 verdicts have no per-finding proof and cannot manufacture progress.
  assert.equal(milestoneReviewStagnation([rounds[0]!, improved]), 1);
});

test("#207 independently resolves distinct findings on the same Event/source without false stalls", () => {
  const assignment = { milestonePath: "milestones/test.md",
    sourcePaths: ["milestones/test.md"] };
  const draft = (proof: string): MilestoneBlueprint => ({
    schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.test",
    events: [{ id: "arrival", purpose: proof, dependsOn: [], evidence: [],
      participants: [], knowledge: proof, routes: [] }],
    downstream: [],
  });
  const finding = (reason: string) => ({
    eventId: "arrival", anchorPath: "milestones/test.md",
    requirement: "Supply independently testable evidence", reason,
    correction: "Add inspectable proof",
  });
  const initial = { schema: "noveltea-milestone-blueprint-review/v1" as const,
    status: "revise" as const, findings: [
      finding("Missing paper register"), finding("Missing guard log"), finding("Missing dated seal"),
    ] };
  const original = { draft: draft("Witness testimony alone"), review: initial,
    draftDigest: "one", reviewDigest: "v1" };
  const current1 = draft("Witness testimony and a dated paper register");
  const verdict1 = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v2", status: "revise",
    findings: [finding("Missing guard log"), finding("Missing dated seal")],
    prior: [
      { round: 0, findingIndex: 0, status: "resolved", reason: "Register supplied",
        evidence: { eventId: "arrival", quote: "dated paper register" } },
      { round: 0, findingIndex: 1, status: "persisting", reason: "Guard log absent",
        evidence: { eventId: "arrival", quote: "Witness testimony" } },
      { round: 0, findingIndex: 2, status: "persisting", reason: "Dated seal absent",
        evidence: { eventId: "arrival", quote: "Witness testimony" } },
    ],
  }), current1, assignment, [original]);
  const first = { draft: current1, review: verdict1,
    draftDigest: "two", reviewDigest: "v2" };
  assert.equal(milestoneReviewStagnation([original, first]), 0);

  const current2 = draft("Witness testimony and a dated paper register plus independent guard log");
  const verdict2 = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v2", status: "revise",
    findings: [finding("Missing dated seal")],
    prior: [
      { round: 0, findingIndex: 0, status: "resolved", reason: "Register retained",
        evidence: { eventId: "arrival", quote: "dated paper register" } },
      { round: 0, findingIndex: 1, status: "resolved", reason: "New guard log now supplied",
        evidence: { eventId: "arrival", quote: "independent guard log" } },
      { round: 0, findingIndex: 2, status: "persisting", reason: "Seal still missing",
        evidence: { eventId: "arrival", quote: "Witness testimony" } },
      { round: 1, findingIndex: 0, status: "resolved", reason: "Guard log now supplied",
        evidence: { eventId: "arrival", quote: "independent guard log" } },
      { round: 1, findingIndex: 1, status: "persisting", reason: "Seal still missing",
        evidence: { eventId: "arrival", quote: "Witness testimony" } },
    ],
  }), current2, assignment, [original, first]);
  const second = { draft: current2, review: verdict2,
    draftDigest: "three", reviewDigest: "v3" };
  assert.equal(milestoneReviewStagnation([original, first, second]), 0);
  assert.equal(milestoneReviewStagnation(JSON.parse(JSON.stringify([original, first, second]))), 0);
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify({
    ...verdict2, prior: verdict2.prior!.slice(1),
  }), current2, assignment, [original, first]), /every prior material finding/);
});
