import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMilestoneInteractiveDisposition,
  consumedCorrection,
  milestoneRevisionImpact,
  type ReviewedMilestoneHandoff,
} from "../src/milestone-obligation-handoff.js";
import type { MilestoneBlueprint } from "../src/milestone-blueprint.js";

const original: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1",
  milestoneId: "milestone.disclosure",
  events: [{
    id: "register",
    purpose: "Find the original register",
    dependsOn: [],
    participants: [],
    knowledge: "The player can inspect the register",
    evidence: [{
      anchorPath: "milestones/disclosure.md",
      source: "The dated archive register",
      observation: "The signature differs from the witness statement",
      access: "The player can view the archived original",
      establishes: "The statement was modified",
      limits: "Does not identify the person responsible",
    }],
    routes: [],
  }],
  downstream: [
    { owner: "interactive", obligation: "Bind the player's decision to the witness's cooperation" },
    { owner: "composition", obligation: "Present the discovered difference as readable prose" },
  ],
};

test("#230 corrected ownership affects Interactive, Composition and completion, not a valid Event", () => {
  const corrected: MilestoneBlueprint = {
    ...original,
    downstream: original.downstream.filter(item => item.owner !== "interactive"),
  };
  assert.deepEqual(milestoneRevisionImpact(original, corrected), {
    event: false, interactive: true, composition: true, completion: true,
  });
  const handoff = { design: corrected } as ReviewedMilestoneHandoff;
  assert.doesNotThrow(() => assertMilestoneInteractiveDisposition(handoff, true));
  assert.throws(() => assertMilestoneInteractiveDisposition(
    { design: original } as ReviewedMilestoneHandoff, true),
  /reviewed interactive Milestone obligations/);
  const approved = { milestoneId: original.milestoneId, sourceSha: "a".repeat(40),
    cycleId: "b".repeat(64), digest: "c".repeat(64) };
  assert.deepEqual(consumedCorrection({ ...handoff, pin: approved, supersedes: {
    ...approved, digest: "d".repeat(64),
  } }), approved);
  assert.equal(consumedCorrection({ ...handoff, pin: approved }), undefined);
});

test("#230 unrelated Composition-only changes leave the reviewed Event and Interactive checkpoint reusable", () => {
  const corrected: MilestoneBlueprint = {
    ...original,
    downstream: original.downstream.map(item => item.owner === "composition"
      ? { ...item, obligation: "Present both copies with readable evidence" } : item),
  };
  assert.deepEqual(milestoneRevisionImpact(original, corrected), {
    event: false, interactive: false, composition: true, completion: true,
  });
  assert.deepEqual(milestoneRevisionImpact(original, original), {
    event: false, interactive: false, composition: false, completion: false,
  });
});

test("#230 a material Event correction revalidates every dependent, but never changes its identity", () => {
  const corrected: MilestoneBlueprint = {
    ...original,
    events: [{ ...original.events[0]!, knowledge: "The player knows the signature is false" }],
  };
  assert.deepEqual(milestoneRevisionImpact(original, corrected), {
    event: true, interactive: true, composition: true, completion: true,
  });
  assert.throws(() => milestoneRevisionImpact(original, {
    ...original, milestoneId: "milestone.foreign",
  }), /cannot change its original identity/);
});
