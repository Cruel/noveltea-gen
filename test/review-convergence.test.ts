import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateReviewConvergence, type ConvergentReview, type ReviewRound } from "../src/review-convergence.js";
import type { CausalBlueprint } from "../src/architecture-blueprint.js";

const sources = {
  foundation: "Investigate the missing clerk using independently corroborated dated records.",
  task: "Protect the witness and do not invent testimony.",
  contract: { constraints: ["Retain refusal routes"] },
};
const draft0: CausalBlueprint = {
  schema: "noveltea-causal-blueprint/v1", premise: "Clerk went missing",
  beats: [
    { id: "arrival", purpose: "Trace departure", dependsOn: [],
      change: "The old timetable shows a departure", decisions: [],
      observations: [{ source: "town schedule", observable: "Departure near dusk",
        supports: "Possible departure", limits: "No independent check" }] },
    { id: "archive", purpose: "Find a refuge", dependsOn: ["arrival"],
      change: "The records could show a hidden shelter", decisions: [],
      observations: [{ source: "gate record", observable: "A shelter gate opened at dusk",
        supports: "An arrival was possible", limits: "No matched independent record" }] },
  ],
  resolution: { question: "Where did the clerk go?", conclusion: "Safe refuge",
    supportedBy: ["archive"], uncertainty: "Identity protected" },
};
const baseFinding = {
  requirement: { source: "foundation" as const, quote: "independently corroborated dated records" },
};
function finding(beatId: "arrival" | "archive", quote: string,
  origin: "initial" | "continuing" | "introduced" | "overlooked" = "initial") {
  return {
    beatId, reason: "Dated evidence does not yet establish the underlying causal link.",
    correction: "Cross-check an independent dated primary-source record.",
    ...baseFinding, evidence: { beatId, quote }, origin,
  };
}
const cite = (beatId: string, quote: string) => ({ beatId, quote });
const initial: ConvergentReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
  findings: [finding("arrival", "Departure near dusk")],
};
const extra = (b: CausalBlueprint, beatId: "arrival" | "archive", text: string) => {
  const copy = structuredClone(b);
  copy.beats.find(x => x.id === beatId)!.observations.push({
    source: "independent shift record", observable: text,
    supports: "A corroborated and testable route", limits: "No witness name is revealed",
  });
  return copy;
};
const draft1 = extra(draft0, "arrival", "Signed station log independently confirms departure time");
const draft2 = extra(draft1, "archive", "Guard ledger separately records a sheltered arrival");
const draft3 = extra(draft2, "archive", "Registrar ledger independently links the two signed logs");
const prior = (round: number, findingIndex: number, status: "resolved" | "improved" |
  "persisting" | "regressed", beatId: string, quote: string) =>
  ({ round, findingIndex, status, reason: "Verified against a concrete source change.",
    evidence: cite(beatId, quote) });
const round1: ConvergentReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise",
  prior: [prior(0, 0, "resolved", "arrival", "Signed station log independently confirms departure time")],
  findings: [finding("archive", "A shelter gate opened at dusk", "overlooked")],
};
const round2: ConvergentReview = {
  schema: "noveltea-blueprint-review/v2", status: "revise",
  prior: [
    prior(0, 0, "resolved", "arrival", "Signed station log independently confirms departure time"),
    prior(1, 0, "resolved", "archive", "Guard ledger separately records a sheltered arrival"),
  ],
  findings: [finding("archive", "Guard ledger separately records a sheltered arrival", "introduced")],
};
const pass: ConvergentReview = {
  schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
  prior: [
    prior(0, 0, "resolved", "arrival", "Signed station log independently confirms departure time"),
    prior(1, 0, "resolved", "archive", "Guard ledger separately records a sheltered arrival"),
    prior(2, 0, "resolved", "archive", "Registrar ledger independently links the two signed logs"),
  ],
};
test("three material corrections can converge without a fixed semantic attempt ceiling", () => {
  const rounds: ReviewRound[] = [];
  const a = evaluateReviewConvergence(initial, draft0, rounds, sources);
  assert.equal(a.stalled, 0);
  rounds.push({ blueprint: draft0, verdict: initial });
  const b = evaluateReviewConvergence(round1, draft1, rounds, sources, a.stalled);
  assert.equal(b.productive, true);
  rounds.push({ blueprint: draft1, verdict: round1 });
  const c = evaluateReviewConvergence(round2, draft2, rounds, sources, b.stalled);
  assert.equal(c.productive, true);
  rounds.push({ blueprint: draft2, verdict: round2 });
  const d = evaluateReviewConvergence(pass, draft3, rounds, sources, c.stalled);
  assert.equal(d.productive, true);
  assert.equal(d.stalled, 0);
  assert.equal(d.reassess, false);
});
test("a changed or larger draft cannot substitute for corrected source evidence", () => {
  const old = [{ blueprint: draft0, verdict: initial }];
  const unproductive: ConvergentReview = {
    ...round1, findings: [finding("arrival", "Departure near dusk", "continuing")],
    prior: [prior(0, 0, "persisting", "arrival", "Departure near dusk")],
  };
  const changedButNotProof = extra(draft0, "archive", "Lots of unrelated new descriptive words");
  const first = evaluateReviewConvergence(unproductive, changedButNotProof, old, sources);
  assert.equal(first.productive, false);
  assert.equal(first.stalled, 1);
  const secondVerdict = { ...unproductive, prior: [
    ...unproductive.prior,
    prior(1, 0, "persisting", "arrival", "Departure near dusk"),
  ] };
  const second = evaluateReviewConvergence(secondVerdict, changedButNotProof,
    [...old, { blueprint: changedButNotProof, verdict: unproductive }], sources, first.stalled);
  assert.equal(second.reassess, true);
  assert.equal(second.oscillating, true);
  assert.equal(evaluateReviewConvergence(unproductive, draft0, old, sources).oscillating, true);
});
test("late regression cancels apparent progress and cannot be accepted as pass", () => {
  const earlier = [
    { blueprint: draft0, verdict: initial },
    { blueprint: draft1, verdict: round1 },
  ];
  const regressed: ConvergentReview = { ...round2, prior: [
    prior(0, 0, "regressed", "arrival", "Departure near dusk"),
    prior(1, 0, "resolved", "archive", "Guard ledger separately records a sheltered arrival"),
  ] };
  const result = evaluateReviewConvergence(regressed, draft2, earlier, sources);
  assert.equal(result.productive, false);
  assert.equal(result.stalled, 1);
  assert.throws(() => evaluateReviewConvergence(
    { ...regressed, status: "pass", findings: [] }, draft2, earlier, sources), /cannot approve/);
});
test("a precise resolution-only correction passes with every beat byte-identical", () => {
  const narrowed = structuredClone(draft0);
  narrowed.resolution.conclusion =
    "The shelter gate opened, but the clerk's arrival is still unproven";
  assert.equal(JSON.stringify(narrowed.beats), JSON.stringify(draft0.beats));
  const oldReview: ConvergentReview = {
    schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
    findings: [finding("archive", "A shelter gate opened at dusk")],
  };
  const passResolution: ConvergentReview = {
    schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
    prior: [{
      round: 0, findingIndex: 0, status: "resolved",
      reason: "The conclusion no longer overstates the documented gate opening.",
      evidence: { beatId: "resolution", field: "conclusion",
        quote: "The shelter gate opened, but the clerk's arrival is still unproven" },
    }],
  };
  const result = evaluateReviewConvergence(passResolution, narrowed,
    [{ blueprint: draft0, verdict: oldReview }], sources);
  assert.equal(result.productive, true);
  const extraSupport = structuredClone(draft0);
  extraSupport.resolution.supportedBy.push("arrival");
  const supportReview = structuredClone(passResolution);
  supportReview.prior[0]!.evidence = {
    beatId: "resolution", field: "supportedBy", quote: '["archive","arrival"]',
  };
  assert.equal(evaluateReviewConvergence(supportReview, extraSupport,
    [{ blueprint: draft0, verdict: oldReview }], sources).productive, true);
  assert.throws(() => evaluateReviewConvergence({ ...passResolution, prior: [{
    ...passResolution.prior[0]!,
    evidence: { beatId: "resolution", field: "conclusion", quote: "Invented finding never on disk" },
  }] }, narrowed, [{ blueprint: draft0, verdict: oldReview }], sources), /evidence is stale/);
});

