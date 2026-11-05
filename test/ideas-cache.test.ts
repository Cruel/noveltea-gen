import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { records } from "../src/ideas.js";
import { startStoryJob } from "../src/job.js";
import { nativeExecutable } from "../src/native-cli-version.js";
import { removeTestTree } from "./helpers.js";

let available = false;
try { available = existsSync(nativeExecutable()); } catch { /* CI without native CLI. */ }

test("committed Story catalog cache reuses immutable HEAD and invalidates on a new commit", {
  skip: !available && "Requires native NovelTea CLI for job initialization",
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-committed-catalog-"));
  t.after(() => removeTestTree(root));
  const previous = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = join(root, "state");
  try {
    const repo = join(root, "repository");
    const story = join(repo, "story");
    const record = join(story, "creative-direction", "direction.md");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    const original = [
      "---", "schema: '0.1'", "type: creative-direction", "id: creative-direction.direction",
      "title: Direction", "status: draft", "arcs: [arc.one]", "events: [event.one]",
      "---", "", "First direction.", "",
    ].join("\n");
    writeFileSync(record, original);
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Catalog test");
    git(repo, "config", "user.email", "catalog@example.test");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Initial Story");

    const job = await startStoryJob({ story, job: "catalog-cache" });
    const first = records(job);
    assert.equal(first.size, 1);
    assert.deepEqual(first.get("creative-direction.direction")?.arcs, ["arc.one"]);
    first.get("creative-direction.direction")!.arcs.push("arc.from-caller");
    first.clear();

    const cached = records(job);
    assert.equal(cached.size, 1);
    assert.deepEqual(cached.get("creative-direction.direction")?.arcs, ["arc.one"],
      "callers cannot mutate cached records");
    assert.notEqual(cached, first);

    const workRecord = join(job.worktreeStoryRoot, "creative-direction", "direction.md");
    writeFileSync(workRecord, readFileSync(workRecord, "utf8").replace("status: draft", "status: superseded"));
    git(job.worktreeRoot, "add", "--", "story/creative-direction/direction.md");
    git(job.worktreeRoot, "commit", "-qm", "Supersede direction");

    assert.equal(records(job).size, 0, "moving HEAD must invalidate the committed catalog");
    assert.equal(records(job).size, 0);
    assert.equal(git(repo, "status", "--porcelain"), "", "source checkout remains untouched");
  } finally {
    if (previous === undefined) delete process.env.NT_STATE_DIR;
    else process.env.NT_STATE_DIR = previous;
  }
});
