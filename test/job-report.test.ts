import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-job-report-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(skills, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
}
function setup(name: string, unfinishedUnrelatedArc = false) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player may protect or challenge the witness"
    origin: user
    authority: user-protected
premise: "A witness disappears before an archive inquiry"
central_conflict: "Expose a concealed ledger or preserve loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Investigation"
scope: "Two Characters and a single archive"
---

Ada questions Neri about the missing witness.
`);
  if (unfinishedUnrelatedArc) {
    mkdirSync(join(story, "arcs"), { recursive: true });
    writeFileSync(join(story, "arcs", "side.md"), `---
schema: '0.1'
type: arc
id: arc.side
title: "The unrelated missing heir"
status: draft
decisions: []
dramatic_question: "Who will inherit the distant estate?"
characters: []
---

This separate Arc has no Milestones, Events, or authored ending.
`);
  }
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "config", "user.name", "Author");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Story baseline");
  const base = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),

    NT_SKILL_CACHE_DIR: join(root, name + "-skills"),
    NT_CONFIG_FILE: join(root, "nonexistent.json") };
  const call = (args: string[], job = "draft") => spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", ...args, "--story", story, "--job", job],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 48 * 1024 * 1024, env });
  const ok = (args: string[], job = "draft") => {
    const result = call(args, job);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const started = ok(["start"]);
  return { repo, story, base, job: started, call, ok, env };
}
function plan(kind: "full-story" | "partial") {
  return {
    scope: { kind, depth: "composition",
      targets: kind === "partial" ? ["arc.truth", "milestone.disclosure"] : [],
      branches: kind === "partial" ? ["protect", "challenge"] : [] },
    constraints: ["The witness can be protected or challenged"],
    envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
  };
}
function generate(x: ReturnType<typeof setup>, name: string, kind: "full-story" | "partial" = "partial") {
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify(plan(kind)));
  for (const stage of [
    ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", skills],
    ["foundations", "run", "--fixture", "--skills-source", skills],
    ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", skills],
    ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", skills],
    ["composition", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", skills],
  ]) x.ok(stage, name);
}
function idea(name: string, scopeId: string) {
  const path = join(root, name + "-idea.json");
  const original = "Secret dormant dialogue: never leak these words to workers.";
  writeFileSync(path, JSON.stringify({
    id: name + "-idea", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "private notes" }, original,
    requirements: { meaning: [{ text: "Changes the detective's motivation", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] }, prerequisites: [],
    placement: { scopeIds: [scopeId], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  return { path, original };
}
test("public report has stable IDs, no accidental Story writes, explicit unassessed integration and safe exports", () => {
  const x = setup("initial");
  const before = git(x.repo, "status", "--porcelain");
  const report = x.ok(["report"]);
  assert.equal(report.schema, "noveltea-job-report/v1");
  assert.equal(report.identity.baseSha, x.base);
  assert.match(report.identity.storyId, /^story-[a-f0-9]{24}$/);
  assert.equal(report.identity.headSha, x.base);
  assert.equal(report.identity.branch, x.job.branch);
  assert.equal(report.identity.threadId, x.job.threadId);
  assert.equal(report.generation.status, "paused");
  assert.equal(report.generation.scopeFulfillment, "unverified");
  assert.equal(report.integration.status, "not assessed");
  assert.equal(report.plan, null);
  assert.equal(x.ok(["report"]).identity.threadId, report.identity.threadId);
  const rendered = x.call(["report", "--format", "markdown"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /# NovelTea Story job report/);
  assert.match(rendered.stdout, /Integration: not assessed/);
  const destination = join(root, "author-report.md");
  assert.equal(x.ok(["report", "--format", "markdown", "--output", destination]).status, "exported");
  assert.match(readFileSync(destination, "utf8"), /Scope fulfillment/);
  assert.notEqual(x.call(["report", "--output", destination]).status, 0,
    "An existing report must never be overwritten implicitly");
  assert.notEqual(x.call(["report", "--output", join(x.story, "forbidden.json")]).status, 0);
  assert.equal(existsSync(join(x.story, "forbidden.json")), false);
  const alias = join(root, "author-alias");
  symlinkSync(x.repo, alias);
  assert.notEqual(x.call(["report", "--output", join(alias, "also-forbidden.json")]).status, 0);
  const pendingFile = join(root, "private-message.json");
  const privateText = "SECRET AUTHOR QUESTION NOT FOR REPORT";
  writeFileSync(pendingFile, JSON.stringify({
    id: "question-pending", kind: "question", payload: { question: privateText },
  }));
  x.ok(["author", "send", "--file", pendingFile]);
  const queued = x.ok(["report"]);
  assert.equal(queued.generation.status, "paused");
  assert.deepEqual(queued.generation.author.pending.map((x: { id: string }) => x.id), ["question-pending"]);
  assert.equal(queued.evidence.authorApprovals.required, true);
  assert.ok(!JSON.stringify(queued).includes(privateText));
  assert.equal(git(x.repo, "status", "--porcelain"), before);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
});
test("bounded Arc and small full-Story fixture reports retain true unverified literary status", {
  skip: !available,
}, () => {
  const x = setup("complete-fixture");
  generate(x, "draft");
  const state = x.ok(["review", "run", "--fixture", "--skills-source", skills]);
  assert.equal(state.status, "editorial-unverified");
  const report = x.ok(["report"]);
  assert.equal(report.plan.version, 1);
  assert.deepEqual(report.plan.scope.targets, ["arc.truth", "milestone.disclosure"]);
  assert.equal(report.generation.status, "paused", "Fixture cannot independently certify completion");
  assert.equal(report.evidence.scope.deterministic, "passed");
  assert.equal(report.evidence.scope.current, true);
  assert.equal(report.evidence.protection.status, "checked");
  assert.equal(report.evidence.editorial.verdict, "unverified");
  assert.ok(report.workItems.some((i: { kind: string; commitSha?: string }) =>
    i.kind === "composition" && i.commitSha));
  assert.ok(report.commits.length >= 5);
  assert.equal(report.commits.at(-1).sha, report.identity.headSha);
  assert.equal(report.identity.headSha, git(x.job.worktreeRoot, "rev-parse", "HEAD"));

  const full = x.ok(["start"], "full");
  generate(x, "full", "full-story");
  x.ok(["review", "run", "--fixture", "--skills-source", skills], "full");
  const whole = x.ok(["report"], "full");
  assert.equal(whole.identity.storyId, report.identity.storyId,
    "A second job on the same canonical Story retains the same logical Story identity");
  assert.equal(whole.plan.scope.kind, "full-story");
  assert.equal(whole.evidence.scope.deterministic, "passed");
  assert.equal(whole.generation.status, "paused");
  assert.equal(whole.identity.headSha, git(full.worktreeRoot, "rev-parse", "HEAD"));
  // Simulated verified Pi completion exercises only projection.
  const fullReceiptPath = join(dirname(full.worktreeRoot), "narrative-review.json");
  const reviewedFull = JSON.parse(readFileSync(fullReceiptPath, "utf8"));
  reviewedFull.worker = "pi";
  reviewedFull.editorial = { verdict: "pass", findings: [],
    evidence: ["authored-content/disclosure-scene.md:12"] };
  writeFileSync(fullReceiptPath, JSON.stringify(reviewedFull));
  const historicalFull = x.ok(["report"], "full");
  assert.equal(historicalFull.generation.status, "blocked");
  assert.equal(historicalFull.generation.planFulfillment.status, "required");
  assert.ok(historicalFull.generation.blockers.some((b: string) => /current-format Turn/.test(b)));
  x.ok(["author", "control", "--state", "paused"], "full");
  const pausedCompleted = x.ok(["report"], "full");
  assert.equal(pausedCompleted.generation.status, "paused");
  assert.equal(pausedCompleted.generation.scopeFulfillment, "complete-in-scope",
    "Execution control cannot invalidate a verified committed Story's fulfillment");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.base);
});
test("public bounded-scope report distinguishes an unfinished unrelated Arc", {
  skip: !available,
}, () => {
  const x = setup("unrelated-arc", true);
  generate(x, "draft");
  const review = x.ok(["review", "run", "--fixture", "--skills-source", skills]);
  assert.equal(review.audit.deterministic, "passed", JSON.stringify(review.audit.diagnostics));
  assert.ok(!review.audit.scopedRecords.includes("arc.side"));
  const report = x.ok(["report"]);
  assert.equal(report.evidence.scope.deterministic, "passed");
  assert.equal(report.plan.scope.kind, "partial");
  assert.ok(!report.generation.blockers.some((x: string) => x.includes("arc.side")));
  assert.equal(report.generation.scopeFulfillment, "unverified",
    "An independent literary review is still required.");
});

test("in-scope binding idea blocks, out-of-scope idea does not; no private text in report", {
  skip: !available,
}, () => {
  const x = setup("idea-audit");
  generate(x, "draft");
  const inside = idea("inside", "arc.truth");
  const out = idea("outside", "arc.unrelated");
  const a = x.ok(["ideas", "capture", "--file", inside.path]);
  const b = x.ok(["ideas", "capture", "--file", out.path]);
  assert.ok(a.commitSha && b.commitSha);
  const reviewed = x.ok(["review", "run", "--fixture", "--skills-source", skills]);
  assert.equal(reviewed.status, "blocked");
  const report = x.ok(["report"]);
  assert.equal(report.generation.status, "blocked");
  assert.deepEqual(report.evidence.deferredIdeas.scopedOutstanding, [a.id]);
  assert.deepEqual(report.evidence.deferredIdeas.outstanding.sort(), [a.id, b.id].sort());
  assert.ok(report.generation.blockers.some((x: string) => x.includes(a.id)));
  assert.ok(!JSON.stringify(report).includes(inside.original));
  assert.ok(!JSON.stringify(report).includes(out.original));
  assert.ok(!JSON.stringify(report).includes("private notes"));

  const y = setup("outside-only");
  generate(y, "draft");
  const other = idea("other", "arc.unrelated");
  const captured = y.ok(["ideas", "capture", "--file", other.path]);
  const review = y.ok(["review", "run", "--fixture", "--skills-source", skills]);
  assert.equal(review.status, "editorial-unverified", JSON.stringify(review.audit?.diagnostics));
  const scoped = y.ok(["report"]);
  assert.equal(scoped.evidence.scope.deterministic, "passed");
  assert.deepEqual(scoped.evidence.deferredIdeas.scopedOutstanding, []);
  assert.ok(scoped.evidence.deferredIdeas.outstanding.includes(captured.id));
  assert.equal(scoped.generation.status, "paused");
});
test("completed evidence and unresolved textual integration remain independently true", {
  skip: !available,
}, () => {
  const x = setup("completed-with-conflict");
  generate(x, "draft");
  const review = x.ok(["review", "run", "--fixture", "--skills-source", skills]);
  assert.equal(review.audit.deterministic, "passed");
  // Simulate the shape of a previously completed *independent Pi* review to
  // exercise the report projector. This is NOT an actual literary certification.
  const receiptPath = join(dirname(x.job.worktreeRoot), "narrative-review.json");
  const prior = JSON.parse(readFileSync(receiptPath, "utf8"));
  prior.worker = "pi";
  prior.editorial = { verdict: "pass", evidence: [
    "event.confront#decision/protect: authored-content/disclosure-scene.md:12",
  ], findings: [] };
  writeFileSync(receiptPath, JSON.stringify(prior));
  const complete = x.ok(["report"]);
  assert.equal(complete.generation.status, "blocked", JSON.stringify({ generation: complete.generation, review: complete.evidence.scope, ideas: complete.evidence.deferredIdeas, workItems: complete.workItems }));
  assert.equal(complete.generation.planFulfillment.status, "required");
  assert.equal(complete.generation.scopeFulfillment, "complete-in-scope");
  assert.equal(complete.integration.status, "not assessed");
  // The target creates a competing record absent from its baseline, while the
  // completed generation branch has independently authored that same path.
  mkdirSync(join(x.story, "arcs"), { recursive: true });
  writeFileSync(join(x.story, "arcs/truth.md"), "---\\nid: arc.truth\\n---\\nConflicting author Arc.\\n");
  git(x.repo, "add", "."); git(x.repo, "commit", "-qm", "Competing Arc");
  const conflict = x.ok(["report", "--preview", "--fixture"]);
  assert.equal(conflict.generation.status, "blocked");
  assert.equal(conflict.integration.status, "conflicts");
  assert.equal(conflict.integration.preview.candidate.status, "text-conflicts");
  assert.equal(conflict.integration.preview.validation.status, "not-run");
  const readable = x.call(["report", "--preview", "--fixture", "--format", "markdown"]);
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /Reconciliation option:/);
  assert.match(readable.stdout, /Uncertainty:/);
  assert.match(readable.stdout, /arcs\/truth\.md/);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "status", "--porcelain"), "");
  // Later unreviewed generation commits invalidate an earlier completion.
  const storyRecord = join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md");
  writeFileSync(storyRecord, readFileSync(storyRecord, "utf8") + "\nUnreviewed change.\n");
  git(x.job.worktreeRoot, "add", ".");
  git(x.job.worktreeRoot, "commit", "-qm", "Later generation change");
  const stale = x.ok(["report"]);
  assert.equal(stale.generation.status, "blocked");
  assert.equal(stale.generation.review.current, false);
  assert.equal(stale.generation.scopeFulfillment, "unverified");
  assert.equal(stale.evidence.protection.status, "unverified");
});

test("foundation and protected revision work items retain author-approval needs", () => {
  const x = setup("approval-needed");
  const state = dirname(x.job.worktreeRoot);
  writeFileSync(join(state, "foundation.json"), JSON.stringify({
    version: 1, jobId: x.job.jobId, baseSha: x.base,
    stage: "awaiting-author", commitSha: undefined,
  }));
  mkdirSync(join(state, "revisions"), { recursive: true });
  writeFileSync(join(state, "revisions", "protected-change.json"), JSON.stringify({
    version: 1, jobId: x.job.jobId, baseSha: x.base,
    workItemId: "protected-change", target: "creative-direction/foundation.md",
    status: "proposed",
  }));
  const report = x.ok(["report"]);
  assert.equal(report.generation.status, "paused");
  assert.ok(report.workItems.some((x: { id: string; status: string }) =>
    x.id === "foundation" && x.status === "awaiting-author"));
  assert.ok(report.workItems.some((x: { id: string; status: string }) =>
    x.id === "protected-change" && x.status === "proposed"));
  assert.equal(report.evidence.authorApprovals.required, true);
  assert.ok(report.generation.blockers.some((x: string) => x.includes("protected-change")));
});
test("unfinished specialist is blocked for recovery, not falsely completed", () => {
  const x = setup("interrupted");
  writeFileSync(join(dirname(x.job.worktreeRoot), "architecture.json"), JSON.stringify({
    format: 1, jobId: x.job.jobId, baseSha: x.base, expectedHead: x.base,
    branch: x.job.branch, threadId: x.job.threadId, phase: "writing",
  }));
  const report = x.ok(["report"]);
  assert.equal(report.generation.status, "blocked");
  assert.ok(report.generation.blockers.some((x: string) => x.startsWith("Recovery:")));
});
test("cancelled execution is failed independently of integration assessment", () => {
  const x = setup("cancelled");
  x.ok(["author", "control", "--state", "cancelled"]);
  const report = x.ok(["report"]);
  assert.equal(report.generation.status, "failed");
  assert.equal(report.integration.status, "not assessed");
});
test("author pause and target drift remain separate from deferred integration", {
  skip: !available,
}, () => {
  const x = setup("drift");
  generate(x, "draft");
  x.ok(["review", "run", "--fixture", "--skills-source", skills]);
  x.ok(["author", "control", "--state", "paused"]);
  writeFileSync(join(x.story, "creative-direction/foundation.md"),
    readFileSync(join(x.story, "creative-direction/foundation.md"), "utf8") + "\nTarget revision.\n");
  git(x.repo, "add", "."); git(x.repo, "commit", "-qm", "Target drift");
  const first = x.ok(["report"]);
  assert.equal(first.generation.status, "paused");
  assert.equal(first.integration.status, "not assessed");
  const second = x.ok(["report", "--preview", "--fixture"]);
  assert.equal(second.generation.status, "paused");
  assert.notEqual(second.integration.targetHead, x.base);
  assert.equal(second.integration.preview.target.drift.length, 1);
  assert.equal(second.integration.preview.candidate.status, "constructed");
  assert.equal(second.integration.status, "not assessed",
    "A deterministic merge preview cannot attest semantic compatibility");
  assert.equal(git(x.repo, "status", "--porcelain"), "");
});