test("a beat named resolution and the actual resolution field are distinct cited sources", () => {
  const withResolutionBeat = structuredClone(draft0);
  withResolutionBeat.beats.push({
    id: "resolution", purpose: "Reconcile the dated records", dependsOn: ["archive"],
    change: "The refuge records are compared at the final archive",
    decisions: [], observations: [{
      source: "registrar ledger",
      observable: "A registrar entry records a protected arrival",
      supports: "The alias may match the missing clerk",
      limits: "No independent verification of identity",
    }],
  });
  withResolutionBeat.resolution.supportedBy = ["resolution"];
  withResolutionBeat.resolution.conclusion = "The clerk definitely arrived at the shelter";
  const first: ConvergentReview = {
    schema: "noveltea-blueprint-review/v2", status: "revise", prior: [],
    findings: [finding("resolution", "A registrar entry records a protected arrival")],
  };
  assert.equal(evaluateReviewConvergence(first, withResolutionBeat, [], sources).review, first,
    "without a field, resolution identifies the existing causal beat");
  const fixed = structuredClone(withResolutionBeat);
  fixed.resolution.conclusion = "The registrar entry suggests but cannot prove an arrival";
  const passed: ConvergentReview = {
    schema: "noveltea-blueprint-review/v2", status: "pass", findings: [],
    prior: [prior(0, 0, "resolved", "resolution",
      "The registrar entry suggests but cannot prove an arrival")],
  };
  passed.prior[0]!.evidence = {
    beatId: "resolution", field: "conclusion",
    quote: "The registrar entry suggests but cannot prove an arrival",
  };
  assert.equal(evaluateReviewConvergence(passed, fixed,
    [{ blueprint: withResolutionBeat, verdict: first }], sources).productive, true,
    "with an explicit field, resolution identifies the corrected root conclusion");
  assert.throws(() => evaluateReviewConvergence({ ...first, findings: [{
    ...first.findings[0]!,
    evidence: { beatId: "resolution", field: "conclusion",
      quote: "A registrar entry records a protected arrival" },
  }] }, withResolutionBeat, [], sources), /source citation/,
    "a root citation must never search a same-named beat");
});

test("missing earlier blockers, fabricated source quotes and false new origins fail closed", () => {
  const old = [{ blueprint: draft0, verdict: initial }];
  assert.throws(() => evaluateReviewConvergence(
    { ...round1, prior: [] }, draft1, old, sources), /every previous/);
  assert.throws(() => evaluateReviewConvergence(
    { ...round1, findings: [finding("archive", "Invented unsupported quote", "overlooked")] },
    draft1, old, sources), /source citation/);
  assert.throws(() => evaluateReviewConvergence(
    { ...round1, findings: [{ ...finding("archive", "A shelter gate opened at dusk", "overlooked"),
      requirement: { source: "task", quote: "A nonexistent requirement is guaranteed" } }] },
    draft1, old, sources), /source citation/);
  assert.throws(() => evaluateReviewConvergence(
    { ...round1, findings: [finding("archive", "A shelter gate opened at dusk", "introduced")] },
    draft1, old, sources), /origin/);
});
