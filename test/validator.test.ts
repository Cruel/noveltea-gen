import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { createStoryValidateTool, nativeExecutable, validateStoryJob } from "../src/validator.js";
import type { JobStartResult } from "../src/job.js";

const root = mkdtempSync(join(tmpdir(), "nt-native-validators-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const fixture = join(source, "fixtures/reference-story");
let executable: string | undefined;
try { executable = nativeExecutable(); } catch { /* The offline gate has no native artifact. */ }
const available = Boolean(executable && existsSync(executable) &&
  existsSync(join(fixture, "creative-direction/last-bell.md")));
const requiresNative = { skip: !available
  ? "Native CLI and reference Story are required (NT_NATIVE_CLI, NT_SKILLS_CHECKOUT)"
  : false };

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(name: string, withStory = true) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(repo);
  if (withStory) {
    cpSync(fixture, story, { recursive: true });
    const direction = join(story, "creative-direction/last-bell.md");
    const text = readFileSync(direction, "utf8");
    assert.match(text, /origin: agent\n    authority: delegated/);
    writeFileSync(direction, text.replace("origin: agent\n    authority: delegated",
      "origin: user\n    authority: user-protected"));
  } else mkdirSync(story);
  writeFileSync(join(repo, "README.txt"), "Author's existing repository\n");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Trusted author baseline");
  return { repo, story, baseline: git(repo, "rev-parse", "HEAD") };
}

function launch(args: string[], state: string, otherEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
    cwd: resolve("."), encoding: "utf8", timeout: 45_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: state, NT_NATIVE_CLI: executable, ...otherEnv },
  });
}
function start(story: string, state: string, job = "novel"): JobStartResult {
  const result = launch(["start", "--story", story, "--job", job], state);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as JobStartResult;
}
function validate(story: string, state: string, otherEnv: NodeJS.ProcessEnv = {}) {
  const proc = launch(["validate", "--story", story, "--job", "novel"], state, otherEnv);
  return { proc, output: proc.stdout ? JSON.parse(proc.stdout) as Record<string, any> : undefined };
}

