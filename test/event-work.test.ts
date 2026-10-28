import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { hostname as requireHostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "nt-event-work-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player may protect the friend or seek accountability"
    origin: user
    authority: user-protected
premise: "A vanished witness unsettles a small archive"
central_conflict: "Expose evidence or preserve loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Investigative dialogue choices"
scope: "Two key Characters and one reusable location"
---

A missing witness leaves a ledger and suspicion between two former collaborators.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author's creative direction");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_SKILL_CACHE_DIR: join(root, "skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validators"),
    NT_CONFIG_FILE: join(root, "absent-config.json") };
  function cli(args: string[], variant?: string) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
      env: { ...env, NT_EVENT_FIXTURE_CASE: variant ?? "" },
    });
  }
  const initialized = cli(["start"]); assert.equal(initialized.status, 0, initialized.stderr);
  const job = JSON.parse(initialized.stdout);
  const contractFile = join(root, name + "-contract.json");
  writeFileSync(contractFile, JSON.stringify({ scope: {
    kind: "partial", depth: "interactive",
    targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route", "confrontation-route"],
  }, constraints: ["Preserve loyalty and ensure disclosure can come through choice"],
  envelope: { presentation: "Dialogue-driven visual novel", hardLimits: ["Reuse archive background"],
    preferences: ["Two central Characters"] } }));
  function prepare() {
    const arch = cli(["architecture", "run", "--fixture", "--contract", contractFile, "--skills-source", source]);
    assert.equal(arch.status, 0, arch.stderr);
    const foundations = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.equal(foundations.status, 0, foundations.stderr);
    const head = JSON.parse(foundations.stdout).headSha;
    return head as string;
  }
  function event(variant?: string, milestone = "milestone.disclosure") {
    return cli(["event", "run", "--fixture", "--milestone", milestone, "--skills-source", source], variant);
  }
  return { repo, story, job, baseline, cli, prepare, event };
}

test("public CLI commits a reachable causal Event cluster with validated Milestone fulfillment", { skip: !available }, () => {
  const { repo, job, baseline, cli, prepare, event } = setup("fulfilled");
  const before = prepare();
  const run = event();
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.deepEqual(data.validation.eventIds, ["event.disclose-ledger"]);
  assert.deepEqual(data.validation.routes.map((route: any) => route.status), ["reachable"]);
  assert.equal(data.validation.eventProgress[0].status, "reachable");
  assert.equal(data.validation.protectionBase, before);
  assert.match(data.validation.validatorSha256, /^[a-f0-9]{64}$/);
  assert.ok(data.outstanding.every((o: any) => o.id !== "milestone.disclosure" || o.field !== "fulfillment.any_of"));
  assert.equal(data.completionEvidence.unrelatedComposition, "not-required");
  const eventMarkdown = readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(eventMarkdown, /value: knows/);
  assert.match(eventMarkdown, /kind: relationship/);
  assert.match(eventMarkdown, /prerequisites:\n  any_of:/);
  const milestoneMarkdown = readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");
  assert.match(milestoneMarkdown, /fulfillment: \{any_of: \[\[event.disclose-ledger\]\]\}/);
  const validated = cli(["validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.report.coverage.milestoneRoutes.find((x: any) => x.id === "milestone.disclosure").routes[0].status, "reachable");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), before);
  assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: event-disclosure/);
  const inspected = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).headSha, data.headSha);
  const replay = event();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, data.headSha);
});

test("Event obeys shared job lock and execution pause before writing", { skip: !available }, () => {
  const x = setup("shared-lock-and-pause");
  x.prepare();
  const lock = join(x.job.worktreeRoot, "../.story-job-running");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    version: 1, jobId: "draft", pid: process.pid, host: requireHostname(),
    nonce: "12345678-1234-1234-1234-123456789abc", workItem: "another-writer",
  }));
  const blocked = x.event();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already owned/);
  rmSync(lock, { recursive: true });
  const paused = x.cli(["author", "control", "--state", "paused"]);
  assert.equal(paused.status, 0, paused.stderr);
  const denied = x.event();
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /cannot advance|paused/);
  assert.equal(existsSync(join(x.job.worktreeRoot, "events/disclose-ledger.md")), false);
});

