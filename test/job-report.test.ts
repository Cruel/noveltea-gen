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
