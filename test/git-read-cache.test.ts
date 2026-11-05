import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "../src/git-read-cache.js";
import { removeTestTree } from "./helpers.js";

test("immutable Git lookups reuse bytes while moving HEAD and dirty checks remain live", {
  skip: process.platform === "win32" ? "POSIX executable shim required" : false,
}, t => {
  const root = mkdtempSync(join(tmpdir(), "nt-git-read-cache-"));
  t.after(() => removeTestTree(root));
  const repo = join(root, "repo");
  const shimDir = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(shimDir);
  const originalPath = process.env.PATH;
  const originalGit = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8", env: { ...process.env, PATH: originalPath },
  });
  assert.equal(originalGit.status, 0);
  const realGit = originalGit.stdout.trim();
  const raw = (...args: string[]) => {
    const result = spawnSync(realGit, args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  raw("init", "-q");
  raw("config", "user.name", "Cache test");
  raw("config", "user.email", "cache@example.invalid");
  writeFileSync(join(repo, "story.md"), "one\n");
  raw("add", "story.md");
  raw("commit", "-qm", "First commit");
  const first = raw("rev-parse", "HEAD");
  const calls = join(root, "git-calls");
  const script = join(shimDir, "git");
  writeFileSync(script, "#!/bin/sh\nprintf 'call\\n' >> " + JSON.stringify(calls) +
    "\nexec " + JSON.stringify(realGit) + " \"$@\"\n");
  chmodSync(script, 0o755);
  process.env.PATH = shimDir + delimiter + originalPath;
  const cached = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const count = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0;
  try {
    assert.match(cached("log", "-1", "--format=%B", first), /First commit/);
    assert.match(cached("log", "-1", "--format=%B", first), /First commit/);
    assert.equal(count(), 1, "identical committed metadata is read from cache");
    cached("merge-base", "--is-ancestor", first, first);
    cached("merge-base", "--is-ancestor", first, first);
    assert.equal(count(), 2, "immutable SHA ancestry can be cached");
    assert.equal(cached("show", first + ":story.md"), "one");
    assert.equal(cached("show", first + ":story.md"), "one");
    assert.equal(count(), 3, "committed blob reads are cached");

    assert.equal(cached("rev-parse", "HEAD"), first);
    assert.equal(cached("rev-parse", "HEAD"), first);
    assert.equal(count(), 3, "ordinary loose HEAD refs are read fresh without spawning Git");
    assert.equal(cached("show", "HEAD:story.md"), "one");
    writeFileSync(join(repo, "story.md"), "two\n");
    assert.equal(cached("status", "--porcelain"), "M story.md");
    raw("add", "story.md");
    raw("commit", "-qm", "Second commit");
    const second = raw("rev-parse", "HEAD");
    assert.notEqual(second, first);
    assert.equal(cached("rev-parse", "HEAD"), second);
    assert.equal(cached("show", "HEAD:story.md"), "two");
    assert.equal(cached("show", first + ":story.md"), "one");
    assert.equal(cached("status", "--porcelain"), "", "dirty-state checks are not cached");
    raw("switch", "-qc", "second-branch");
    assert.equal(cached("symbolic-ref", "--short", "HEAD"), "second-branch",
      "branch changes are observed without reusing the previous ref");
    raw("pack-refs", "--all", "--prune");
    const beforePacked = count();
    assert.equal(cached("rev-parse", "HEAD"), second);
    assert.equal(count(), beforePacked + 1,
      "packed refs must fall back to Git instead of relying on a stale loose ref");

    const cloned = join(root, "clone");
    const clone = spawnSync(realGit, ["clone", "-q", repo, cloned], { encoding: "utf8" });
    assert.equal(clone.status, 0, clone.stderr);
    const beforeClone = count();
    assert.match(execFileSync("git", ["log", "-1", "--format=%B", first],
      { cwd: cloned, encoding: "utf8" }), /First commit/);
    assert.equal(count(), beforeClone + 1,
      "the same SHA in a different repository must not inherit cached evidence");

    const absent = "f".repeat(40) + ":story.md";
    const beforeMissing = count();
    assert.throws(() => cached("show", absent));
    assert.throws(() => cached("show", absent));
    assert.equal(count(), beforeMissing + 2, "missing object failures must not be cached");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
