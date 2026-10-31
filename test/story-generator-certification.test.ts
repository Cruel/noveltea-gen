import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";

const cli = resolve("src/cli.ts");
const native = process.env.NT_NATIVE_CLI;
const fixture = resolve(process.env.NT_STORY_FIXTURE_ROOT ??
  join(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills", "fixtures/reference-story"));

test("certification #31: public native Story jobs are isolated, pinned, protected and context-revision aware", {
  skip: !native ? "Requires NT_NATIVE_CLI to certify the real native CLI, never a mocked catalog" : false,
  timeout: 100_000,
}, t => {
  assert.ok(existsSync(native!), "Configured native CLI must exist, never skip an invalid configured executable");
  assert.ok(existsSync(join(fixture, "creative-direction/last-bell.md")),
    "Canonical reference Story fixture is required when native CLI certification is requested");
  const root = mkdtempSync(join(tmpdir(), "nt-generator-native-cert-"));
  t.after(() => removeTestTree(root));

  function git(cwd: string, ...args: string[]): string {
    const proc = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
    assert.equal(proc.status, 0, proc.stderr);
    return proc.stdout.trim();
  }
  function author(name: string) {
    const repo = join(root, name), story = join(repo, "story");
    mkdirSync(repo, { recursive: true });
    cpSync(fixture, story, { recursive: true });
    if (name === "one") {
      const record = join(story, "creative-direction/last-bell.md");
      const source = readFileSync(record, "utf8");
      assert.ok(source.includes("origin: agent\n    authority: delegated"));
      writeFileSync(record, source.replace("origin: agent\n    authority: delegated",
        "origin: user\n    authority: user-protected"));
    }
    writeFileSync(join(repo, "README.md"), "Author's existing project\n");
    // Engine files must remain outside Story analysis and never be modified.
    mkdirSync(join(repo, "engine"), { recursive: true });
    writeFileSync(join(repo, "engine/room.yaml"), "PRIVATE_ENGINE_RECORD: must-not-be-scanned\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Certification Author");
    git(repo, "config", "user.email", "certification@example.invalid");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Trusted author Story");
    return { repo, story, base: git(repo, "rev-parse", "HEAD") };
  }
  const first = author("one");
  const second = author("two");
  const state = join(root, "state");
  const env = {
    ...process.env, NT_STATE_DIR: state, NT_NATIVE_CLI: native!,
    NT_VALIDATOR_TEST_LEGACY: "0", NT_SKILL_CACHE_DIR: join(root, "skill-cache"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validator-cache"),
    LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true",
    TRACE_TO_LANGSMITH: "true", LANGSMITH_API_KEY: "", LANGCHAIN_API_KEY: "",
  };
  function publicJob(story: string, id: string, operation: string, expected = 0) {
    const proc = spawnSync(process.execPath,
      ["--import", "tsx", cli, "job", operation, "--story", story, "--job", id],
      { cwd: resolve("."), encoding: "utf8", env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(proc.status, expected, proc.stderr + proc.stdout.slice(0, 3000));
    return JSON.parse(proc.stdout);
  }
  function nativeContext(story: string) {
    const result = spawnSync(native!, ["narrative", "context", story, "--kind", "event",
      "--id", "event.question-ivo", "--scope", "related", "--json"],
      { cwd: resolve("."), env, encoding: "utf8", timeout: 30_000, maxBuffer: 12 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr + result.stdout.slice(0, 3000));
    return JSON.parse(result.stdout);
  }
  const a = publicJob(first.story, "one", "start");
  const b = publicJob(first.story, "two", "start");
  const c = publicJob(second.story, "one", "start");
  assert.equal(new Set([a.threadId, b.threadId, c.threadId]).size, 3);
  assert.equal(new Set([a.worktreeRoot, b.worktreeRoot, c.worktreeRoot]).size, 3);
  assert.equal(a.baseSha, first.base);
  assert.equal(c.baseSha, second.base);
  assert.equal(git(first.repo, "status", "--porcelain"), "");
  for (const [story, id, job] of [
    [first.story, "one", a], [first.story, "two", b], [second.story, "one", c],
  ] as const) {
    const report = publicJob(story, id, "validate");
    assert.equal(report.status, "passed");
    assert.equal(report.validator.implementation, "native-cli");
    assert.equal(report.validator.executable, realpathSync(native!));
    assert.match(report.validator.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.report.protection.base, job.baseSha);
    assert.equal(report.report.protection.status, "checked");
    assert.equal(report.report.protection.authorizationVerified, false);
    assert.equal(report.report.readiness.design.stages.foundation.minimum, "passed");
    assert.ok(report.report.records.length > 10);
    assert.ok(report.report.coverage.milestoneRoutes.length > 0);
    assert.ok(!JSON.stringify(report.report).includes("PRIVATE_ENGINE_RECORD"));
    const receipt = JSON.parse(readFileSync(join(dirname(job.worktreeRoot), "validator.json"), "utf8"));
    assert.equal(receipt.sha256, report.validator.sha256);
  }

  // The verified reference is the original committed author tree, not another
  // job's working tree or the mutable HEAD of this job's generation branch.
  mkdirSync(join(a.worktreeStoryRoot, ".story-inbox/ideas"), { recursive: true });
  writeFileSync(join(a.worktreeStoryRoot, ".story-inbox/ideas/private.yaml"),
    "DO_NOT_LEAK_UNPLACED_AUTHOR_IDEA\n");
  const before = nativeContext(a.worktreeStoryRoot);
  assert.equal(before.success, true);
  assert.ok(before.manifest.files.some((f: { id: string; status: string; inclusions: unknown[] }) =>
    f.id === "event.question-ivo" && f.status === "draft" && f.inclusions.length > 0));
  assert.ok(before.manifest.files.every((f: {sourceRevision: string}) => !!f.sourceRevision));
  assert.ok(!JSON.stringify(before).includes("DO_NOT_LEAK_UNPLACED_AUTHOR_IDEA"));
  const event = join(a.worktreeStoryRoot, "events/question-ivo.md");
  writeFileSync(event, readFileSync(event, "utf8") + "\nA noncanonical prose refinement.\n");
  const refreshed = nativeContext(a.worktreeStoryRoot);
  const entry = (reply: any) => reply.manifest.files.find((f: any) => f.id === "event.question-ivo");
  assert.notEqual(entry(before).sourceRevision, entry(refreshed).sourceRevision);
  assert.equal(publicJob(first.story, "one", "validate").status, "passed");

  const record = join(a.worktreeStoryRoot, "creative-direction/last-bell.md");
  const original = readFileSync(record, "utf8");
  assert.ok(original.includes("repair rather than revenge"));
  writeFileSync(record, original.replace("repair rather than revenge", "revenge rather than repair"));
  const rejected = publicJob(first.story, "one", "validate", 1);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.report.protection.base, first.base);
  assert.equal(rejected.report.protection.status, "checked");
  assert.equal(rejected.report.protection.changes[0].kind, "changed");
  assert.equal(rejected.report.protection.changes[0].decision,
    "creative-direction.last-bell#repair-not-revenge");
  assert.equal(rejected.report.protection.authorizationVerified, false);
  assert.ok(rejected.report.protection.impact.affected.length > 0);
  assert.equal(publicJob(first.story, "two", "validate").status, "passed");
  assert.equal(publicJob(second.story, "one", "validate").status, "passed");
  assert.equal(git(first.repo, "rev-parse", "HEAD"), first.base);
  assert.equal(git(first.repo, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(first.repo, "engine/room.yaml"), "utf8"),
    "PRIVATE_ENGINE_RECORD: must-not-be-scanned\n");
  assert.equal(git(b.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(c.worktreeRoot, "status", "--porcelain"), "");

  // A saved native validator cannot be replaced, fabricated or silently
  // repinned from the latest executable when its durable receipt is corrupt.
  const pinFile = join(dirname(c.worktreeRoot), "validator.json");
  const pinned = JSON.parse(readFileSync(pinFile, "utf8"));
  writeFileSync(pinFile, JSON.stringify({ ...pinned, sha256: "0".repeat(64) }));
  const tampered = spawnSync(process.execPath,
    ["--import", "tsx", cli, "job", "validate", "--story", second.story, "--job", "one"],
    { cwd: resolve("."), encoding: "utf8", env, timeout: 30_000 });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /validator pin|receipt|manifest/i);
  assert.equal(git(second.repo, "rev-parse", "HEAD"), second.base);
  assert.equal(git(second.repo, "status", "--porcelain"), "");
  assert.equal(JSON.parse(readFileSync(pinFile, "utf8")).sha256, "0".repeat(64));
});
