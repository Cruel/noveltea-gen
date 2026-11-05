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
import { checkEditorialVerdict, type ReviewAssignment } from "../src/narrative-review-specialist.js";

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
test("public review CLI inspects committed Story scope without confusing fixture with independent literary certification",
  { skip: !available }, async () => {
    const dir = join(root, "public"), story = join(dir, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player can protect a friend or demand accountability"
    origin: user
    authority: user-protected
premise: "A witness disappears before an archive inquiry"
central_conflict: "Expose a concealed ledger or preserve loyalty"
genre: "Mystery"
tone: "Intimate and uneasy"
player_experience: "Investigation and consequential conversations"
scope: "Two Characters and a single archive background"
---

Ada questions Neri about the missing witness.
`);
    git(dir, "init", "-q"); git(dir, "config", "user.name", "Author");
    git(dir, "config", "user.email", "author@example.test");
    git(dir, "add", "."); git(dir, "commit", "-qm", "Initial Story");
    const initial = git(dir, "rev-parse", "HEAD");
    const env = { ...process.env, NT_STATE_DIR: join(root, "public-state"),
      NT_CONFIG_FILE: join(root, "missing-config.json"),
      NT_SKILL_CACHE_DIR: join(root, "snapshots"),  };
    function cli(args: string[], jobId = "review-fixture") {
      const x = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", jobId], {
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000, env });
      assert.equal(x.status, 0, x.stderr); return JSON.parse(x.stdout);
    }
    const job = cli(["start"]);
    const contract = join(root, "public-contract.json");
    writeFileSync(contract, JSON.stringify(plan().contract));
    for (const args of [
      ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source],
      ["foundations", "run", "--fixture", "--skills-source", source],
      ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["composition", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ]) cli(args);
    const completedHead = git(job.worktreeRoot, "rev-parse", "HEAD");
    const first = cli(["review", "run", "--fixture", "--skills-source", source]);
    assert.equal(first.status, "editorial-unverified", JSON.stringify({ problems: first.audit?.diagnostics, routes: first.audit?.routeCoverage, scoped: first.audit?.scopedRecords }));
    assert.equal(first.audit.deterministic, "passed");
    assert.equal(first.audit.contractVersion, 1);
    assert.equal(first.audit.headSha, completedHead);
    assert.equal(first.editorial.verdict, "pass");
    assert.equal(first.worker, "fixture");
    assert.equal(cli(["review", "inspect"]).status, first.status);
    assert.equal(cli(["review", "run", "--fixture"]).headSha, completedHead);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), completedHead);
    assert.equal(git(dir, "rev-parse", "HEAD"), initial);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    const state = join(dirname(job.worktreeRoot), "narrative-review.json");
    assert.equal(JSON.parse(readFileSync(state, "utf8")).worker, "fixture");
    // Independently exercise a genuinely full-Story contract through the same
    // public job workflow rather than inferring full completion from a partial.
    const second = cli(["start"], "full-story");
    const fullContract = join(root, "full-contract.json");
    writeFileSync(fullContract, JSON.stringify(plan("full-story").contract));
    for (const args of [
      ["architecture", "run", "--fixture", "--contract", fullContract, "--skills-source", source],
      ["foundations", "run", "--fixture", "--skills-source", source],
      ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["composition", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ]) cli(args, "full-story");
    const fullReview = cli(["review", "run", "--fixture", "--skills-source", source], "full-story");
    assert.equal(fullReview.status, "editorial-unverified", JSON.stringify(fullReview.audit?.diagnostics));
    assert.equal(fullReview.audit.deterministic, "passed");
    assert.equal(fullReview.audit.assignment.contract.scope.kind, "full-story");
    assert.equal(git(second.worktreeRoot, "status", "--porcelain"), "");

    // A synthetic completed review receipt permits only the exact verified
    // Authored Content repair successor. This tests provenance enforcement,
    // not literary certification (the public fixture verdict remains unverified).
    const prose = "authored-content/disclosure-scene.md";
    const absolute = join(second.worktreeStoryRoot, prose);
    writeFileSync(absolute, readFileSync(absolute, "utf8") + "\nAda revisits the evidence.\n");
    const preceding = git(second.worktreeRoot, "rev-parse", "HEAD");
    const repoPath = second.storyRelativePath ? second.storyRelativePath + "/" + prose : prose;
    const blob = git(second.worktreeRoot, "hash-object", "--", absolute);
    const repairDigest = createHash("sha256").update(blob).digest("hex");
    git(second.worktreeRoot, "add", "--", repoPath);
    git(second.worktreeRoot, "commit", "-qm", ["Repair independently reviewed scoped prose", "",
      "NovelTea-Job: " + second.jobId,
      "NovelTea-Work-Item: review-scope-repair", "NovelTea-Plan-Version: 1",
      "NovelTea-Review-Repair: " + repairDigest].join("\n"));
    const revised = git(second.worktreeRoot, "rev-parse", "HEAD");
    const rootState = dirname(second.worktreeRoot);
    const reviewPath = join(rootState, "narrative-review.json");
    const receipt = JSON.parse(readFileSync(reviewPath, "utf8"));
    Object.assign(receipt, { worker: "pi", headSha: revised,
      repairPriorHead: preceding, repairCommitSha: revised,
      repairPaths: [prose], repairDigest,
      editorial: { verdict: "pass", findings: [], evidence: [prose + ":12"] } });
    receipt.audit.headSha = revised;
    assert.equal(receipt.audit.protection, "checked");
    const verifiedHeadPath = join(rootState, "revisions", "verified-head.json");
    writeFileSync(verifiedHeadPath, JSON.stringify({ version: 1, jobId: second.jobId,
      headSha: revised, workItemId: "review-scope-repair" }));
    writeFileSync(reviewPath, JSON.stringify(receipt));
    assert.equal(await verifiedNarrativeChain(second, preceding, revised), revised);
    const archiveDir = join(rootState, "review-history");
    mkdirSync(archiveDir);
    const archived = join(archiveDir, "plan-1-head-" + preceding + ".json");
    renameSync(reviewPath, archived);
    assert.equal(await verifiedNarrativeChain(second, preceding, revised), revised,
      "Later plan epochs must retain the earlier repair's verifiable provenance");
    receipt.repairDigest = "0".repeat(64);
    writeFileSync(archived, JSON.stringify(receipt));
    await assert.rejects(verifiedNarrativeChain(second, preceding, revised), /provenance|bytes/);
    assert.equal(git(dir, "rev-parse", "HEAD"), initial);
  });
