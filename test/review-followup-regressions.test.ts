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


test("#207 PASS requires a correction to the rejected Event field, not an unrelated Event edit", () => {
  const assignment = { milestonePath: "milestones/shelter.md",
    sourcePaths: ["milestones/shelter.md"] };
  const event = (id: string, knowledge: string) => ({
    id, purpose: "Use inspectable first-hand evidence", dependsOn: [],
    evidence: [{
      anchorPath: "milestones/shelter.md", source: "The current Milestone scene",
      observation: "A dated record can be inspected by the player",
      access: "The protagonist can inspect the record",
      establishes: "Only the existence of a dated record",
      limits: "The witness location is not yet verified",
    }], participants: [], knowledge, routes: [],
  });
  const plan = (a: string, b: string): MilestoneBlueprint => ({
    schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.shelter",
    events: [event("arrival", a), event("followup", b)],
    downstream: [{ owner: "composition", obligation: "Present earned source-bound knowledge" }],
  });
  const rejectedClaim = "Neri knows the witness's secret hiding place";
  const initial = plan(rejectedClaim + " without evidence", "The guard records an arrival");
  const finding = {
    eventId: "arrival", anchorPath: "milestones/shelter.md",
    requirement: "Knowledge must be earned from inspectable evidence",
    reason: "Neri cannot know the secret hiding place without a source",
    correction: "Replace the unsupported knowledge claim",
    evidence: { field: "knowledge", quote: rejectedClaim },
  };
  const negative = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v3", status: "revise",
    findings: [finding], prior: [],
  }), initial, assignment);
  const history = [{ draft: initial, review: negative,
    draftDigest: "initial", reviewDigest: "negative" }];
  const verdict = (proof: unknown) => JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v3", status: "pass",
    findings: [], prior: [{ round: 0, findingIndex: 0, status: "resolved",
      reason: "Knowledge gap resolved", evidence: proof }],
  });
  const unrelated = plan(rejectedClaim + " without evidence", "The guard files a later witness report");
  assert.throws(() => parseMilestoneBlueprintReview(verdict({
    kind: "revised", eventId: "arrival", field: "knowledge",
    before: rejectedClaim, after: "without evidence",
  }), unrelated, assignment, history), /rejected field|verified correction/);
  assert.throws(() => parseMilestoneBlueprintReview(verdict({
    kind: "current", eventId: "arrival", field: "knowledge", quote: rejectedClaim,
  }), unrelated, assignment, history), /rejected field|verified correction/);
  const unrelatedField = plan(rejectedClaim + " without evidence",
    "The guard files a later witness report");
  unrelatedField.events[0]!.purpose = "An unrelated change to Event A's purpose";
  assert.throws(() => parseMilestoneBlueprintReview(verdict({
    kind: "revised", eventId: "arrival", field: "purpose",
    before: "Use inspectable first-hand evidence", after: "An unrelated change",
  }), unrelatedField, assignment, history), /rejected field|verified correction/);

  const fixed = plan("Neri learns only that the signed gate register is dated",
    "The guard records an arrival");
  const fixedVerdict = parseMilestoneBlueprintReview(verdict({
    kind: "revised", eventId: "arrival", field: "knowledge",
    before: rejectedClaim, after: "the signed gate register is dated",
  }), fixed, assignment, history);
  assert.equal(fixedVerdict.status, "pass");
  assert.equal(milestoneReviewStagnation([...history, {
    draft: fixed, review: fixedVerdict, draftDigest: "fixed", reviewDigest: "accepted",
  }]), 0);

  // Removal must be verified against the original rejected source, not an
  // absent current ID. A valid surviving one-Event plan may be approved.
  const removed: MilestoneBlueprint = {
    ...initial, events: [event("followup", "The guard records an arrival")],
  };
  const removedVerdict = parseMilestoneBlueprintReview(verdict({
    kind: "removed", eventId: "arrival", field: "knowledge", before: rejectedClaim,
  }), removed, assignment, history);
  assert.equal(removedVerdict.status, "pass");
  assert.equal(milestoneReviewStagnation([...history, {
    draft: removed, review: removedVerdict, draftDigest: "removed", reviewDigest: "accepted",
  }]), 0);
  assert.throws(() => parseMilestoneBlueprintReview(verdict({
    kind: "removed", eventId: "arrival", field: "knowledge", before: "fabricated removal",
  }), removed, assignment, history), /rejected field|verified correction/);
});

