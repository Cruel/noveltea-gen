import assert from "node:assert/strict";
import { test } from "node:test";
import { milestoneDiagnosticTrigger, milestoneDiagnosticFingerprint,
  parseMilestoneDiagnosis, milestoneDiagnosticDecision } from "../src/milestone-review-diagnostic.js";
import type { MilestoneBlueprint } from "../src/milestone-blueprint.js";

const draft: MilestoneBlueprint = {
  schema: "noveltea-milestone-blueprint/v1", milestoneId: "milestone.sample",
  events: [{ id: "arrival", purpose: "Inspect a dated register at the gate",
    knowledge: "The guard learns that the record was dated today", dependsOn: [],
    participants: [], routes: [], evidence: [{
      anchorPath: "milestones/sample.md", source: "The gate register",
      observation: "The entry is dated today", access: "The guard has the register",
      establishes: "An entry exists today", limits: "Not proof of an earlier visit",
    }] }],
  downstream: [{ owner: "composition", obligation: "Show the dated entry to the player" }],
};
const finding = { eventId: "arrival", anchorPath: "milestones/sample.md",
  requirement: "Support every knowledge claim", reason: "The register is not enough",
  correction: "Add independent corroboration",
  evidence: { field: "knowledge" as const, quote: "The guard learns that the record was dated today",
    repair: "replace" as const } };
const round = (digest: string) => ({
  draft, draftDigest: digest, reviewDigest: digest,
  review: { status: "revise" as const, findings: [finding] },
});
const sources = { task: "Design a source-grounded investigation of the register",
  contract: { objective: "Use only earned Character knowledge" } };
const diagnosis = {
  schema: "noveltea-milestone-diagnosis/v1",
  action: "continue", explanation: "The original claim still lacks independent corroboration",
  assessments: [{
    kind: "material", reason: "This is a current-stage evidence defect",
    requirement: { source: "contract", quote: "earned Character knowledge" },
    evidence: { eventId: "arrival", field: "knowledge",
      quote: "The guard learns that the record was dated today" },
  }],
};

test("#220 diagnoses demand cited current Event fields and accepted obligations, never approval", () => {
  assert.deepEqual(parseMilestoneDiagnosis(JSON.stringify(diagnosis), draft, sources), diagnosis);
  for (const value of [
    { ...diagnosis, action: "pass" },
    { ...diagnosis, assessments: [] },
    { ...diagnosis, assessments: [{ ...diagnosis.assessments[0],
      requirement: { source: "contract", quote: "invented new obligation" } }] },
    { ...diagnosis, assessments: [{ ...diagnosis.assessments[0],
      evidence: { eventId: "other", field: "knowledge", quote: "The guard learns that the record was dated today" } }] },
    { ...diagnosis, assessments: [{ ...diagnosis.assessments[0],
      evidence: { eventId: "arrival", field: "knowledge", quote: "unobserved secret" } }] },
  ]) assert.throws(() => parseMilestoneDiagnosis(JSON.stringify(value), draft, sources));
});

test("#220 detection is based on actual nonproductive rounds, not fixed semantic iteration caps", () => {
  const rounds = [round("one"), round("two"), round("three")];
  assert.equal(milestoneDiagnosticTrigger(rounds, [], 2), "stagnation");
  assert.equal(milestoneDiagnosticTrigger(rounds, [], 0), null);
  assert.equal(milestoneDiagnosticTrigger([...rounds, round("four"), round("five")], [], 0), "review-depth");
  assert.equal(milestoneDiagnosticTrigger([...rounds, round("four")], [3], 2), null);
  assert.equal(milestoneDiagnosticTrigger([...rounds, round("four"), round("five"), round("six")], [3], 2), "stagnation");
  assert.equal(milestoneDiagnosticTrigger(rounds, [1, 2], 3), null);
  assert.equal(milestoneDiagnosticTrigger([round("one")], [], 2), null);
});

test("#220 repeated unchanged cases stop, and diagnostic advice cannot confer approval or scope", () => {
  const fingerprint = milestoneDiagnosticFingerprint("cycle", draft, [finding], sources);
  assert.equal(fingerprint, milestoneDiagnosticFingerprint("cycle", draft, [
    { ...finding, reason: "rephrased complaint", correction: "different phrasing" },
  ], sources));
  assert.notEqual(fingerprint, milestoneDiagnosticFingerprint("cycle", { ...draft,
    events: [{ ...draft.events[0]!, knowledge: "A different claim" }] }, [finding], sources));
  assert.deepEqual(milestoneDiagnosticDecision("continue", false), { kind: "continue" });
  assert.deepEqual(milestoneDiagnosticDecision("replace", false), { kind: "replace" });
  assert.match(milestoneDiagnosticDecision("split", false).reason ?? "", /scope|plan/i);
  assert.match(milestoneDiagnosticDecision("escalate", false).reason ?? "", /escalat/i);
  assert.equal(milestoneDiagnosticDecision("continue", true).kind, "stop");
});
