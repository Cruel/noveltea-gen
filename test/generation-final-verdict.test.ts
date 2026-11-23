import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobReport } from "../src/job-report.js";
import { isTrustedFinalVerdictAnomaly } from "../src/generation-final-verdict.js";

/** Injection at the read-only report boundary: a genuine independently
 * attested success must never be rewritten into a completed Story by a Pi
 * diagnosis. The only admissible final anomaly is an inconsistent report
 * status over otherwise authenticated controller proofs. */
const report = {
  identity: { clean: true, headSha: "e".repeat(40) },
  generation: {
    status: "blocked", blockers: [], scopeFulfillment: "complete-in-scope",
    planFulfillment: { status: "passed" },
    review: { phase: "completed", worker: "pi", current: true },
    author: { executionControl: "running", budgetPause: null, pending: [] },
  },
  evidence: {
    editorial: { verdict: "pass" }, scope: { deterministic: "passed", diagnostics: [] },
    protection: { status: "checked" },
    authorApprovals: { required: false },
    deferredIdeas: { status: "ready", scopedOutstanding: [] },
  },
} as unknown as JobReport;

const adjusted = (path: (copy: any) => void): JobReport => {
  const copy = structuredClone(report);
  path(copy);
  return copy;
};

test("C05 only source-attested contradictory final verdicts reach the general read-only assessor", () => {
  assert.equal(isTrustedFinalVerdictAnomaly(report), true);
  for (const altered of [
    adjusted(p => { p.generation.status = "completed"; }),
    adjusted(p => { p.generation.status = "paused"; }),
    adjusted(p => { p.generation.blockers = ["Unknown native validation"]; }),
    adjusted(p => { p.generation.review.worker = "fixture"; }),
    adjusted(p => { p.generation.review.current = false; }),
    adjusted(p => { p.generation.planFulfillment.status = "required"; }),
    adjusted(p => { p.generation.planFulfillment.status = "incomplete"; }),
    adjusted(p => { p.generation.scopeFulfillment = "unverified"; }),
    adjusted(p => { p.generation.author.budgetPause = "modelCalls"; }),
    adjusted(p => { p.generation.author.executionControl = "paused"; }),
    adjusted(p => { p.generation.author.pending = [{ id:"author-only" }]; }),
    adjusted(p => { p.evidence.authorApprovals.required = true; }),
    adjusted(p => { p.evidence.deferredIdeas.scopedOutstanding = ["binding-idea"]; }),
    adjusted(p => { p.evidence.scope.diagnostics = [{ severity: "blocking" }]; }),
    adjusted(p => { p.evidence.scope.deterministic = "blocked"; }),
    adjusted(p => { p.evidence.editorial.verdict = "block"; }),
    adjusted(p => { p.evidence.protection.status = "unverified"; }),
    adjusted(p => { p.identity.clean = false; }),
  ]) assert.equal(isTrustedFinalVerdictAnomaly(altered), false);
});
