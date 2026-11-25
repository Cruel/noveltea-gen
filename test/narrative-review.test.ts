import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import type { ValidationResult } from "../src/validator.js";
import type { Plan } from "../src/architecture.js";
import { auditNarrativeScope } from "../src/narrative-review.js";
import { verifiedNarrativeChain } from "../src/job-successor.js";
import { assertEditorialCorrectionPreserved, checkEditorialVerdict, missingEditorialRouteWitnesses, type ReviewAssignment } from "../src/narrative-review-specialist.js";

const root = mkdtempSync(join(tmpdir(), "nt-narrative-review-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));

function plan(kind: "full-story" | "partial" = "partial"): Plan {
  return { version: 4, items: [], contract: {
    scope: { kind, depth: "composition", targets: kind === "partial"
      ? ["arc.truth", "milestone.disclosure"] : [], branches: kind === "partial" ? ["protect", "challenge"] : [] },
    constraints: ["Protect or challenge the witness"],
    envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
  } };
}
function fixtureReport() {
  return {
    records: [
      { path: "arcs/truth.md", metadata: { type: "arc", id: "arc.truth", status: "draft" } },
      { path: "milestones/disclosure.md", metadata: { type: "milestone", id: "milestone.disclosure",
        status: "draft", arcs: ["arc.truth"] } },
      { path: "events/confront.md", metadata: { type: "event", id: "event.confront",
        status: "draft", arcs: ["arc.truth"], steps: [
          { id: "decision", branches: [{ id: "protect" }, { id: "challenge" }] }] } },
      { path: "authored-content/confront.md", metadata: { type: "authored-content",
        id: "authored-content.confront", status: "draft", events: ["event.confront"] } },
      { path: "arcs/side.md", metadata: { type: "arc", id: "arc.side", status: "draft" } },
      { path: "milestones/side.md", metadata: { type: "milestone", id: "milestone.side",
        status: "draft", arcs: ["arc.side"] } },
    ],
    diagnostics: [{ code: "side-not-ready", message: "Side Arc is incomplete", path: "milestones/side.md" }],
    outstanding: [{ id: "milestone.side", path: "milestones/side.md", requiredBy: "arc.side",
      code: "needs-events", message: "Unfulfilled side Arc" }],
    coverage: { search: { truncated: false },
      milestoneRoutes: [
        { id: "milestone.disclosure", routes: [{ alternative: 0, status: "reachable", witness: ["event.confront"] }] },
        { id: "milestone.side", routes: [{ alternative: 0, status: "incomplete", witness: [] }] },
      ],
      eventProgress: [{ id: "event.confront", status: "reachable", witness: ["event.confront"] }],
      branchProgress: [
        { event: "event.confront", step: "decision", branch: "protect",
          status: "reachable", witness: ["event.confront/protect"] },
        { event: "event.confront", step: "decision", branch: "challenge",
          status: "reachable", witness: ["event.confront/challenge"] },
      ], puzzleSolutions: [] },
    protection: { status: "checked", base: "expected", changes: [], warnings: [] },
    readiness: { design: { stages: { composition: { minimum: "draft" } } } },
  };
}
function validated(report: ReturnType<typeof fixtureReport>): ValidationResult {
  return { status: "rejected", report, contract: "noveltea-validator/v1", jobId: "fixture",
    worktreeStoryRoot: "/fixture/story", baseSha: "expected", exitCode: 1,
    validator: { contract: "noveltea-validator/v1", implementation: "native-cli",
      sha256: "a".repeat(64), executable: "/fixture/noveltea" },
  } as ValidationResult;
}
test("Luna source-range formatting correction cannot erase independent editorial blockers", () => {
  const before = { verdict: "block", findings: [{
    severity: "blocking", dimension: "continuity", source: "events/disclosure.md:28-33",
    message: "Immediate relationship change lacks branch-specific evidence.",
    repair: "event",
  }], evidence: ["events/disclosure.md:28 before correction"] };
  assert.throws(() => assertEditorialCorrectionPreserved(before,
    { verdict: "pass", findings: [], evidence: [] }), /cannot erase/);
  const corrected = assertEditorialCorrectionPreserved(before, {
    verdict: "block", findings: [{
      severity: "advisory", dimension: "pacing", source: "events/disclosure.md:28",
      message: "Unfounded reassessment", repair: "composition",
    }], evidence: ["events/disclosure.md:28 source-linked evidence"],
  });
  assert.deepEqual((corrected.findings as any[])[0], {
    ...before.findings[0], source: "events/disclosure.md:28",
  });
  const assignment = { paths: ["events/disclosure.md"], routes: [],
    puzzleRoutes: [], milestoneRoutes: [], specialistAssignments: [] } as unknown as ReviewAssignment;
  assert.equal(checkEditorialVerdict(corrected, assignment).verdict, "block");
});

test("partial scope ignores unrelated catalog failures, full scope requires the other Arc", () => {
  const report = fixtureReport();
  const partial = auditNarrativeScope(plan(), validated(report), "expected");
  assert.equal(partial.deterministic, "passed", JSON.stringify(partial.diagnostics));
  assert.equal(partial.unrelatedDiagnostics, 1);
  assert.equal(partial.outstanding.length, 0);
  assert.equal(partial.globalCatalog.status, "rejected");
  assert.ok(!partial.scopedRecords.includes("milestone.side"));
  assert.equal(auditNarrativeScope(plan(), validated(report), "expected", [
    { id: "idea-outside", scopeIds: ["arc.side"], message: "Binding idea is deferred" },
  ]).deterministic, "passed");
  const deferred = auditNarrativeScope(plan(), validated(report), "expected", [
    { id: "idea-inside", scopeIds: ["arc.truth"], message: "Binding idea is deferred" },
  ]);
  assert.ok(deferred.outstanding.some(o => o.id === "idea-inside"));
  assert.equal(deferred.deterministic, "blocked");
  const full = auditNarrativeScope(plan("full-story"), validated(report), "expected");
  assert.equal(full.deterministic, "blocked");
  assert.ok(full.outstanding.some(o => o.id === "milestone.side"));
  const finished = fixtureReport();
  finished.records = finished.records.filter(r => !r.metadata.id.endsWith("side"));
  finished.diagnostics = []; finished.outstanding = [];
  assert.equal(auditNarrativeScope(plan("full-story"), validated(finished), "expected").deterministic,
    "passed", "A fully realized small Story can satisfy its declared full-Story scope");
});
test("unreachable branch, unknown progression and unfulfilled obligation cannot pass", () => {
  const unreachable = fixtureReport();
  unreachable.coverage.branchProgress[0]!.status = "unreachable";
  assert.ok(auditNarrativeScope(plan(), validated(unreachable), "expected")
    .diagnostics.some(d => d.code === "branch-unreachable"));
  const uncertain = fixtureReport();
  uncertain.coverage.search.truncated = true;
  assert.ok(auditNarrativeScope(plan(), validated(uncertain), "expected")
    .diagnostics.some(d => d.severity === "uncertain"));
  const missing = fixtureReport();
  missing.outstanding.push({ id: "milestone.disclosure", path: "milestones/disclosure.md",
    requiredBy: "arc.truth", code: "unfulfilled", message: "No dramatic payoff" });
  assert.ok(auditNarrativeScope(plan(), validated(missing), "expected")
    .diagnostics.some(d => d.code === "unfulfilled-obligation"));
});
test("independent PASS requires exact source-linked route identities, not a #step/ paraphrase", () => {
  const assignment: ReviewAssignment = { contract: {}, planVersion: 1,
    scopeIds: ["milestone.disclosure"], paths: ["events/choice.md"],
    routes: [
      { event: "event.choice", step: "choose", branch: "protect", status: "reachable", witness: [] },
      { event: "event.choice", step: "choose", branch: "confront", status: "reachable", witness: [] },
    ], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [] };
  const malformed = [
    "event.choice#step/choose/protect: events/choice.md:20",
    "event.choice#step/choose/confront: events/choice.md:25",
  ];
  assert.deepEqual(missingEditorialRouteWitnesses(assignment, malformed), [
    "event.choice#choose/protect", "event.choice#choose/confront",
  ]);
  assert.throws(() => checkEditorialVerdict({ verdict: "pass", findings: [], evidence: malformed },
    assignment), /route witness/);
  const grounded = ["event.choice#choose/protect: events/choice.md:20",
    "event.choice#choose/confront: events/choice.md:25"];
  assert.deepEqual(missingEditorialRouteWitnesses(assignment, grounded), []);
  assert.equal(checkEditorialVerdict({ verdict: "pass", findings: [], evidence: grounded },
    assignment).verdict, "pass");
});

test("Character specialist review can source-link Character defects without inventing an Event owner", () => {
  const assignment: ReviewAssignment = {
    contract: {},
    planVersion: 2,
    scopeIds: ["character.mara"],
    paths: ["characters/mara.md"],
    routes: [],
    milestoneRoutes: [],
    puzzleRoutes: [],
    outstanding: [],
    uncertainties: [],
  };
  const verdict = checkEditorialVerdict(
    {
      verdict: "block",
      findings: [
        {
          severity: "blocking",
          dimension: "characterization",
          source: "characters/mara.md:12",
          repair: "character",
          message: "New Character asserts an off-screen event as already completed.",
        },
      ],
      evidence: ["characters/mara.md:12 unsupported prior claim"],
    },
    assignment,
  );
  assert.equal(verdict.findings[0]?.repair, "character");
  const noRedundantEvidence = checkEditorialVerdict(
    {
      verdict: "block",
      findings: verdict.findings,
      evidence: [],
    },
    assignment,
  );
  assert.equal(
    noRedundantEvidence.verdict,
    "block",
    "Preserve a source-linked Character blocker even without redundant evidence entries",
  );
  assert.throws(
    () => checkEditorialVerdict({ verdict: "pass", findings: [], evidence: [] }, assignment),
    /evidence linked/,
    "A PASS still needs independently linked positive evidence",
  );
  assert.throws(
    () =>
      checkEditorialVerdict(
        {
          verdict: "block",
          findings: [
            {
              ...verdict.findings[0],
              repair: "arbitrary-specialist",
            },
          ],
          evidence: verdict.evidence,
        },
        assignment,
      ),
    /invalid severity/,
  );
});

test("weak choice and Revelation leak remain independent editorial blocks", () => {
  const assignment: ReviewAssignment = { contract: plan().contract, planVersion: 4,
    scopeIds: ["arc.truth"], paths: ["authored-content/confront.md"],
    routes: [{ event: "event.confront", step: "decision", branch: "protect",
      status: "reachable", witness: [] }], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [] };
  const evidence = ["event.confront#decision/protect: authored-content/confront.md:12"];
  for (const [dimension, repair] of [["player-agency", "interactive"],
    ["conditional-knowledge", "composition"]] as const) {
    const verdict = checkEditorialVerdict({ verdict: "block",
      findings: [{ severity: "blocking", dimension, repair,
        source: "authored-content/confront.md:12", message: "Unjustified route consequence" }],
      evidence }, assignment);
    assert.equal(verdict.verdict, "block");
  }
  assert.throws(() => checkEditorialVerdict({ verdict: "pass", findings: [],
    evidence: ["generic prose is good"] }, assignment), /route witness|Story file lines/);
  assert.throws(() => checkEditorialVerdict({ verdict: "pass", findings: [{
    severity: "blocking", dimension: "player-agency", repair: "interactive",
    source: "authored-content/confront.md:12", message: "Weak choice" }], evidence }, assignment), /conflicts/);
  const blocked = checkEditorialVerdict({ verdict: "block", findings: [{
    severity: "blocking", dimension: "continuity", repair: "composition",
    source: "authored-content/confront.md:12", message: "Unproven branch-only disclosure" }],
    evidence: ["authored-content/confront.md:12: known on the protect route"] },
  { ...assignment, routes: [...assignment.routes, { event: "event.other", step: "t", branch: "b",
    status: "unverified", witness: [] }] });
  assert.equal(blocked.verdict, "block", "Independent blocking findings do not require invented positive witnesses");
  const withSpecialists: ReviewAssignment = { ...assignment, specialistAssignments: [{
    id: "focus:character.nia", specialist: "nt-character-development",
    outcome: "Revise Nia\'s motivation", targets: ["character.nia"],
    authority: { recordTypes: ["character"], existingPaths: ["characters/nia.md"], mayCreate: false },
  }] };
  assert.throws(() => checkEditorialVerdict({ verdict: "pass", findings: [], evidence },
    withSpecialists), /specialist assignment/);
  assert.equal(checkEditorialVerdict({ verdict: "pass", findings: [],
    evidence: [...evidence, "Reviewed motivation: characters/nia.md:7"] },
    withSpecialists).verdict, "pass");
  assert.equal(checkEditorialVerdict({ verdict: "pass", findings: [],
    evidence: ["event.confront#decision/protect: authored-content/confront.md:12",
      "milestone.disclosure#alternative 0: milestones/disclosure.md:9"] },
  { ...assignment, milestoneRoutes: [{ milestone: "milestone.disclosure", alternative: 0,
    status: "reachable", witness: [] }] }).verdict, "pass");
});
function git(cwd: string, ...args: string[]) {
  const x = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(x.status, 0, x.stderr); return x.stdout.trim();
}