test("new jobs persist the CLI version and preserve the trusted historical baseline", requiresNative, () => {
  const { repo, story, baseline } = repository("pin-native");
  const state = join(root, "pin-native-state");
  const job = start(story, state);
  const first = validate(story, state);
  assert.equal(first.proc.status, 0, first.proc.stderr);
  assert.equal(first.output?.status, "passed");
  assert.equal(first.output?.validator.implementation, "native-cli");
  assert.equal(first.output?.validator.version, job.validatorVersion);
  assert.match(first.output?.validator.version, /^\d+\.\d+\.\d+/);
  assert.equal(first.output?.report.protection.status, "checked");
  assert.equal(first.output?.report.protection.base, baseline);
  assert.equal(first.output?.report.protection.authorizationVerified, false);
  assert.ok(first.output?.report.records.length > 10);
  assert.equal(first.output?.report.readiness.design.stages.foundation.minimum, "passed");
  assert.equal(first.output?.baseSha, job.baseSha);

  const marker = JSON.parse(readFileSync(join(job.stateDir, "job.json"), "utf8"));
  assert.equal(marker.validatorVersion, first.output?.validator.version);
  // A fresh process can resolve a different executable with the same version.
  const reused = validate(story, state);
  assert.equal(reused.proc.status, 0, reused.proc.stderr);
  assert.equal(reused.output?.validator.version, first.output?.validator.version);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("native validator reports protected decisions, malformed records, and downstream impact", requiresNative, () => {
  const { story } = repository("native-protection");
  const state = join(root, "native-protection-state");
  const job = start(story, state);
  assert.equal(validate(story, state).proc.status, 0);
  const record = join(job.worktreeStoryRoot, "creative-direction/last-bell.md");
  const original = readFileSync(record, "utf8");

  writeFileSync(record, original.replace("repair rather than revenge", "revenge rather than repair"));
  const changed = validate(story, state);
  assert.equal(changed.proc.status, 1, changed.proc.stderr);
  assert.equal(changed.output?.status, "rejected");
  assert.equal(changed.output?.report.protection.changes[0].decision,
    "creative-direction.last-bell#repair-not-revenge");
  assert.ok(changed.output?.report.protection.impact.affected.length > 0);
  assert.equal(changed.output?.report.protection.authorizationVerified, false);

  writeFileSync(record, original.replace("central_conflict:", "unsupported_field: true\ncentral_conflict:"));
  const invalid = validate(story, state);
  assert.equal(invalid.proc.status, 1, invalid.proc.stderr);
  assert.ok(invalid.output?.report.diagnostics.some(
    (d: { code: string; path: string }) => d.code === "schema" &&
      d.path === "creative-direction/last-bell.md"));
});

test("native validation of a new Story uses an empty but verified Git baseline", requiresNative, () => {
  const { story } = repository("empty-native-story", false);
  const state = join(root, "empty-native-state");
  const job = start(story, state);
  cpSync(fixture, job.worktreeStoryRoot, { recursive: true });
  const result = validate(story, state);
  assert.equal(result.proc.status, 0, result.proc.stderr);
  assert.equal(result.output?.report.protection.status, "checked");
  assert.equal(result.output?.report.protection.checkedDecisions, 0);
  assert.deepEqual(result.output?.report.protection.changes, []);
  assert.equal(result.output?.report.protection.impact.changed.length,
    result.output?.report.records.length);
  assert.equal(result.output?.report.protection.base, job.baseSha);
});

test("missing native executable fails closed and legacy validator flags are rejected", requiresNative, () => {
  const { story } = repository("missing-executable");
  const state = join(root, "missing-executable-state");
  const job = start(story, state);
  const invalid = launch(["validate", "--story", story, "--job", "novel"],
    state, { NT_NATIVE_CLI: "/nonexistent/noveltea" });
  assert.equal(invalid.status, 2, invalid.stderr);
  const legacyFlag = launch(["validate", "--story", story, "--job", "novel",
    "--validator-source", source], state);
  assert.equal(legacyFlag.status, 2, legacyFlag.stderr);
  assert.match(legacyFlag.stderr, /--validator-source has been removed/i);
  assert.equal(existsSync(join(job.stateDir, "validator.json")), false);
});

test("missing or changed saved CLI version prevents validation", requiresNative, () => {
  const { story } = repository("version-manifest");
  const state = join(root, "version-manifest-state");
  const job = start(story, state);
  const path = join(job.stateDir, "job.json");
  const original = readFileSync(path, "utf8");
  try {
    const manifest = JSON.parse(original);
    delete manifest.validatorVersion;
    writeFileSync(path, JSON.stringify(manifest));
    const missing = validate(story, state);
    assert.equal(missing.proc.status, 2, missing.proc.stderr);
    assert.match(missing.proc.stderr, /saved job|validatorVersion|identity|version/i);
    writeFileSync(path, JSON.stringify({ ...manifest, validatorVersion: "9.9.9" }));
    const mismatch = validate(story, state);
    assert.equal(mismatch.proc.status, 2, mismatch.proc.stderr);
    assert.match(mismatch.proc.stderr, /version/i);
  } finally { writeFileSync(path, original); }
  assert.equal(validate(story, state).proc.status, 0);
});

test("resuming under a different CLI version rejects even if the executable is usable", requiresNative, () => {
  const { story } = repository("version-replaced");
  const state = join(root, "version-replaced-state");
  const job = start(story, state);
  assert.equal(validate(story, state).proc.status, 0);
  const alternate = join(root, "noveltea-alternate-version");
  writeFileSync(alternate,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '9.9.9\\n'; else exec " +
      JSON.stringify(executable!) + " \"$@\"; fi\n");
  chmodSync(alternate, 0o755);
  const mismatch = validate(story, state, { NT_NATIVE_CLI: alternate });
  assert.equal(mismatch.proc.status, 2, mismatch.proc.stderr);
  assert.match(mismatch.proc.stderr, /version.*1\.0\.0|requires NovelTea CLI version|installed version/i);
  const original = validate(story, state);
  assert.equal(original.proc.status, 0, original.proc.stderr);
  assert.equal(original.output?.validator.version, job.validatorVersion);
  assert.equal(existsSync(join(job.stateDir, "validator.json")), false);
});

test("validation does not depend on a validator receipt or pinning lock", requiresNative, () => {
  const { repo, story } = repository("no-pin");
  const state = join(root, "no-pin-state");
  const job = start(story, state);
  mkdirSync(join(job.stateDir, ".validator-pinning"));
  assert.equal(validate(story, state).proc.status, 0);
  assert.equal(existsSync(join(job.stateDir, "validator.json")), false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a parent uses the saved CLI version across processes", requiresNative, async () => {
  const { story } = repository("cross-process-pin");
  const state = join(root, "cross-process-pin-state");
  const job = start(story, state);
  const first = validate(story, state);
  assert.equal(first.proc.status, 0, first.proc.stderr);
  const old = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = state;
  try {
    const result = await validateStoryJob(job);
    assert.equal(result.status, "passed");
    assert.equal(result.validator.version, first.output?.validator.version);
  } finally {
    if (old === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = old;
  }
});

test("agent story_validate uses the same pinned native validator and never installs a shim", requiresNative, async () => {
  const { repo, story } = repository("agent-tool");
  const state = join(root, "agent-tool-state");
  const job = start(story, state);
  assert.equal(validate(story, state).proc.status, 0);
  const tool = createStoryValidateTool(job);
  const good = await tool.execute("native-agent-test", {}, undefined, undefined, {} as any);
  const report = JSON.parse(good.content.find(c => c.type === "text")?.text ?? "{}");
  assert.equal(report.status, "passed");
  assert.equal(report.validator.implementation, "native-cli");
  assert.equal(existsSync(join(dirname(job.worktreeRoot), "agent-validator-bin", "noveltea")), false);
  const direction = join(job.worktreeStoryRoot, "creative-direction/last-bell.md");
  writeFileSync(direction, readFileSync(direction, "utf8")
    .replace("repair rather than revenge", "revenge rather than repair"));
  const rejected = await tool.execute("native-agent-test", {}, undefined, undefined, {} as any);
  assert.equal(JSON.parse(rejected.content.find(c => c.type === "text")?.text ?? "{}").status, "rejected");
  assert.equal(git(repo, "status", "--porcelain"), "");
});
