import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifiedNarrativeChain } from "../src/job-successor.js";
import { startStoryJob } from "../src/job.js";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";

const root = mkdtempSync(join(tmpdir(), "nt-idea-placement-"));
after(() => {
  if (process.env.NT_LIVE_IDEA_PLACEMENT === "1" && process.env.NT_KEEP_FAILED_LIVE === "1") {
    process.stderr.write("Preserved live idea-placement fixtures: " + root + "\n");
  } else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story"), state = join(root, name + "-state");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A disputed archive ledger"
status: draft
decisions:
  - id: agency
    statement: "The player may choose whether to protect or challenge Neri"
    origin: user
    authority: user-protected
premise: "A witness disappears before an archive inquiry"
central_conflict: "Expose the ledger or preserve loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Investigation"
scope: "Two Characters and a single archive"
---

Ada wants to resolve the witness's disappearance without unjustly condemning Neri.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Original Story");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: state, NT_CONFIG_FILE: join(root, "missing.json"),
    NT_SKILL_CACHE_DIR: join(root, name + "-skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, name + "-validators") };
  function call(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "job", ...args, "--story", story, "--job", name], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 24 * 1024 * 1024, env,
      });
  }
  function ok(...args: string[]) {
    const result = call(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const job = ok("start");
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({
    scope: { kind: "partial", depth: "composition",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
    constraints: ["Neri's protected/challenged outcomes must remain distinct"],
    envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
  }));
  for (const stage of [
    ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source],
    ["foundations", "run", "--fixture", "--skills-source", source],
    ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ["composition", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
  ]) ok(...stage);
  const payload = join(root, name + "-idea.json");
  const live = name.startsWith("live-");
  writeFileSync(payload, JSON.stringify({
    id: "bell-concept", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "notes:page-7" },
    original: live
      ? "Neri adds that hiding the ledger betrayed Ada's trust. Ada asks Neri to account for when the missing witness last had access to it."
      : "A bell's echo proves that the archive was opened that night.",
    requirements: {
      meaning: [{ text: live
        ? "Neri's admission harms Ada's trust and directs her inquiry toward the missing witness's access to the ledger"
        : "The bell's echo changes the witness investigation", binding: true }],
      wording: [], participants: [{ text: "character.ada", binding: true }],
    },
    identities: { known: ["character.ada"], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const captured = ok("ideas", "capture", "--file", payload);
  return { repo, story, state, job, baseline, captured, call, ok, env };
}
test("multiple placements, verified inbox provenance and deferred fulfillment via public Story job CLI", {
  skip: !available,
  timeout: 120_000,
}, async () => {
  const x = setup("placement");
  const plan = x.ok("ideas", "plan");
  assert.equal(plan.audience, "scheduler-only");
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.eligible, true);
  assert.ok(task.candidates.length >= 2);
  assert.ok(task.candidates.some((c: any) => c.id === "event.disclose-ledger"));
  assert.ok(!JSON.stringify(plan).includes("bell's echo"));
  x.ok("author", "control", "--state", "paused");
  const duringPause = x.call("ideas", "place", "--fixture", "--id", "bell-concept",
    "--target", "event.disclose-ledger");
  assert.notEqual(duringPause.status, 0);
  assert.match(duringPause.stderr, /cannot advance|paused/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), x.captured.commitSha);
  x.ok("author", "control", "--state", "running");
  const wrong = x.call("ideas", "place", "--fixture", "--id", "bell-concept",
    "--target", "authored-content.disclosure-scene");
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /eligible candidate|Choose one/i);
  const placed = x.ok("ideas", "place", "--fixture", "--id", "bell-concept",
    "--target", "event.disclose-ledger", "--skills-source", source);
  assert.equal(placed.status, "integrated-editorial-unverified");
  assert.ok(placed.alternatives.length >= 2);
  assert.equal(placed.realizationIds[0], "event.disclose-ledger");
  const content = readFileSync(join(x.job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.ok(content.includes("A bell's echo proves"));
  const idea = x.ok("ideas", "inspect").ideas[0];
  assert.equal(idea.original, "A bell's echo proves that the archive was opened that night.");
  assert.equal(idea.lifecycle.status, "integrated");
  assert.equal(x.ok("ideas", "eligibility").ideas.find((v: any) => v.id === "bell-concept").status,
    "integrated");
  assert.equal(idea.lifecycle.placements.length, 1);
  assert.equal(idea.lifecycle.placements[0].verified, "fixture-unverified");
  assert.equal(x.ok("ideas", "reverse").records.find((r: any) =>
    r.id === "event.disclose-ledger").ideaIds[0], "bell-concept");
  assert.deepEqual(x.ok("ideas", "audit").outstanding, ["bell-concept"]);
  assert.equal(x.ok("ideas", "reassess", "--id", "bell-concept").status,
    "relocation-review-required");
  const alternative = task.candidates.find((c: any) => c.id !== "event.disclose-ledger").id;
  const request = x.ok("ideas", "relocate", "--id", "bell-concept", "--target", alternative);
  assert.equal(request.status, "approval-required");
  const payload = { ...request.approvalRequest, reason: "The later Event now offers a stronger causal context." };
  const signedFile = authorApproval(x.story, x.job.jobId, x.env, root, payload).file;
  const rejected = x.call("ideas", "relocate", "--fixture", "--id", "bell-concept",
    "--target", alternative, "--approval", join(root, "nonexistent.json"));
  assert.notEqual(rejected.status, 0);
  const relocated = x.ok("ideas", "relocate", "--fixture", "--id", "bell-concept",
    "--target", alternative, "--approval", signedFile, "--skills-source", source);
  assert.equal(relocated.action, "relocated");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"), placed.commitSha);
  assert.equal(x.ok("ideas", "inspect").ideas[0].lifecycle.placements.length, 2);
  assert.equal(x.ok("ideas", "reverse").records.find((r: any) =>
    r.id === alternative).ideaIds[0], "bell-concept");
  assert.ok(!readFileSync(join(x.job.worktreeStoryRoot, "events/disclose-ledger.md"),
    "utf8").includes("A bell's echo proves"));
  assert.deepEqual(x.ok("ideas", "audit").outstanding, ["bell-concept"]);
  const reassessed = x.ok("ideas", "reassess", "--fixture", "--record", "--id", "bell-concept");
  assert.equal(reassessed.status, "reassessed-editorial-unverified");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"), relocated.commitSha);
  assert.equal(x.ok("ideas", "inspect").ideas[0].lifecycle.placements.length, 3);
  const finalReview = x.ok("review", "run", "--fixture", "--skills-source", source);
  assert.equal(finalReview.status, "blocked");
  assert.ok(finalReview.audit.outstanding.some((o: any) => o.id === "bell-concept"),
    "Fixture placement/reassessment must not satisfy a binding in-scope idea");
  assert.equal(finalReview.ideaAudit.reviewed.find((a: any) => a.id === "bell-concept").verdict,
    "editorial-unverified", "Final review must independently audit ALL integrated idea histories");
  const denied = x.call("ideas", "place", "--fixture", "--id", "bell-concept",
    "--target", alternative);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Already integrated/);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.baseline);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^^^"), x.captured.commitSha);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"),
    /NovelTea-Work-Item: idea-placement/);
  const earlier = process.env.NT_STATE_DIR;
  try {
    process.env.NT_STATE_DIR = x.state;
    const reopened = await startStoryJob({ story: x.story, job: "placement" }, false);
    assert.equal(await verifiedNarrativeChain(reopened, x.captured.commitSha,
      reassessed.commitSha), reassessed.commitSha,
    "Interleaved idea-placement successors must have exact committed provenance");
  } finally {
    if (earlier === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = earlier;
  }
  const receiptPath = join(dirname(x.job.worktreeRoot),
    "idea-placements/bell-concept-2.json");
  const valid = readFileSync(receiptPath, "utf8");
  const corrupted = JSON.parse(valid);
  corrupted.digest = "f".repeat(64);
  writeFileSync(receiptPath, JSON.stringify(corrupted));
  const tampered = x.call("ideas", "inspect");
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /placement.*(receipt|commit)|provenance/i);
  writeFileSync(receiptPath, valid);
  assert.equal(x.ok("ideas", "inspect").ideas[0].lifecycle.placements.length, 3);
});

