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

test("#227 valid Event-only and genuinely interactive Milestones have a v5 path to approval", () => {
  assert.deepEqual(parseMilestoneBlueprint(JSON.stringify(draft), assignment), draft);
  assert.equal(parseMilestoneBlueprintReview(review("pass"), draft, assignment).status, "pass");
  const interactive: MilestoneBlueprint = {
    ...draft,
    downstream: [
      { owner: "interactive", obligation: "Bind the player's refusal to a real Choice and its consequences" },
      ...draft.downstream,
    ],
  };
  assert.deepEqual(parseMilestoneBlueprint(JSON.stringify(interactive), assignment), interactive);
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
