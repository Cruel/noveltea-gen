import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import {
  selectStoryOrchestrator,
  loadSelectedStoryOrchestrator,
  type StoryOrchestratorSource,
} from "../src/orchestrator-selection.js";

const root = mkdtempSync(join(tmpdir(), "nt-orchestrator-selection-"));
const cache = join(root, "cache");
const beforeCache = process.env.NT_SKILL_CACHE_DIR;
process.env.NT_SKILL_CACHE_DIR = cache;
after(() => {
  if (beforeCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
  else process.env.NT_SKILL_CACHE_DIR = beforeCache;
  removeTestTree(root);
});

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function source(name: string, legacy = false) {
  const checkout = join(root, name);
  for (const skill of [
    legacy ? "nt-story-generate" : "nt-story-orchestrate",
    "nt-catalog",
    "nt-story-discovery",
  ]) {
    const dir = join(checkout, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Test method\ndisable-model-invocation: true\n---\n` +
        `Pinned method ${skill} version one\n`,
    );
  }
  git(checkout, "init", "-q");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial skills");
  return checkout;
}
function job(name: string) {
  const stateDir = join(root, name, "state");
  mkdirSync(stateDir, { recursive: true });
  return { jobId: name, threadId: `thread-${name}`, baseSha: "a".repeat(40), stateDir };
}
function objective(kind: "full-story" | "partial", task: string): StoryOrchestratorSource {
  return { task, kind, turnPlanDigest: "b".repeat(64) };
}
const sha = (input: string) => createHash("sha256").update(input).digest("hex");

test("trusted controller explicitly selects pinned orchestrator for whole-Story and focused author objectives", async () => {
  const checkout = source("main-skills");
  for (const kind of ["full-story", "partial"] as const) {
    const target = job("selection-" + kind);
    const selected = await selectStoryOrchestrator(
      target,
      target.threadId + ":generation:web",
      objective(kind, kind === "full-story" ? "Make a mystery game" : "Add a conversation"),
      checkout,
    );
    assert.equal(selected.receipt.schema, "noveltea-orchestrator-selection/v1");
    assert.equal(selected.receipt.skillName, "nt-story-orchestrate");
    assert.equal(selected.receipt.role, "orchestrator");
    assert.equal(selected.receipt.reviewRole, "reviewer");
    assert.equal(selected.receipt.writeAuthority, "controller-only");
    assert.equal(selected.receipt.storySourceSha, target.baseSha);
    assert.equal(selected.receipt.graphThreadId, target.threadId + ":generation:web");
    assert.equal(selected.receipt.objectiveKind, kind);
    assert.equal(selected.receipt.skillSnapshot.id, selected.receipt.skillSnapshot.digest);
    assert.equal(selected.receipt.skillEntrypointSha256, sha(selected.procedure));
    assert.match(selected.procedure, /Pinned method nt-story-orchestrate version one/);
    const restored = await loadSelectedStoryOrchestrator(
      target,
      target.threadId + ":generation:web",
      objective(kind, kind === "full-story" ? "Make a mystery game" : "Add a conversation"),
    );
    assert.deepEqual(restored, selected);
  }
});

test("resume uses original immutable snapshot after source checkout changes", async () => {
  const checkout = source("changing-source");
  const first = job("changing-job");
  const identity = objective("full-story", "Create a mystery");
  const selected = await selectStoryOrchestrator(first, "saved-graph-thread", identity, checkout);
  writeFileSync(
    join(checkout, "skills/nt-story-orchestrate/SKILL.md"),
    "---\nname: nt-story-orchestrate\ndescription: Updated method\n---\nChanged live methodology\n",
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Update orchestrator");
  const resumed = await selectStoryOrchestrator(first, "saved-graph-thread", identity, checkout);
  assert.deepEqual(resumed, selected);
  const second = await selectStoryOrchestrator(job("next-job"), "new-graph-thread", identity, checkout);
  assert.notEqual(second.receipt.skillSnapshot.id, selected.receipt.skillSnapshot.id);
  assert.match(second.procedure, /Changed live methodology/);
});

test("missing renamed method is incompatible; never fall back to legacy generator", async () => {
  const checkout = source("old-method-source", true);
  const target = job("incompatible");
  await assert.rejects(
    selectStoryOrchestrator(target, "thread", objective("full-story", "Make a Story"), checkout),
    /nt-story-orchestrate|incompatible/i,
  );
  assert.equal(existsSync(join(target.stateDir, "orchestrator-selection.json")), false);
});

test("mismatched identity or forged grant fails closed before method can be loaded", async () => {
  const checkout = source("forgery-source");
  const target = job("forgery-job");
  const identity = objective("partial", "Add dialogue");
  await selectStoryOrchestrator(target, "thread", identity, checkout);
  await assert.rejects(loadSelectedStoryOrchestrator(target, "other-thread", identity), /thread|identity/i);
  await assert.rejects(
    loadSelectedStoryOrchestrator(target, "thread", objective("partial", "Rewrite all canon")),
    /objective|identity/i,
  );
  await assert.rejects(
    loadSelectedStoryOrchestrator({ ...target, baseSha: "c".repeat(40) }, "thread", identity),
    /source|identity/i,
  );
  const file = join(target.stateDir, "orchestrator-selection.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.role = "specialist";
  writeFileSync(file, JSON.stringify(receipt));
  await assert.rejects(
    loadSelectedStoryOrchestrator(target, "thread", identity),
    /role|identity|incompatible/i,
  );
});

test("a missing or changed pinned cache blocks resume instead of switching to live skills", async () => {
  const checkout = source("tamper-source");
  const target = job("tamper-job");
  const identity = objective("partial", "Continue scene");
  const selected = await selectStoryOrchestrator(target, "thread", identity, checkout);
  const file = join(selected.receipt.skillSnapshot.path, "skills/nt-story-orchestrate/SKILL.md");
  chmodSync(file, 0o644);
  writeFileSync(file, "Injected changed skill");
  await assert.rejects(
    loadSelectedStoryOrchestrator(target, "thread", identity),
    /snapshot|corrupt|modified/i,
  );
});
