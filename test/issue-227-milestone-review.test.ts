/** #227: Milestone review must cover source-bound downstream obligations as well as Events. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseMilestoneBlueprint,
  parseMilestoneBlueprintReview,
  milestoneReviewStagnation,
  type MilestoneBlueprint,
} from "../src/milestone-blueprint.js";

const path = "milestones/gate.md";
const assignment = {
  milestoneId: "milestone.gate",
  milestonePath: path,
  sourcePaths: [path, "arcs/arrival.md"],
  characterIds: [],
};
const draft: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1",
  milestoneId: assignment.milestoneId,
  events: [
    {
      id: "register",
      purpose: "Inspect the dated gate log",
      dependsOn: [],
      participants: [],
      knowledge: "The investigator reads the dated register",
      routes: [],
      evidence: [
        {
          anchorPath: path,
          source: "Dated gate register",
          observation: "An entry bears the clerk's alias",
          access: "The ledger is available",
          establishes: "The alias was entered in the gate register",
          limits: "Does not establish who wrote the entry",
        },
      ],
    },
  ],
  downstream: [{ owner: "composition", obligation: "Make the register playable in the scene" }],
};
const review = (status: "pass" | "revise", findings: unknown[] = [], prior: unknown[] = []) =>
  JSON.stringify({ schema: "noveltea-milestone-blueprint-review/v5", status, findings, prior });
const meta = {
  anchorPath: path,
  requirement: "Required current-Milestone work needs an accurate owner",
  reason: "The downstream declaration does not state the correct required work",
  correction: "Replace or omit the false Interactive requirement",
};
const withInteractive: MilestoneBlueprint = {
  ...draft,
  downstream: [
    { owner: "interactive", obligation: "No Choice or Puzzle is needed for this Milestone" },
    ...draft.downstream,
  ],
};
const badOwner = {
  ...meta,
  evidence: {
    target: "downstream",
    index: 0,
    field: "obligation",
    quote: withInteractive.downstream[0]!.obligation,
    repair: "replace",
  },
};
const history = (original: MilestoneBlueprint, finding: unknown) => {
  const rejected = parseMilestoneBlueprintReview(review("revise", [finding]), original, assignment);
  return [{ draft: original, review: rejected, draftDigest: "original", reviewDigest: "review" }];
};
const passProof = (evidence: unknown) =>
  review(
    "pass",
    [],
    [
      {
        round: 0,
        findingIndex: 0,
        status: "resolved",
        reason: "The inaccurate required-work declaration was changed at its source",
        evidence,
      },
    ],
  );

test("#227 rejects non-string owner even when string coercion resembles an Interactive stage", () => {
  const malformed = { ...draft, downstream: [
    { owner: ["interactive"], obligation: "Must create a consequential Choice" },
    ...draft.downstream,
  ] };
  assert.throws(() => parseMilestoneBlueprint(JSON.stringify(malformed), assignment),
    /downstream obligation/);
  // In particular, a malformed owner may never bypass the Event-only
  // omission safeguard by surviving as an array in the reviewed plan.
  assert.equal(malformed.downstream.some(item => item.owner === "interactive"), false);
  const correct = { ...draft, downstream: [
    { owner: "interactive", obligation: "Must create a consequential Choice" },
    ...draft.downstream,
  ] };
  assert.equal(parseMilestoneBlueprint(JSON.stringify(correct), assignment).downstream[0]?.owner,
    "interactive");
});

test("#227 valid Event-only and genuinely interactive Milestones have a v5 path to approval", () => {
  assert.deepEqual(parseMilestoneBlueprint(JSON.stringify(draft), assignment), draft);
  assert.equal(parseMilestoneBlueprintReview(review("pass"), draft, assignment).status, "pass");
  const interactive: MilestoneBlueprint = {
    ...draft,
    events: [{
      ...draft.events[0]!,
      routes: [
        { condition: "The player provides informed consent",
          consequence: "The witness shares a verifiable dated account" },
        { condition: "The player refuses disclosure",
          consequence: "The witness stays anonymous; the public ledger remains accessible" },
      ],
    }],
    downstream: [
      { owner: "interactive", obligation: "Bind the player's refusal to a real Choice and its consequences" },
      ...draft.downstream,
    ],
  };
  assert.deepEqual(parseMilestoneBlueprint(JSON.stringify(interactive), assignment), interactive);
  assert.equal(interactive.events[0]?.routes.length, 2);
  assert.equal(parseMilestoneBlueprintReview(review("pass"), interactive, assignment).status, "pass");
});

test("#227 negative review can precisely cite a contradictory Interactive obligation and settle it", () => {
  const previous = history(withInteractive, badOwner);
  const corrected: MilestoneBlueprint = { ...draft };
  const proof = {
    target: "downstream",
    kind: "removed",
    index: 0,
    field: "obligation",
    before: withInteractive.downstream[0]!.obligation,
  };
  const result = parseMilestoneBlueprintReview(passProof(proof), corrected, assignment, previous);
  assert.equal(result.status, "pass");
  assert.equal(
    milestoneReviewStagnation([
      ...previous,
      {
        draft: corrected,
        review: result,
        draftDigest: "corrected",
        reviewDigest: "approved",
      },
    ]),
    0,
  );
  const wrong: MilestoneBlueprint = {
    ...withInteractive,
    events: [
      {
        ...withInteractive.events[0]!,
        purpose: "An unrelated prettier purpose",
      },
    ],
  };
  assert.throws(
    () => parseMilestoneBlueprintReview(passProof(proof), wrong, assignment, previous),
    /rejected|correction|downstream/,
  );
  const rewritten: MilestoneBlueprint = { ...withInteractive, downstream: [
    { owner: "interactive",
      obligation: withInteractive.downstream[0]!.obligation + " with extra words" },
    ...draft.downstream,
  ] };
  assert.throws(
    () => parseMilestoneBlueprintReview(passProof(proof), rewritten, assignment, previous),
    /rejected|correction|downstream/,
    "editing the rejected obligation without removing the claim cannot prove removal",
  );
  const forged = { ...badOwner, evidence: { ...badOwner.evidence, quote: "no such text" } };
  assert.throws(
    () => parseMilestoneBlueprintReview(review("revise", [forged]), withInteractive, assignment),
    /downstream|cited/,
  );
  assert.throws(
    () =>
      parseMilestoneBlueprintReview(
        review("revise", [
          {
            ...badOwner,
            anchorPath: "milestones/other.md",
          },
        ]),
        withInteractive,
        assignment,
      ),
    /source|downstream|cited/,
  );
});


test("#227 extending a rejected downstream obligation cannot keep an uncorrected duplicate", () => {
  const before = withInteractive.downstream[0]!.obligation;
  const extendFinding = { ...badOwner, evidence: {
    ...badOwner.evidence, repair: "extend" },
  };
  const previous = history(withInteractive, extendFinding);
  const clarified = before + ". This remains a pending player decision";
  const proof = { target: "downstream", kind: "added", index: 0, field: "obligation",
    before, after: "This remains a pending player decision" };
  const stillInvalid: MilestoneBlueprint = { ...withInteractive, downstream: [
    withInteractive.downstream[0]!,
    { owner: "interactive", obligation: clarified },
    ...draft.downstream,
  ] };
  assert.throws(() => parseMilestoneBlueprintReview(passProof(proof),
    stillInvalid, assignment, previous), /rejected|correction|downstream/);
  const valid: MilestoneBlueprint = { ...withInteractive, downstream: [
    { owner: "interactive", obligation: clarified },
    ...draft.downstream,
  ] };
  assert.equal(parseMilestoneBlueprintReview(passProof(proof),
    valid, assignment, previous).status, "pass");
});

test("#227 owner-field correction must replace the rejected entry without erasing another valid owner", () => {
  const invalid = { owner: "interactive" as const, obligation: "An optional next-Milestone puzzle" };
  const valid = { owner: "interactive" as const, obligation: "Bind the present refusal Choice" };
  const original: MilestoneBlueprint = { ...draft,
    downstream: [invalid, valid, ...draft.downstream] };
  const finding = { ...meta, evidence: { target: "downstream", index: 0,
    field: "owner", quote: "interactive", repair: "replace" } };
  const prior = history(original, finding);
  const removed = { ...draft, downstream: [valid, ...draft.downstream] };
  const removedProof = { target: "downstream", kind: "removed", index: 0,
    field: "owner", before: "interactive" };
  assert.equal(parseMilestoneBlueprintReview(passProof(removedProof),
    removed, assignment, prior).status, "pass");

  const merelyReworded: MilestoneBlueprint = { ...original,
    downstream: [{ ...invalid, obligation: "Still an unrelated optional puzzle" },
      valid, ...draft.downstream] };
  assert.throws(() => parseMilestoneBlueprintReview(passProof(removedProof),
    merelyReworded, assignment, prior), /correction|rejected|field/);

  const changed: MilestoneBlueprint = { ...original,
    downstream: [{ owner: "composition", obligation: invalid.obligation },
      valid, ...draft.downstream] };
  const revisedProof = { target: "downstream", kind: "revised", index: 0,
    field: "owner", before: "interactive", after: "composition" };
  assert.equal(parseMilestoneBlueprintReview(passProof(revisedProof),
    changed, assignment, prior).status, "pass");

  assert.throws(() => parseMilestoneBlueprintReview(review("revise", [{
    ...meta, evidence: { ...finding.evidence, repair: "extend" },
  }]), original, assignment), /owner|repair|downstream/);
});

test("#227 missing required downstream work has an exact collection citation and a verifiable addition", () => {
  const finding = {
    ...meta,
    correction: "Add required current-Milestone interactive Choice implementation",
    evidence: {
      target: "missing-downstream",
      owner: "interactive",
      quote: JSON.stringify(draft.downstream),
      repair: "extend",
    },
  };
  const previous = history(draft, finding);
  const corrected: MilestoneBlueprint = {
    ...draft,
    downstream: [
      ...draft.downstream,
      { owner: "interactive", obligation: "Implement the consent Choice for this Milestone" },
    ],
  };
  const proof = {
    target: "missing-downstream",
    kind: "added",
    owner: "interactive",
    before: JSON.stringify(draft.downstream),
    after: JSON.stringify(corrected.downstream[1]),
  };
  assert.equal(
    parseMilestoneBlueprintReview(passProof(proof), corrected, assignment, previous).status,
    "pass",
  );
  assert.throws(
    () => parseMilestoneBlueprintReview(passProof(proof), draft, assignment, previous),
    /downstream|correction|rejected/,
  );
  assert.throws(
    () =>
      parseMilestoneBlueprintReview(
        passProof({ ...proof, owner: "composition" }),
        corrected,
        assignment,
        previous,
      ),
    /downstream|correction|rejected/,
  );
  assert.throws(
    () =>
      parseMilestoneBlueprintReview(
        review("revise", [{ ...finding, evidence: { ...finding.evidence, quote: "[]" } }]),
        draft,
        assignment,
      ),
    /downstream|cited/,
  );
});

test("#227 sealed v4 rejection and correction replay unchanged, with no admission upgrade", () => {
  const original: MilestoneBlueprint = { ...draft, events: [{
    ...draft.events[0]!, knowledge: "The guard knows the unobserved exit route",
  }] };
  const finding = {
    eventId: "register", anchorPath: path,
    requirement: "Support every claimed knowledge transition",
    reason: "The exit route has no observable source",
    correction: "Replace the unearned route knowledge",
    evidence: { field: "knowledge", quote: original.events[0]!.knowledge, repair: "replace" },
  };
  const rejected = {
    schema: "noveltea-milestone-blueprint-review/v4", status: "revise",
    findings: [finding], prior: [],
  };
  const first = parseMilestoneBlueprintReview(JSON.stringify(rejected),
    original, assignment, [], "sealed-replay");
  const oldHistory = [{ draft: original, review: first,
    draftDigest: "historical", reviewDigest: "historical-review" }];
  const fixed: MilestoneBlueprint = { ...original, events: [{
    ...original.events[0]!, knowledge: "The dated gate register establishes a recorded arrival",
  }] };
  const corrected = {
    schema: "noveltea-milestone-blueprint-review/v4", status: "pass",
    findings: [], prior: [{ round: 0, findingIndex: 0, status: "resolved",
      reason: "The source-bound unearned assertion was replaced",
      evidence: { kind: "revised", eventId: "register", field: "knowledge",
        before: original.events[0]!.knowledge, after: fixed.events[0]!.knowledge } }],
  };
  assert.equal(parseMilestoneBlueprintReview(JSON.stringify(corrected), fixed,
    assignment, oldHistory, "sealed-replay").status, "pass");
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify(corrected), fixed,
    assignment, oldHistory), /v5/);
  const forged = { ...corrected, prior: [{ ...corrected.prior[0]!,
    evidence: { ...corrected.prior[0]!.evidence, before: "Fabricated old source" } }] };
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify(forged), fixed,
    assignment, oldHistory, "sealed-replay"), /correction|rejected|field/);
});

test("#227 prior Event-field findings remain verifiable in v5 and v4 seals remain historical", () => {
  const rejected = {
    eventId: "register",
    anchorPath: path,
    requirement: "Character knowledge must be earned",
    reason: "Unproved observation",
    correction: "Use only an inspected record",
    evidence: { field: "knowledge", quote: draft.events[0]!.knowledge, repair: "replace" },
  };
  const previous = history(draft, rejected);
  const corrected: MilestoneBlueprint = {
    ...draft,
    events: [{ ...draft.events[0]!, knowledge: "The player can inspect only the ledger date" }],
  };
  const proof = {
    kind: "revised",
    eventId: "register",
    field: "knowledge",
    before: draft.events[0]!.knowledge,
    after: corrected.events[0]!.knowledge,
  };
  assert.equal(
    parseMilestoneBlueprintReview(passProof(proof), corrected, assignment, previous).status,
    "pass",
  );
  const old = JSON.stringify({
    schema: "noveltea-milestone-blueprint-review/v4",
    status: "pass",
    findings: [],
    prior: [],
  });
  assert.throws(() => parseMilestoneBlueprintReview(old, draft, assignment), /v5|review/i);
  assert.equal(parseMilestoneBlueprintReview(old, draft, assignment, [], "sealed-replay").status, "pass");
  assert.throws(() => parseMilestoneBlueprintReview(review("pass"), draft, assignment, previous), /prior/i);
});

test("R14 live Milestone review failures identify exact zero-based identities and allowed fields", () => {
  const finding = { ...meta, eventId: draft.events[0]!.id, evidence: {
    field: "purpose", quote: draft.events[0]!.purpose, repair: "replace" } };
  const prior = history(draft, finding);
  const proposed = JSON.parse(passProof({ kind: "removed", eventId: draft.events[0]!.id, field: "purpose", before: draft.events[0]!.purpose }));
  proposed.prior[0].round = 1;
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify(proposed), draft, assignment, prior),
    /prior\[0\].*ZERO-BASED.*"round":0,"findingIndex":0/);
  const invalidField = { ...finding, evidence: { ...finding.evidence, field: "consequences" } };
  assert.throws(() => parseMilestoneBlueprintReview(review("revise", [invalidField]), draft, assignment),
    /findings\[0\]\.evidence\.field.*purpose, knowledge, dependsOn, participants, evidence, routes/);
  assert.throws(() => parseMilestoneBlueprintReview(review("revise", [{ ...finding, eventId: "event.not-provisional" }]), draft, assignment),
    /findings\[0\]\.eventId.*exact current provisional Event ID/);
  proposed.prior[0].round = 0;
  proposed.prior[0].evidence.eventId = "renamed-event";
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify(proposed), draft, assignment, prior),
    /prior\[0\].*original target\/Event ID/);
});