test("optional after chronology does not imply a completed prerequisite", { skip: !available }, () => {
  const { job, cli, prepare, event } = setup("optional");
  prepare();
  const run = event("optional");
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.deepEqual(data.validation.eventIds, ["event.disclose-ledger", "event.inspect-ledger"]);
  assert.ok(data.validation.eventProgress.every((p: any) => p.status === "reachable"));
  const doc = readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(doc, /after: \[event.inspect-ledger\]/);
  assert.match(doc, /completed: \[\]/);
  const progress = JSON.parse(cli(["validate"]).stdout).report.coverage;
  assert.equal(progress.milestoneRoutes.find((x: any) => x.id === "milestone.disclosure").routes[0].status, "reachable");
});

test("related Revelation may be authored and revealed by a typed Event effect", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("revelation");
  prepare();
  const result = event("revelation");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(cli(["validate"]).stdout).report;
  assert.ok(report.records.some((r: any) => r.metadata.id === "revelation.ledger-shared"));
  assert.ok(readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8")
    .includes("revelation: revelation.ledger-shared"));
});

test("unrelated cross-domain records and Milestone prose retcons are rejected", { skip: !available }, () => {
  const unrelated = setup("unconnected");
  const baseline = unrelated.prepare();
  const failed = unrelated.event("unconnected");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unconnected cross-domain record/);
  assert.equal(git(unrelated.job.worktreeRoot, "rev-parse", "HEAD"), baseline);
  const retcon = setup("milestone-retcon");
  const before = retcon.prepare();
  const rejected = retcon.event("milestone-retcon");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unrelated Milestone metadata\/body/);
  assert.equal(git(retcon.job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("requires previous foundations and an authorized selected Milestone", { skip: !available }, () => {
  const { cli, prepare, event } = setup("authorization");
  const noFoundation = event();
  assert.notEqual(noFoundation.status, 0);
  assert.match(noFoundation.stderr, /requires committed architecture|foundations/i);
  prepare();
  const outOfScope = event(undefined, "milestone.unapproved");
  assert.notEqual(outOfScope.status, 0);
  assert.match(outOfScope.stderr, /not authorized/);
  const malformed = event(undefined, "truth");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /typed milestone/);
  const noMilestone = cli(["event", "run", "--fixture"]);
  assert.notEqual(noMilestone.status, 0);
  assert.match(noMilestone.stderr, /--milestone/);
});

test("impossible contradictory prerequisites are rejected and do not produce an Event commit", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("contradictory");
  const before = prepare();
  const invalid = event("contradiction");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Canonical Event validation|impossible|contradictory/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.notEqual(git(job.worktreeRoot, "status", "--porcelain"), "");
  const inspection = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspection.status, 0);
  assert.equal(JSON.parse(inspection.stdout).phase, "authored");
  const retry = event("contradiction");
  assert.notEqual(retry.status, 0);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("localized canonical feedback repairs a contradictory Event before commit", { skip: !available }, () => {
  const { job, prepare, event } = setup("repaired");
  const original = prepare();
  const result = event("repair");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.equal(data.validation.protectionBase, original);
  assert.ok(data.validation.routes.some((r: any) => r.status === "reachable"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), original);
});

test("exhausted localized repair preserves contradictory draft without marking completion", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("failed-repair");
  const before = prepare();
  const result = event("failed-repair");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exhausted bounded repair attempts/);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
  const inspected = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspected.status, 0);
  const data = JSON.parse(inspected.stdout);
  assert.equal(data.status, "writing");
  assert.match(data.failure, /exhausted bounded repair/);
  assert.equal(data.validation, undefined);
  assert.equal(data.completionEvidence.eventReachability, false);
  assert.ok(existsSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md")));
});

test("rejects unauthorized Creative Direction edits and mismatched manifests without committing", { skip: !available }, () => {
  const x = setup("out-of-scope");
  const before = x.prepare();
  const rejected = x.event("unauthorized");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unauthorized Event specialist path/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), before);
  const y = setup("manifest");
  const old = y.prepare();
  const mismatch = y.event("mismatch");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /modifiedRecords differ/);
  assert.equal(git(y.job.worktreeRoot, "rev-parse", "HEAD"), old);
});
