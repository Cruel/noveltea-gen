import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { agentValidatorBashTool, validateStoryJob } from "../src/validator.js";
import type { JobStartResult } from "../src/job.js";

const root = mkdtempSync(join(tmpdir(), "nt-validators-"));
after(() => removeTestTree(root));
const cli = resolve("src/cli.ts");

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repository(name: string) {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "catalog@example.test");
  git(repo, "config", "user.name", "Catalog Test");
  writeFileSync(join(repo, "README.txt"), "noncanonical repository baseline\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Initial baseline");
  return repo;
}
function launch(args: string[], state: string, otherEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, "job", ...args], {
    cwd: resolve("."), encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NT_STATE_DIR: join(state, "state"),
      NT_VALIDATOR_CACHE_DIR: join(state, "validators"), ...otherEnv },
  });
}
function start(story: string, state: string, job = "novel") {
  const run = launch(["start", "--story", story, "--job", job], state);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
function validate(story: string, state: string, source?: string, job = "novel") {
  const args = ["validate", "--story", story, "--job", job];
  if (source) args.push("--validator-source", source);
  const proc = launch(args, state);
  return { proc, output: proc.stdout ? JSON.parse(proc.stdout) : null };
}
function fakeSource(name: string) {
  const source = repository(name);
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "noveltea-story-catalog" }));
  writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(source, "src/cli.ts"), `
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const content = existsSync(join(root, "story.md")) ? readFileSync(join(root, "story.md"), "utf8") : "";
const diagnostics = content.includes("INVALID") ? [{ path: "story.md", line: 2, column: 5, code: "schema", message: "invalid fixture" }] : [];
const noBaseline = process.env.TEST_NO_BASELINE === "yes";
if (noBaseline && process.argv.includes("--strict-protection")) {
  console.error("Git protection check failed: Git baseline does not contain Story Markdown files at .");
  process.exitCode = 2;
} else {
  const changes = content.includes("CHANGED") ? [{decision:"creative-direction.test#protected", acknowledged:false}] : [];
  const warnings = changes.map(change => ({code:"protected-decision-change",decision:change.decision}));
  console.log(JSON.stringify({
    records: [], diagnostics, readiness: {design:{stages:{foundation:{minimum:"passed"}}}},
    coverage:{unverified:["creative-quality"]},
    protection:{status:noBaseline?"no-baseline":"checked",base:process.env.TEST_WRONG_BASE==="yes"?"wrong":process.argv[process.argv.indexOf("--base")+1],changes,warnings,
      impact:{changed:changes.length?["creative-direction.test"]:[],moved:[],affected:[]}}
  }));
  process.exitCode = diagnostics.length || (process.argv.includes("--strict-protection") && warnings.length) ? 1 : 0;
}
`);
  git(source, "add", ".");
  git(source, "commit", "-qm", "Canonical interface fixture");
  return source;
}

test("public job validate pins one artifact, returns diagnostics and preserves existing identity", () => {
  const repo = repository("contract");
  writeFileSync(join(repo, "story.md"), "VALID");
  git(repo, "add", "story.md");
  git(repo, "commit", "-qm", "Story baseline");
  const state = join(root, "state-contract");
  const source = fakeSource("contract-source");
  const initial = start(repo, state);
  const ok = validate(repo, state, source);
  assert.equal(ok.proc.status, 0, ok.proc.stderr);
  assert.equal(ok.output.status, "passed");
  assert.equal(ok.output.exitCode, 0);
  assert.equal(ok.output.baseSha, initial.baseSha);
  assert.equal(ok.output.worktreeStoryRoot, initial.worktreeStoryRoot);
  assert.equal(ok.output.validator.contract, "noveltea-validator/v1");
  assert.match(ok.output.validator.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ok.output.report.protection.status, "checked");
  assert.equal(ok.output.report.protection.base, initial.baseSha);
  const pinFile = join(initial.worktreeRoot, "..", "validator.json");
  assert.equal(existsSync(pinFile), true);

  writeFileSync(join(initial.worktreeStoryRoot, "story.md"), "INVALID CHANGED");
  const bad = validate(repo, state);
  assert.equal(bad.proc.status, 1, bad.proc.stderr);
  assert.equal(bad.output.status, "rejected");
  assert.deepEqual(bad.output.report.diagnostics[0],
    {path:"story.md",line:2,column:5,code:"schema",message:"invalid fixture"});
  assert.equal(bad.output.report.protection.warnings.length, 1);
  assert.equal(bad.output.validator.sha256, ok.output.validator.sha256);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(repo, "rev-parse", "HEAD"), initial.baseSha);
});