test("literal protected author dialogue cannot be superficially realized or committed", {
  skip: !available, timeout: 120_000,
}, () => {
  const x = setup("literal-dialogue");
  const file = join(root, "literal-unfulfilled.json");
  writeFileSync(file, JSON.stringify({
    id: "literal-unfulfilled", kind: "narrative-anchor",
    source: { kind: "author-continuation", reference: "writer's notebook" },
    original: 'Neri says: "The ledger is missing."',
    requirements: { meaning: [{ text: "The dialogue exposes the missing ledger", binding: true }],
      wording: [{ text: "I saw who took it.", binding: true }],
      participants: [{ text: "character.neri", binding: true }] },
    identities: { known: ["character.neri"], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const saved = x.ok("ideas", "capture", "--file", file);
  const possible = x.ok("ideas", "plan").tasks.find((t: any) => t.id === saved.id);
  assert.ok(possible.eligible && possible.candidates.some((c: any) =>
    c.id === "event.disclose-ledger"));
  const failed = x.call("ideas", "place", "--fixture", "--id", saved.id,
    "--target", "event.disclose-ledger", "--skills-source", source);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /omitted binding literal author dialogue/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), saved.commitSha);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.baseline);
  assert.ok(git(x.job.worktreeRoot, "status", "--porcelain").includes("events/disclose-ledger.md"),
    "Preserve the failed candidate for explicit manual reconciliation");
});

test("live pinned Pi craft integration and independent semantic fulfillment review", {
  skip: process.env.NT_LIVE_IDEA_PLACEMENT !== "1" ? "set NT_LIVE_IDEA_PLACEMENT=1" : false,
  timeout: 1_200_000,
}, () => {
  const x = setup("live-placement");
  const planned = x.ok("ideas", "plan");
  assert.ok(planned.tasks[0].candidates.length > 1);
  const outcome = x.ok("ideas", "place", "--id", "bell-concept",
    "--target", "event.disclose-ledger", "--skills-source", source,
    "--provider", process.env.NT_PROVIDER ?? "openai",
    "--model", process.env.NT_MODEL ?? "gpt-6-luna",
    "--thinking", process.env.NT_THINKING ?? "low");
  assert.equal(outcome.status, "integrated");
  assert.equal(outcome.verification, "pi");
  assert.ok(readFileSync(join(x.job.worktreeStoryRoot, "events/disclose-ledger.md"),
    "utf8").length > 100);
  const placed = x.ok("ideas", "inspect").ideas[0];
  assert.equal(placed.lifecycle.placements[0].verified, "pi");
  assert.ok(placed.lifecycle.placements[0].evidence.length >= 2);
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.baseline);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  process.stdout.write("LIVE_IDEA_PLACEMENT " + JSON.stringify({
    commitSha: outcome.commitSha, evidence: placed.lifecycle.placements[0].evidence,
  }) + "\n");
});
