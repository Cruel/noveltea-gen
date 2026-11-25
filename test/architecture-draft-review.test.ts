import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseArchitectureDraftReview,
  architectureDraftFormatCorrection,
  architectureDraftConvergence,
  type ArchitectureDraftReview,
  type ArchitectureDraftRound,
} from "../src/architecture-draft-review.js";
import { parseArchitectureDraftDiagnosis } from "../src/architecture-draft-diagnosis.js";
import { sourceReviewDiagnosticTrigger } from "../src/review-cycle.js";

const paths = ["arcs/arc-one.md", "milestones/milestone-one.md"];
const requirements = {
  foundation: "The investigation must establish independent evidence of the hidden transfer.",
  contract: "Preserve the author's protected decision and meaningful lasting route changes.",
  task: "Determine where the missing witness went without exposing their identity.",
  blueprint: "The archive contains two independently inspectable records of the arrival.",
};
const original = {
  [paths[0]!]: "The witness transfer lacks any independently verifiable trail.",
  [paths[1]!]: "The arriving investigator hears the same story from a single witness.",
};
const finding = (path: string, quote: string, origin = "initial") => ({
  path,
  origin,
  reason: "The proposed corroboration has only a single source.",
  correction: "Name independent evidence available to the player in this exact stage.",
  requirement: { source: "foundation", quote: "independent evidence of the hidden transfer" },
  evidence: { path, quote },
});
const verdict = (findings: unknown[], prior: unknown[] = [], status = findings.length ? "revise" : "pass") =>
  JSON.stringify({ schema: "noveltea-architecture-draft-review/v2", status, findings, prior });
const initial = parseArchitectureDraftReview(
  verdict([finding(paths[0]!, "transfer lacks any independently verifiable trail")]),
  paths,
  original,
  requirements,
);
const round0: ArchitectureDraftRound = { sources: original, verdict: initial };
const status = (round: number, findingIndex: number, state: string, path: string, quote: string) => ({
  round,
  findingIndex,
  status: state,
  reason: "The current source now adds a separate test.",
  evidence: { path, quote },
});

test("stalled Architecture review obtains source-bound independent diagnosis, not an approval", () => {
  const diagnosis = {
    schema: "noveltea-architecture-draft-diagnosis/v1",
    action: "continue",
    explanation: "The register correction needs a different independent source.",
    assessments: [{
      kind: "material", reason: "The cited transfer record remains uncorroborated.",
      requirement: { source: "foundation", quote: "independent evidence of the hidden transfer" },
      evidence: { path: paths[0], quote: "transfer lacks any independently verifiable trail" },
    }],
  };
  assert.deepEqual(parseArchitectureDraftDiagnosis(JSON.stringify(diagnosis),
    original, requirements, [round0]), diagnosis);
  assert.throws(() => parseArchitectureDraftDiagnosis(JSON.stringify({
    ...diagnosis, action: "pass",
  }), original, requirements, [round0]), /bounded independent reassessment/);
  assert.throws(() => parseArchitectureDraftDiagnosis(JSON.stringify({
    ...diagnosis, assessments: [{ ...diagnosis.assessments[0],
      evidence: { path: paths[0], quote: "fabricated evidence" } }],
  }), original, requirements, [round0]), /exact existing source/);
  assert.throws(() => parseArchitectureDraftDiagnosis(JSON.stringify(diagnosis),
    original, requirements, []), /sealed negative review/);
});

test("Architecture draft review accepts only source-bound current-stage findings", () => {
  assert.equal(initial.status, "revise");
  assert.equal(initial.prior.length, 0);
  assert.deepEqual(parseArchitectureDraftReview(verdict([]), paths, original, requirements), {
    schema: "noveltea-architecture-draft-review/v2",
    status: "pass",
    findings: [],
    prior: [],
  });
  const guidance = architectureDraftFormatCorrection(paths);
  assert.match(guidance, /same read-only session/);
  assert.match(guidance, /every finding origin MUST be initial/);
  assert.match(architectureDraftFormatCorrection(paths, 2), /Round 2:.*initial is forbidden/);
  assert.match(guidance, /forward slashes, not periods/);
  assert.match(guidance, /milestones\/milestone-one.md/);
  assert.match(guidance, /grants no write scope/i);
  assert.throws(() => architectureDraftFormatCorrection(["../private.md"]), /authorized record paths/);
});

test("persistent Architecture reviewer can follow three improving revisions and pass", () => {
  const sources1 = {
    ...original,
    [paths[0]!]: original[paths[0]!] + " An independent shift log records the gate opening.",
  };
  const p0 = status(0, 0, "resolved", paths[0]!, "An independent shift log records the gate opening");
  const r1 = parseArchitectureDraftReview(
    verdict([finding(paths[1]!, "same story from a single witness", "overlooked")], [p0]),
    paths,
    sources1,
    requirements,
    [round0],
  );
  const c1 = architectureDraftConvergence(r1, sources1, [round0]);
  assert.equal(c1.productive, true);
  const round1 = { sources: sources1, verdict: r1 };
  const sources2 = {
    ...sources1,
    [paths[1]!]: sources1[paths[1]!] + " A second registrar confirms the witness transfer.",
  };
  const p1 = status(1, 0, "resolved", paths[1]!, "A second registrar confirms the witness transfer");
  const r2 = parseArchitectureDraftReview(
    verdict([finding(paths[0]!, "independently verifiable trail", "continuing")], [p0, p1]),
    paths,
    sources2,
    requirements,
    [round0, round1],
  );
  const c2 = architectureDraftConvergence(r2, sources2, [round0, round1], c1.stalled);
  assert.equal(c2.productive, true);
  const round2 = { sources: sources2, verdict: r2 };
  const sources3 = {
    ...sources2,
    [paths[0]!]: sources2[paths[0]!] + " A certified passenger list confirms the same identity.",
  };
  const p2 = status(2, 0, "resolved", paths[0]!, "A certified passenger list confirms the same identity");
  const pass = parseArchitectureDraftReview(verdict([], [p0, p1, p2]), paths, sources3, requirements, [
    round0,
    round1,
    round2,
  ]);
  assert.equal(architectureDraftConvergence(pass, sources3, [round0, round1, round2]).productive, true);
  assert.equal(pass.status, "pass");
});

