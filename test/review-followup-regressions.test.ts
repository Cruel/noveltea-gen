import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCompositionReviewerMatch } from "../src/composition-work.js";
import { milestoneReviewStagnation, type MilestoneBlueprint } from "../src/milestone-blueprint.js";

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
  assert.equal(milestoneReviewStagnation([rounds[0]!, improved]), 0);
});