test("#207 v3 consecutive corrections on one Event/path remain productive", () => {
  const assignment = { milestonePath: "milestones/test.md",
    sourcePaths: ["milestones/test.md"] };
  const plan = (knowledge: string): MilestoneBlueprint => ({
    schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.test",
    events: [{ id: "arrival", purpose: "Verify the arrival",
      dependsOn: [], participants: [], evidence: [], knowledge, routes: [] }],
    downstream: [],
  });
  const one = "unverified witness disclosure";
  const two = "uncorroborated guard ledger";
  const old = plan(one + " and " + two);
  const issue = (quote: string) => ({
    eventId: "arrival", anchorPath: "milestones/test.md",
    requirement: "First-hand knowledge requires independent proof",
    reason: "The evidence does not substantiate this knowledge claim",
    correction: "Replace the rejected claim with independently observable knowledge",
    evidence: { field: "knowledge", quote },
  });
  const firstReview = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v3",
    status: "revise", findings: [issue(one), issue(two)], prior: [],
  }), old, assignment);
  const rounds = [{ draft: old, review: firstReview, draftDigest: "one", reviewDigest: "negative" }];
  const stage1 = plan("verified signed entry and " + two);
  const firstCorrection = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v3",
    status: "revise", findings: [issue(two)],
    prior: [
      { round: 0, findingIndex: 0, status: "resolved", reason: "Signed entry verified",
        evidence: { kind: "revised", eventId: "arrival", field: "knowledge",
          before: one, after: "verified signed entry" } },
      { round: 0, findingIndex: 1, status: "persisting", reason: "Guard ledger uncorroborated",
        evidence: { kind: "current", eventId: "arrival", field: "knowledge", quote: two } },
    ],
  }), stage1, assignment, rounds);
  const afterFirst = [...rounds, {
    draft: stage1, review: firstCorrection, draftDigest: "two", reviewDigest: "partial",
  }];
  assert.equal(milestoneReviewStagnation(afterFirst), 0);
  const stage2 = plan("verified signed entry and independently dated guard roster");
  const lastReview = parseMilestoneBlueprintReview(JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v3",
    status: "pass", findings: [],
    prior: [
      { round: 0, findingIndex: 0, status: "resolved", reason: "Signed entry retained",
        evidence: { kind: "revised", eventId: "arrival", field: "knowledge",
          before: one, after: "verified signed entry" } },
      { round: 0, findingIndex: 1, status: "resolved", reason: "Guard roster independently dated",
        evidence: { kind: "revised", eventId: "arrival", field: "knowledge",
          before: two, after: "independently dated guard roster" } },
      { round: 1, findingIndex: 0, status: "resolved", reason: "Guard roster independently dated",
        evidence: { kind: "revised", eventId: "arrival", field: "knowledge",
          before: two, after: "independently dated guard roster" } },
    ],
  }), stage2, assignment, afterFirst);
  assert.equal(lastReview.status, "pass");
  assert.equal(milestoneReviewStagnation([...afterFirst,
    { draft: stage2, review: lastReview, draftDigest: "three", reviewDigest: "pass" }]), 0);
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
  // An old source-bound v2 PASS remains readable in sealed history, but the
  // same response cannot be admitted as a new, insufficiently cited approval.
  const legacyPass = { ...verdict2, status: "pass", findings: [],
    prior: verdict2.prior!.map(p => ({ ...p, status: "resolved" })) };
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify(legacyPass),
    current2, assignment, [original, first]), /requires v3 correction evidence/);
  assert.equal(parseMilestoneBlueprintReview(JSON.stringify(legacyPass),
    current2, assignment, [original, first], "sealed-replay").status, "pass");
});