test("Architecture stage and source authorization fail closed", () => {
  const valid = finding(paths[0]!, "transfer lacks any independently verifiable trail");
  for (const text of [
    "not JSON",
    "{}",
    verdict([{ ...valid, path: "creative-direction/foundation.md" }]),
    verdict([{ ...valid, path: "milestones/../private.md" }]),
    verdict([{ ...valid, evidence: { path: paths[1], quote: "transfer lacks any independently" } }]),
    verdict([{ ...valid, evidence: { path: paths[0], quote: "Unseen new evidence" } }]),
    verdict([{ ...valid, requirement: { source: "contract", quote: "There must be twelve Event scenes" } }]),
    verdict([{ ...valid, origin: "introduced" }]),
    verdict([{ ...valid, correction: "y".repeat(751) }]),
    verdict(Array(9).fill(valid)),
    JSON.stringify({ ...JSON.parse(verdict([valid])), approved: true }),
  ])
    assert.throws(
      () => parseArchitectureDraftReview(text, paths, original, requirements),
      /review|verdict|findings|JSON/i,
    );
  const notRead = verdict([valid], []);
  assert.throws(
    () => parseArchitectureDraftReview(notRead, paths, original, requirements, [round0]),
    /account|origin|unauthorized/,
  );
  const missingHistory = verdict(
    [finding(paths[0]!, "transfer lacks any independently verifiable trail", "continuing")],
    [],
  );
  assert.throws(
    () => parseArchitectureDraftReview(missingHistory, paths, original, requirements, [round0]),
    /account/,
  );
  assert.throws(
    () =>
      parseArchitectureDraftReview(
        verdict(
          [],
          [status(0, 0, "persisting", paths[0]!, "transfer lacks any independently verifiable trail")],
        ),
        paths,
        original,
        requirements,
        [round0],
      ),
    /unresolved findings/,
  );
});

test("Architecture reassessment respects late blockers, productive depth and the prior diagnostic boundary", () => {
  const negative = (origin: string) => ({ verdict: {
    status: "revise" as const, findings: [{ origin }],
  } });
  const stable = Array.from({ length: 5 }, () => negative("continuing"));
  assert.equal(sourceReviewDiagnosticTrigger(stable.slice(0, 4), 0), null);
  assert.equal(sourceReviewDiagnosticTrigger(stable, 0), "review-depth");
  assert.equal(sourceReviewDiagnosticTrigger([...stable.slice(0, 2),
    negative("introduced"), negative("overlooked")], 0), "late-blockers");
  assert.equal(sourceReviewDiagnosticTrigger(stable, 0, 4), null);
  assert.equal(sourceReviewDiagnosticTrigger([...stable, negative("continuing")], 2, 4), "stagnation");
  assert.equal(sourceReviewDiagnosticTrigger(stable, 2, 3), "stagnation",
    "a third independent assessment is required at a new stalled boundary");
  assert.equal(sourceReviewDiagnosticTrigger(stable, 2, 5), null,
    "the same sealed boundary must not immediately trigger another diagnosis");
});

test("Architecture nonprogress, stale proof, new blocker churn and oscillation never authorize a pass", () => {
  const p0 = status(0, 0, "persisting", paths[0]!, "transfer lacks any independently verifiable trail");
  const unchanged = parseArchitectureDraftReview(
    verdict([finding(paths[0]!, "transfer lacks any independently verifiable trail", "continuing")], [p0]),
    paths,
    original,
    requirements,
    [round0],
  );
  const c1 = architectureDraftConvergence(unchanged, original, [round0]);
  assert.equal(c1.productive, false);
  assert.equal(c1.stalled, 1);
  const round1 = { sources: original, verdict: unchanged };
  const p1 = status(1, 0, "persisting", paths[0]!, "transfer lacks any independently verifiable trail");
  const noisy = { ...original, [paths[0]!]: original[paths[0]!] + " Decorative flourish only." };
  const r2 = parseArchitectureDraftReview(
    verdict(
      [finding(paths[0]!, "transfer lacks any independently verifiable trail", "continuing")],
      [p0, p1],
    ),
    paths,
    noisy,
    requirements,
    [round0, round1],
  );
  const c2 = architectureDraftConvergence(r2, noisy, [round0, round1], c1.stalled);
  assert.equal(c2.productive, false);
  assert.equal(c2.reassess, true);
  assert.throws(
    () =>
      architectureDraftConvergence(
        parseArchitectureDraftReview(
          verdict(
            [],
            [status(0, 0, "resolved", paths[0]!, "transfer lacks any independently verifiable trail")],
          ),
          paths,
          original,
          requirements,
          [round0],
        ),
        original,
        [round0],
      ),
    /source-grounded progress|repeats/,
  );
});