test("parent accepts a pin published by a child process after loading its job identity", async () => {
  const repo = repository("subprocess-pin");
  const state = join(root, "state-subprocess-pin");
  const source = fakeSource("subprocess-pin-source");
  const job = start(repo, state) as JobStartResult;
  assert.equal(job.validatorSha256, undefined);
  const first = validate(repo, state, source);
  assert.equal(first.proc.status, 0, first.proc.stderr);
  const oldState = process.env.NT_STATE_DIR;
  const oldCache = process.env.NT_VALIDATOR_CACHE_DIR;
  process.env.NT_STATE_DIR = join(state, "state");
  process.env.NT_VALIDATOR_CACHE_DIR = join(state, "validators");
  try {
    const reused = await validateStoryJob(job, source);
    assert.equal(reused.status, "passed");
    assert.equal(reused.validator.sha256, first.output.validator.sha256);
  } finally {
    if (oldState === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = oldState;
    if (oldCache === undefined) delete process.env.NT_VALIDATOR_CACHE_DIR;
    else process.env.NT_VALIDATOR_CACHE_DIR = oldCache;
  }
});

test("saved validator works without original checkout and fails closed if its pinned bytes disappear or change", () => {
  const repo = repository("recovery");
  const source = fakeSource("recovery-source");
  const state = join(root, "state-recovery");
  const job = start(repo, state);
  assert.equal(validate(repo, state, source).proc.status, 0);
  const first = validate(repo, state);
  assert.equal(first.proc.status, 0, first.proc.stderr);
  const pin = first.output.validator;
  const binary = join(state, "validators", pin.sha256, "catalog-cli.mjs");
  assert.equal(existsSync(binary), true);

  rmSync(source, { recursive: true });
  const afterSourceDeletion = validate(repo, state);
  assert.equal(afterSourceDeletion.proc.status, 0, afterSourceDeletion.proc.stderr);
  assert.equal(afterSourceDeletion.output.validator.sha256, pin.sha256);

  chmodSync(join(state, "validators", pin.sha256), 0o755);
  chmodSync(binary, 0o644);
  writeFileSync(binary, "tampered");
  const corrupt = validate(repo, state);
  assert.equal(corrupt.proc.status, 2);
  assert.match(corrupt.proc.stderr, /missing or corrupt/i);
  assert.equal(readFileSync(binary, "utf8"), "tampered");
  rmSync(binary);
  const missing = validate(repo, state);
  assert.equal(missing.proc.status, 2);
  assert.match(missing.proc.stderr, /missing or corrupt/i);
  assert.equal(existsSync(job.worktreeRoot), true);
});

test("validation requires an existing job, and unavailable Git protection remains explicitly unverified", () => {
  const repo = repository("unverified");
  const state = join(root, "state-unverified");
  const source = fakeSource("unverified-source");
  const notStarted = validate(repo, state, source);
  assert.equal(notStarted.proc.status, 2);
  assert.match(notStarted.proc.stderr, /Run 'job start' first/);
  start(repo, state);
  const run = launch(["validate", "--story", repo, "--job", "novel", "--validator-source", source],
    state, { TEST_NO_BASELINE: "yes" });
  assert.equal(run.status, 2, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "unverified");
  assert.equal(result.report.protection.status, "no-baseline");
  assert.equal(result.exitCode, 2);
});

test("a checked protection report for a different baseline cannot pass the job boundary", () => {
  const repo = repository("wrong-base");
  const state = join(root, "state-wrong-base");
  const source = fakeSource("wrong-base-source");
  start(repo, state);
  const failed = launch(["validate", "--story", repo, "--job", "novel", "--validator-source", source],
    state, { TEST_WRONG_BASE: "yes" });
  assert.equal(failed.status, 2, failed.stderr);
  const output = JSON.parse(failed.stdout);
  assert.equal(output.status, "error");
  assert.match(output.error, /baseline different from the job/i);
});

test("concurrent or interrupted first-time pinning cannot replace an in-progress job pin", () => {
  const repo = repository("pin-lock");
  const state = join(root, "state-pin-lock");
  const source = fakeSource("pin-lock-source");
  const job = start(repo, state);
  const lock = join(job.worktreeRoot, "..", ".validator-pinning");
  mkdirSync(lock);
  const blocked = validate(repo, state, source);
  assert.equal(blocked.proc.status, 2);
  assert.match(blocked.proc.stderr, /already in progress or interrupted/);
  assert.equal(existsSync(join(job.worktreeRoot, "..", "validator.json")), false);
  rmSync(lock, { recursive: true });
  const retry = validate(repo, state, source);
  assert.equal(retry.proc.status, 0, retry.proc.stderr);
});

test("a missing pinned receipt cannot silently repin from the live checkout", () => {
  const repo = repository("missing-receipt");
  const state = join(root, "state-missing-receipt");
  const source = fakeSource("missing-receipt-source");
  const job = start(repo, state);
  const first = validate(repo, state, source);
  assert.equal(first.proc.status, 0, first.proc.stderr);
  const marker = JSON.parse(readFileSync(join(job.worktreeRoot, "..", "job.json"), "utf8"));
  assert.equal(marker.validatorSha256, first.output.validator.sha256);
  rmSync(join(job.worktreeRoot, "..", "validator.json"));
  const invalid = validate(repo, state, source);
  assert.equal(invalid.proc.status, 2);
  assert.match(invalid.proc.stderr, /Job validator pin is missing/);
  assert.equal(existsSync(join(job.worktreeRoot, "..", "validator.json")), false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("corrupted job pin and unsafe validator-cache overrides fail without modifying author files", () => {
  const repo = repository("unsafe-cache");
  const state = join(root, "state-unsafe-cache");
  const source = fakeSource("unsafe-cache-source");
  const job = start(repo, state);
  const unsafe = join(repo, ".validator-cache");
  const rejected = launch(["validate", "--story", repo, "--job", "novel", "--validator-source", source],
    state, { NT_VALIDATOR_CACHE_DIR: unsafe });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /outside both the author repository/i);
  assert.equal(existsSync(unsafe), false);
  assert.equal(git(repo, "status", "--porcelain"), "");

  const good = validate(repo, state, source);
  assert.equal(good.proc.status, 0, good.proc.stderr);
  const receipt = join(job.worktreeRoot, "..", "validator.json");
  writeFileSync(receipt, "not JSON");
  const broken = validate(repo, state);
  assert.equal(broken.proc.status, 2);
  assert.match(broken.proc.stderr, /validator pin is unreadable or corrupt/i);
  assert.equal(readFileSync(receipt, "utf8"), "not JSON");
});

test("real canonical catalog bundle validates the reference Story and rejects changed protected decisions", { skip:
  !existsSync(join(process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills"), "fixtures/reference-story/creative-direction/last-bell.md"))
  && "noveltea-skills checkout unavailable (set NT_SKILLS_CHECKOUT)" }, () => {
  const source = process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills");
  const repo = repository("reference");
  const story = join(repo, "story");
  cpSync(join(source, "fixtures/reference-story"), story, { recursive: true });
  const direction = join(story, "creative-direction/last-bell.md");
  let original = readFileSync(direction, "utf8");
  original = original.replace("origin: agent\n    authority: delegated", "origin: user\n    authority: user-protected");
  writeFileSync(direction, original);
  git(repo, "add", "story");
  git(repo, "commit", "-qm", "Canonical reference baseline");
  const state = join(root, "state-reference");
  const job = start(story, state);
  const good = validate(story, state, source);
  assert.equal(good.proc.status, 0, good.proc.stderr);
  assert.equal(good.output.report.diagnostics.length, 0);
  assert.equal(good.output.report.records.length, 36);
  assert.equal(good.output.report.readiness.design.stages.foundation.minimum, "passed");
  assert.equal(good.output.report.protection.status, "checked");
  assert.equal(good.output.report.protection.base, job.baseSha);
  assert.equal(good.output.report.protection.checkedDecisions, 1);

  const worktreeRecord = join(job.worktreeStoryRoot, "creative-direction/last-bell.md");
  writeFileSync(worktreeRecord, original.replace("repair rather than revenge", "revenge rather than repair"));
  const protectedChange = validate(story, state);
  assert.equal(protectedChange.proc.status, 1, protectedChange.proc.stderr);
  assert.equal(protectedChange.output.report.protection.changes[0].kind, "changed");
  assert.equal(protectedChange.output.report.protection.impact.changed[0], "creative-direction.last-bell");
  assert.ok(protectedChange.output.report.protection.impact.affected.length > 0);
  assert.equal(protectedChange.output.report.protection.warnings.length, 1);

  writeFileSync(worktreeRecord, original.replace("central_conflict:", "unknown_field: wrong\ncentral_conflict:"));
  const malformed = validate(story, state);
  assert.equal(malformed.proc.status, 1, malformed.proc.stderr);
  assert.ok(malformed.output.report.diagnostics.some((d: {code:string;path:string;line:number}) =>
    d.code === "schema" && d.path === "creative-direction/last-bell.md" && d.line > 0));
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("native #526/#535 cutover parity for canonical valid, structural and protected-change cases", {
  skip: !process.env.NT_NATIVE_CLI || !existsSync(join(process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills"),
    "fixtures/reference-story/creative-direction/last-bell.md"))
    ? "Native #526/#535 and canonical source checkout must be available (NT_NATIVE_CLI, NT_SKILLS_CHECKOUT)"
    : false,
}, () => {
  const source = process.env.NT_SKILLS_CHECKOUT || resolve("../noveltea-skills");
  const repo = repository("native-parity");
  const story = join(repo, "story");
  cpSync(join(source, "fixtures/reference-story"), story, { recursive: true });
  const direction = join(story, "creative-direction/last-bell.md");
  const protectedSource = readFileSync(direction, "utf8").replace(
    "origin: agent\n    authority: delegated", "origin: user\n    authority: user-protected");
  writeFileSync(direction, protectedSource);
  git(repo, "add", "story");
  git(repo, "commit", "-qm", "Native parity baseline");
  const state = join(root, "state-native-parity");
  const job = start(story, state);
  const worktreeRecord = join(job.worktreeStoryRoot, "creative-direction/last-bell.md");

  function invokeNative(...args: string[]) {
    const proc = spawnSync(process.env.NT_NATIVE_CLI!, ["--json", "narrative", ...args],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(proc.error, undefined, proc.error?.message);
    assert.ok(proc.stdout, proc.stderr);
    return { proc, json: JSON.parse(proc.stdout) as Record<string, any> };
  }
  function diagnostics(report: { diagnostics: Array<{ path: string; code: string }> }) {
    return report.diagnostics.map(d => `${d.path}:${d.code}`).sort();
  }
  function parity(label: string) {
    const experimental = validate(story, state, source);
    assert.ok(experimental.output?.report, experimental.proc.stderr);
    const older = experimental.output.report;
    const { proc, json } = invokeNative("validate", job.worktreeStoryRoot, "--base", job.baseSha);
    assert.equal(proc.status, experimental.proc.status, label + ": exit class");
    assert.equal(json.exitCode, experimental.output.exitCode, label + ": JSON exit class");
    const actual = json.catalog;
    assert.ok(actual, label + ": missing native catalog");
    assert.deepEqual(diagnostics(actual), diagnostics(older), label + ": structural diagnostics");
    assert.equal(actual.protection.status, older.protection.status, label + ": Git protection");
    assert.equal(actual.protection.base, job.baseSha, label + ": trusted baseline");
    assert.equal(actual.protection.authorizationVerified, false,
      label + ": CLI never asserts human approval");
    assert.ok(actual.coverage.unverified.length > 0 && older.coverage.unverified.length > 0,
      label + ": retain explicit uncertainty");
    const nativeDecisions = actual.protection.findings.map((f: { decisionId: string; category: string }) =>
      `${f.decisionId}:${f.category}`).sort();
    const previousDecisions = older.protection.changes.map((f: { decision: string; kind: string }) =>
      `${f.decision}:${f.kind}`).sort();
    if (!actual.diagnostics.length) {
      assert.deepEqual(nativeDecisions, previousDecisions, label + ": protected decisions");
    } else {
      // An invalid current record can be omitted by native metadata admission:
      // TypeScript calls its decision 'removed'; native calls its record 'record-deleted'.
      // Neither is a trustworthy clean protection comparison while parsing failed.
      assert.equal(actual.protection.complete, false, label + ": incomplete protection");
      assert.equal(actual.authorization.status, "indeterminate", label + ": unresolved authorization");
      assert.deepEqual(nativeDecisions.map(d => d.split(":")[0]),
        previousDecisions.map(d => d.split(":")[0]), label + ": decision identities");
    }
    assert.deepEqual([...actual.protection.impact.changed].sort(),
      [...older.protection.impact.changed].sort(), label + ": changed IDs");
    assert.deepEqual(actual.protection.impact.affected.map((a: { id: string }) => a.id).sort(),
      older.protection.impact.affected.map((a: { id: string }) => a.id).sort(),
      label + ": downstream impacted IDs");
    // The native contract separates stage readiness from structural validation;
    // both backends must agree about minimums for a structurally valid Story.
    if (!actual.diagnostics.length) {
      const ready = invokeNative("readiness", job.worktreeStoryRoot, "--stage", "architecture", "--view", "design");
      assert.equal(ready.proc.status, 0, label + ": native readiness");
      assert.equal(ready.json.readiness.design.stages.foundation.minimum,
        older.readiness.design.stages.foundation.minimum, label + ": foundation minimum");
      assert.equal(ready.json.readiness.design.stages.architecture.minimum,
        older.readiness.design.stages.architecture.minimum, label + ": architecture minimum");
      const approved = invokeNative("readiness", job.worktreeStoryRoot,
        "--stage", "architecture", "--view", "approved");
      assert.equal(approved.proc.status, 0, label + ": approved readiness command");
      assert.equal(approved.json.readiness.approved.stages.foundation.minimum,
        older.readiness.approved.stages.foundation.minimum, label + ": approved foundation minimum");
      assert.equal(approved.json.readiness.approved.stages.architecture.minimum,
        older.readiness.approved.stages.architecture.minimum, label + ": approved architecture minimum");
    }
  }
  parity("unchanged reference Story");
  writeFileSync(worktreeRecord, protectedSource.replace("repair rather than revenge", "revenge rather than repair"));
  parity("changed protected decision");
  writeFileSync(worktreeRecord, protectedSource.replace("central_conflict:",
    "unsupported_field: true\ncentral_conflict:"));
  parity("invalid structural metadata");

  // A new Story can begin with no Markdown in its trusted Git baseline. The
  // native replacement must evaluate exactly that empty baseline, not HEAD.
  const emptyRepo = repository("native-empty-story-base");
  const emptyState = join(root, "state-native-empty-story-base");
  const fresh = start(emptyRepo, emptyState);
  cpSync(join(source, "fixtures/reference-story"), fresh.worktreeStoryRoot, { recursive: true });
  const emptyBase = invokeNative("validate", fresh.worktreeStoryRoot, "--base", fresh.baseSha);
  // A valid commit predating Story files is a verified empty historical catalog.
  // First authoring is not permission to waive protection for later revisions.
  assert.equal(emptyBase.proc.status, 0);
  assert.deepEqual(emptyBase.json.diagnostics, []);
  const emptyProtection = emptyBase.json.catalog.protection;
  assert.equal(emptyProtection.status, "checked");
  assert.equal(emptyProtection.base, fresh.baseSha);
  assert.equal(emptyProtection.checkedDecisions, 0);
  assert.deepEqual(emptyProtection.findings, []);
  assert.equal(emptyProtection.authorizationVerified, false);
  assert.equal(emptyBase.json.catalog.authorization.status, "unchanged");
  assert.equal(emptyBase.json.catalog.authorization.verified, false);
  assert.deepEqual([...emptyProtection.impact.changed].sort(),
    emptyBase.json.catalog.records.map((r: { metadata: { id: string } }) => r.metadata.id).sort());
  const structuralOnly = invokeNative("validate", fresh.worktreeStoryRoot);
  assert.equal(structuralOnly.proc.status, 0);
  assert.deepEqual(structuralOnly.json.diagnostics, []);
  assert.equal(structuralOnly.json.catalog.authorization.status, "not-assessed");
  const invalidBase = invokeNative("validate", fresh.worktreeStoryRoot, "--base", "0".repeat(40));
  assert.equal(invalidBase.proc.status, 1);
  assert.ok(invalidBase.json.diagnostics.some((d: {code: string}) => d.code === "baseline-invalid"));
  assert.notEqual(invalidBase.json.catalog.protection.status, "checked");
});

test("agent-side temporary noveltea CLI validates against the pinned Git baseline", async () => {
  const repo = repository("agent-cli-shim");
  writeFileSync(join(repo, "story.md"), "VALID");
  git(repo, "add", "story.md");
  git(repo, "commit", "-qm", "Protected Story baseline");
  const state = join(root, "state-agent-shim");
  const job = start(repo, state);
  const source = fakeSource("agent-cli-source");
  const tool = await agentValidatorBashTool(job, source);
  const prefix = `NT_STATE_DIR=${JSON.stringify(join(state, "state"))} ` +
    `NT_VALIDATOR_CACHE_DIR=${JSON.stringify(join(state, "validators"))} `;
  const ctx = { cwd: job.worktreeStoryRoot, sessionManager: {
    getSessionId: () => "test-session", getSessionFile: () => null,
  }, thinkingLevel: "medium" } as any;
  const call = async (command: string) => {
    const output = await tool.execute("agent-test", { command: prefix + command }, undefined, undefined, ctx);
    return output.content.filter((c): c is { type: "text"; text: string } =>
      c.type === "text").map(c => c.text).join("\n");
  };
  const good = await call("noveltea narrative validate . --json");
  assert.equal(JSON.parse(good).validationStatus, "passed");
  assert.equal(JSON.parse(good).protection.status, "checked");
  assert.equal(JSON.parse(good).protection.base, job.baseSha);
  assert.equal(existsSync(join(job.worktreeRoot, "..", "validator.json")), true);
  assert.equal(existsSync(join(job.worktreeRoot, "..", "agent-validator-bin", "noveltea")), true);

  writeFileSync(join(job.worktreeStoryRoot, "story.md"), "INVALID CHANGED");
  const bad = await call("noveltea narrative validate . --json");
  const report = JSON.parse(bad.split("\n\nCommand exited with code")[0]!);
  assert.equal(report.validationStatus, "rejected");
  assert.equal(report.diagnostics[0].code, "schema");
  assert.equal(report.protection.warnings.length, 1);
  assert.match(bad, /Command exited with code 1/);
  const unverified = await call("TEST_NO_BASELINE=yes noveltea narrative validate . --json");
  assert.equal(JSON.parse(unverified.split("\n\nCommand exited with code")[0]!).validationStatus, "unverified");
  assert.match(unverified, /Command exited with code 2/);
  const otherBase = "a".repeat(40);
  assert.match(await call(`noveltea narrative validate . --base ${otherBase} --json`), /untrusted --base/);
  assert.match(await call("noveltea narrative validate /tmp --json"), /Story root is not the active job Story/);
  assert.match(await call("noveltea narrative --help"), /Usage: noveltea narrative validate/);
  assert.equal(git(repo, "status", "--porcelain"), "");
});
