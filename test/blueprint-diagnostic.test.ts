import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticCaseFingerprint, diagnosticEvidence, diagnosticTrigger, parseBlueprintDiagnosis } from "../src/blueprint-diagnostic.js";
import { evaluateReviewConvergence, type ConvergentReview, type ReviewRound } from "../src/review-convergence.js";
import type { CausalBlueprint } from "../src/architecture-blueprint.js";

const blueprint: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v1",
  premise: "A missing clerk must be found without exposing the witness.",
  beats: [
    { id: "arrival", purpose: "Find arrival date", dependsOn: [], decisions: [],
      change: "A dated town entry suggests a disappearance",
      observations: [{ source: "town ledger",
        observable: "The clerk departed at dusk",
        supports: "Departure is provisionally recorded",
        limits: "The departure has no separate witness" }] },
    { id: "archive", purpose: "Check independent sources", dependsOn: ["arrival"],
      decisions: [], change: "Compare the independent gate and guard ledgers",
      observations: [{ source: "gate ledger",
        observable: "A protected shelter arrival was registered at dusk",
        supports: "The clerk reached the shelter",
        limits: "Witness identity stays protected" }] },
  ],
  resolution: { question: "Where is the clerk?",
    conclusion: "Independent guard and gate ledgers prove the clerk reached shelter",
    supportedBy: ["archive"], uncertainty: "Identity of witness is protected" },
};
const sources = {
  foundation: "Protect the witness and rely on two independent dated records.",
  task: "Independently establish the missing clerk's arrival at shelter.",
  contract: { scope: "Protect the witness from exposure" },
};
const finding = {
  beatId: "arrival",
  reason: "Only one source supports the claimed departure.",
  correction: "Corroborate the departure with a second dated record.",
  requirement: { source: "foundation" as const, quote: "two independent dated records" },
  evidence: { beatId: "arrival", quote: "The clerk departed at dusk" },
  origin: "initial" as const,
};
const rejected: ConvergentReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise", prior: [], findings: [finding],
};
const round: ReviewRound = { blueprint, verdict: rejected };
const current = { ...round, verdict: { ...rejected, findings: [
  { ...finding, origin: "overlooked" as const },
] } };
const introduced = { ...round, verdict: { ...rejected, findings: [
  { ...finding, origin: "introduced" as const },
] } };
const assessment = {
  kind: "material" as const, reason: "An independent source must verify this.",
  requirement: { source: "foundation" as const, quote: "two independent dated records" },
  evidence: { beatId: "arrival", quote: "The clerk departed at dusk" },
};
const diagnosis = {
  schema: "noveltea-blueprint-diagnosis/v1",
  action: "replace", explanation: "Persistent review is rejecting work without checking actual source.",
  assessments: [assessment],
};

test("diagnostic triggers detect stagnation, late goalposts and soft depth without recursive escalation", () => {
  assert.equal(diagnosticTrigger([round, round, round], 2), "stagnation");
  assert.equal(diagnosticTrigger([round, round, current, introduced], 0), "late-blockers");
  assert.equal(diagnosticTrigger([round, round, round, round, round], 0), "review-depth");
  assert.equal(diagnosticTrigger([round, round, round, round, round], 0, 2), null);
  assert.equal(diagnosticTrigger([round, round, round, round, round, round], 0, 1, 5), null);
  assert.equal(diagnosticTrigger(Array(10).fill(round), 0, 1, 5), "review-depth");
  assert.equal(diagnosticTrigger([round, round, round], 2, 2), null);
  assert.equal(diagnosticTrigger([{ ...round, verdict: {
    ...rejected, status: "pass", findings: [],
  } }], 2), null);
});

test("diagnoses require bounded current-source citations and exact approved obligations", () => {
  assert.deepEqual(parseBlueprintDiagnosis(JSON.stringify(diagnosis), blueprint, sources), diagnosis);
  assert.throws(() => parseBlueprintDiagnosis(JSON.stringify({
    ...diagnosis, assessments: [{ ...assessment,
      requirement: { source: "foundation", quote: "Invented new requirement" },
    }],
  }), blueprint, sources), /source citation/);
  assert.throws(() => parseBlueprintDiagnosis(JSON.stringify({
    ...diagnosis, assessments: [{ ...assessment, evidence:
      { beatId: "archive", quote: "The clerk departed at dusk" },
    }],
  }), blueprint, sources), /source citation/);
  assert.throws(() => parseBlueprintDiagnosis(JSON.stringify({
    ...diagnosis, action: "pass",
  }), blueprint, sources), /disposition/);
  assert.throws(() => parseBlueprintDiagnosis(JSON.stringify({
    ...diagnosis, assessments: [],
  }), blueprint, sources), /disposition/);
});

test("diagnostic identity changes with actual source, verdict and acceptance contract", () => {
  const id = diagnosticEvidence("cycle-a", [round], sources);
  assert.notEqual(id, diagnosticEvidence("cycle-b", [round], sources));
  assert.notEqual(id, diagnosticEvidence("cycle-a", [round], { ...sources, task: "New objective" }));
  assert.notEqual(id, diagnosticEvidence("cycle-a", [{ ...round,
    blueprint: { ...blueprint, premise: "A different crime" },
  }], sources));
  assert.notEqual(id, diagnosticEvidence("cycle-a", [current], sources));
});

test("the same source and material blockers cannot recursively create new diagnostic cases", () => {
  const first = diagnosticCaseFingerprint("cycle", blueprint, rejected, sources);
  const relabeled: ConvergentReview = { ...rejected,
    prior: [{ round: 0, findingIndex: 0, status: "persisting",
      reason: "The first failure still applies.",
      evidence: { beatId: "arrival", quote: "The clerk departed at dusk" } }],
    findings: [{ ...finding, origin: "continuing",
      reason: "A second statement of the same blocker.", correction: "Different phrasing." }],
  };
  assert.equal(first, diagnosticCaseFingerprint("cycle", blueprint, relabeled, sources));
  assert.notEqual(first, diagnosticCaseFingerprint("another-cycle", blueprint, rejected, sources));
  assert.notEqual(first, diagnosticCaseFingerprint("cycle", blueprint, rejected,
    { ...sources, task: "A revised objective" }));
  assert.notEqual(first, diagnosticCaseFingerprint("cycle",
    { ...blueprint, premise: "A completely new story" }, rejected, sources));
  assert.notEqual(first, diagnosticCaseFingerprint("cycle", blueprint, {
    ...rejected, findings: [{ ...finding,
      evidence: { beatId: "archive", quote: "A protected shelter arrival was registered at dusk" },
    }],
  }, sources));
});

test("an independent replacement may settle an unchanged disputed draft only with a valid current verdict", () => {
  const pass: ConvergentReview = {
    schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
    prior: [{ round: 0, findingIndex: 0, status: "resolved",
      reason: "Guard ledger is already independently inspectable on the current route.",
      evidence: { beatId: "archive", quote: "A protected shelter arrival was registered at dusk" } }],
  };
  assert.throws(() => evaluateReviewConvergence(pass, blueprint, [round], sources),
    /no verified material source progress/);
  assert.equal(evaluateReviewConvergence(pass, blueprint, [round], sources, 0, true).review.status, "pass");
  const notResolved = { ...pass, prior: [{ ...pass.prior[0]!, status: "persisting" }] };
  assert.throws(() => evaluateReviewConvergence(notResolved, blueprint, [round], sources, 0, true),
    /cannot approve a persisting/);
});
