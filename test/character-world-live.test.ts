import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";

test("opt-in two real Pi specialists author and certify Character/World foundations", {
  skip: process.env.NT_LIVE_FOUNDATIONS !== "1" ? "set NT_LIVE_FOUNDATIONS=1 for live Pi certification" : false,
  timeout: 720_000,
}, () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-character-development/SKILL.md")));
  assert.ok(existsSync(join(source, "skills/nt-worldbuilding/SKILL.md")));
  const temp = mkdtempSync(join(tmpdir(), "nt-foundations-live-"));
  function git(cwd: string, ...args: string[]) {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  }
  const sourceStatus = git(source, "status", "--porcelain");
  let completed = false;
  try {
    const repo = join(temp, "author");
    const story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player must have a meaningful choice to protect or challenge a friend"
    origin: user
    authority: user-protected
premise: "An archivist investigates a vanished witness"
central_conflict: "Expose concealed evidence or preserve a friendship"
genre: "Mystery"
tone: "Tense and intimate"
player_experience: "Dialogue-led investigative decisions"
scope: "Small cast, one reusable archive location"
---

A ledger implicates a trusted member of the community, threatening a close friendship.
`);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Creative Direction");
    const baseline = git(repo, "rev-parse", "HEAD");
    const env = { ...process.env, NT_STATE_DIR: join(temp, "state"),
      NT_SKILL_CACHE_DIR: join(temp, "skills"),
      NT_CONFIG_FILE: join(temp, "missing-config.json") };
    function cli(...args: string[]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
        "--story", story, "--job", "live"], {
        cwd: resolve("."), encoding: "utf8", timeout: 640_000, maxBuffer: 32 * 1024 * 1024, env,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout);
    }
    const job = cli("start");
    const contract = join(temp, "contract.json");
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "partial", depth: "architecture",
        targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-path", "confrontation-path"] },
      constraints: ["Preserve the author's explicit loyalty choice"],
      envelope: { presentation: "Dialogue-led visual novel",
        hardLimits: ["One reused archive setting"], preferences: ["Two major Characters"] },
    }));
    const arch = cli("architecture", "run", "--fixture", "--contract", contract, "--skills-source", source);
    assert.equal(arch.status, "architecture-committed");
    const args = ["foundations", "run", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const generated = cli(...args);
    assert.equal(generated.status, "foundations-committed");
    assert.equal(generated.items.length, 2);
    assert.ok(generated.items.every((item: any) => item.skillReads.length === 6));
    for (const unit of generated.items) {
      const messages = readFileSync(unit.piSessionFile, "utf8").trim().split("\n").map(JSON.parse);
      const calls = messages.flatMap((m: any) => m.message?.content ?? []).filter((c: any) => c.type === "toolCall");
      const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
      assert.ok(unit.skillReads.every((p: string) => reads.includes(p)), "Pi must read its pinned skill sources");
      assert.ok(calls.some((c: any) => c.name === "write" || c.name === "edit"), "Pi must author directly");
      assert.ok(unit.paths.length > 0);
      assert.match(unit.commitSha, /^[a-f0-9]{40}$/);
      assert.equal(unit.validation.status, "passed");
    }
    const validated = cli("validate");
    assert.equal(validated.status, "passed");
    const records = validated.report.records;
    assert.ok(records.filter((r: any) => r.metadata.type === "character").length >= 2);
    assert.ok(records.some((r: any) => r.metadata.type === "relationship"));
    assert.ok(records.some((r: any) => r.metadata.type === "fact"));
    assert.ok(records.some((r: any) => r.metadata.type === "world-entity"));
    assert.equal(records.filter((r: any) => r.metadata.type === "event").length, 0);
    assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    completed = true;
  } finally {
    assert.equal(git(source, "status", "--porcelain"), sourceStatus);
    if (!completed && process.env.NT_KEEP_FAILED_LIVE === "1") {
      process.stderr.write("Preserved failed live Story job for inspection: " + temp + "\n");
    } else {
      removeTestTree(temp);
    }
  }
});
