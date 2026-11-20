import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCompositionReview,
  parseCompositionDiagnosis,
  compositionReviewConvergence,
  compositionReviewRequirements,
  type CompositionReviewRound,
} from "../src/composition-review-policy.js";
import { sourceReviewDiagnosticTrigger } from "../src/review-cycle.js";

const path = "authored-content/disclosure.md";
const assignment = {
  composeTargets: ["event.disclosure"],
  branchWitnesses: [
    { event: "event.disclosure", step: "decision", branch: "protect", witness: ["event.entry"] },
    { event: "event.disclosure", step: "decision", branch: "refuse", witness: ["event.entry"] },
  ],
};
const original = {
  [path]:
    "## Shared entry\n\nAda knows the route-only key before the choice.\n\n## Refuse selected\n\nShe refuses the offer.",
};
const requirements = { assignment: JSON.stringify(assignment), policy: compositionReviewRequirements };
const finding = (quote: string, origin = "initial") => ({
  path,
  origin,
  reason: "The least-informed route cannot know the key.",
  correction: "Move the key disclosure under the outcome that earns it.",
  requirement: { source: "policy", quote: "Shared entry must not assume unavailable route-specific clues" },
  evidence: { path, quote },
});
const prior = (quote: string, status = "resolved") => ({
  round: 0,
  findingIndex: 0,
  status,
  reason: "The shared entry no longer discloses the key.",
  evidence: { path, quote },
});
const payload = (status: "pass" | "revise", findings: unknown[], previous: unknown[] = []) =>
  JSON.stringify({
    schema: "noveltea-composition-review/v2",
    status,
    findings,
    prior: previous,
    sourceEvidence: ["event.disclosure#decision/protect", "event.disclosure#decision/refuse"],
  });
const first = parseCompositionReview(
  payload("revise", [finding("Ada knows the route-only key")]),
  [path],
  original,
  requirements,
);
const history: CompositionReviewRound[] = [{ sources: original, verdict: first }];

test("Composition reviewer cites actual source and authorized requirements", () => {
  assert.equal(first.status, "revise");
  assert.throws(
    () =>
      parseCompositionReview(
        payload("revise", [finding("imaginary source")]),
        [path],
        original,
        requirements,
      ),
    /source|evidence/i,
  );
  assert.throws(
    () =>
      parseCompositionReview(
        payload("revise", [
          {
            ...finding("Ada knows the route-only key"),
            requirement: { source: "policy", quote: "invented policy" },
          },
        ]),
        [path],
        original,
        requirements,
      ),
    /requirement|source/i,
  );
  assert.throws(
    () => parseCompositionReview(payload("pass", []), [path], original, requirements, history),
    /previous|prior/i,
  );
});

test("Composition reviewer accepts multiple productive repairs, then exact-current pass", () => {
  const revised = {
    [path]: original[path]!.replace(
      "Ada knows the route-only key before the choice.",
      "Ada cannot determine the key until she chooses a route.",
    ),
  };
  const second = parseCompositionReview(
    payload(
      "revise",
      [finding("Ada cannot determine the key", "continuing")],
      [prior("Ada cannot determine the key", "improved")],
    ),
    [path],
    revised,
    requirements,
    history,
  );
  const c1 = compositionReviewConvergence(second, revised, history);
  assert.equal(c1.productive, true);
  const final = {
    [path]: revised[path]! + "\n\n## Protect selected\n\nThe player discovers the key after earning it.",
  };
  const all = [...history, { sources: revised, verdict: second }];
  const pass = parseCompositionReview(
    JSON.stringify({
      schema: "noveltea-composition-review/v2",
      status: "pass",
      findings: [],
      prior: [
        prior("The player discovers the key after earning it."),
        { ...prior("The player discovers the key after earning it."), round: 1, status: "resolved" },
      ],
      sourceEvidence: ["event.disclosure#decision/protect", "event.disclosure#decision/refuse"],
    }),
    [path],
    final,
    requirements,
    all,
  );
  assert.equal(compositionReviewConvergence(pass, final, all, c1.stalled).productive, true);
});

test("Composition nonprogress and oscillation cannot become a pass", () => {
  const recurring = parseCompositionReview(
    payload(
      "revise",
      [finding("Ada knows the route-only key", "continuing")],
      [prior("Ada knows the route-only key", "persisting")],
    ),
    [path],
    original,
    requirements,
    history,
  );
  const next = compositionReviewConvergence(recurring, original, history);
  assert.equal(next.productive, false);
  assert.equal(next.oscillating, true);
  assert.equal(next.stalled, 1);
  assert.throws(
    () =>
      parseCompositionReview(
        payload("pass", [], [prior("Ada knows the route-only key", "persisting")]),
        [path],
        original,
        requirements,
        history,
      ),
    /cannot pass|unresolved/i,
  );
  assert.equal(
    sourceReviewDiagnosticTrigger(
      [
        ...history,
        {
          sources: original,
          verdict: recurring,
        },
      ],
      2,
    ),
    "stagnation",
  );
});

test("Composition diagnostic cannot produce approval or fabricate a material source", () => {
  const diagnosis = {
    schema: "noveltea-composition-diagnosis/v1",
    action: "continue",
    explanation: "The current refused route still exposes a clue without prior access.",
    assessments: [
      {
        kind: "material",
        reason: "The shared route text presumes knowledge before the choice.",
        requirement: {
          source: "policy",
          quote: "Shared entry must not assume unavailable route-specific clues",
        },
        evidence: { path, quote: "Ada knows the route-only key" },
      },
    ],
  };
  assert.equal(
    parseCompositionDiagnosis(JSON.stringify(diagnosis), [path], original, requirements).action,
    "continue",
  );
  assert.throws(
    () =>
      parseCompositionDiagnosis(
        JSON.stringify({
          ...diagnosis,
          action: "pass",
        }),
        [path],
        original,
        requirements,
      ),
    /invalid bounded disposition/,
  );
  assert.throws(
    () =>
      parseCompositionDiagnosis(
        JSON.stringify({
          ...diagnosis,
          assessments: [
            { ...diagnosis.assessments[0], evidence: { path, quote: "The magically repaired source" } },
          ],
        }),
        [path],
        original,
        requirements,
      ),
    /current source/,
  );
});
