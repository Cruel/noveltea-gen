import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";

test("opt-in real pinned nt-event-design authors a causal, verified Milestone cluster", {
  skip: process.env.NT_LIVE_EVENT !== "1" ? "set NT_LIVE_EVENT=1 for live Pi certification" : false,
  timeout: 720_000,
}, () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-event-design/SKILL.md")));
  const temp = mkdtempSync(join(tmpdir(), "nt-event-live-"));
  const git = (dir: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const skillSourceStatus = git(source, "status", "--porcelain");
  let completed = false;
  try {
    const repo = join(temp, "author");
    const story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The vanished witness"
status: draft
decisions:
  - id: player-choice
    statement: "The player must be able to protect or challenge a trusted friend"
    origin: user
    authority: user-protected
premise: "A witness vanishes, leaving evidence at a small archive"
central_conflict: "Expose a concealment or protect a friend"
genre: "Mystery"
tone: "Intimate and tense"
player_experience: "Consequential investigative conversations"
scope: "Two Characters, one reusable archive setting"
---

Ada and Neri disagree about whether a concealed ledger should be revealed. The player controls the degree of confrontation.
`);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Original Creative Direction");
    const baseline = git(repo, "rev-parse", "HEAD");
    const env = { ...process.env, NT_STATE_DIR: join(temp, "state"),
      NT_CONFIG_FILE: join(temp, "absent.json"), NT_SKILL_CACHE_DIR: join(temp, "skills"),
      NT_VALIDATOR_CACHE_DIR: join(temp, "validators") };
    const cli = (...args: string[]) => {
      const res = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", "live"], {
        cwd: resolve("."), encoding: "utf8", timeout: 650_000, maxBuffer: 32 * 1024 * 1024, env,
      });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      return JSON.parse(res.stdout);
    };
    const job = cli("start");
    const contract = join(temp, "contract.json");
    writeFileSync(contract, JSON.stringify({ scope: {
      kind: "partial", depth: "interactive",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["trust", "confrontation"],
    }, constraints: ["Preserve the player's choice to protect or challenge their friend"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: ["Reuse the archive setting"],
      preferences: ["Two principal Characters", "No bespoke Room assets"] } }));
    const arch = cli("architecture", "run", "--fixture", "--skills-source", source, "--contract", contract);
    assert.equal(arch.status, "architecture-committed");
    const foundations = cli("foundations", "run", "--fixture", "--skills-source", source);
    assert.equal(foundations.status, "foundations-committed");
    const args = ["event", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const generated = cli(...args);
    assert.equal(generated.status, "event-cluster-committed");
    assert.ok(generated.paths.some((p: string) => p.startsWith("events/")));
    assert.equal(generated.validation.status, "passed");
    assert.ok(generated.validation.eventProgress.every((p: any) => p.status === "reachable"));
    assert.ok(generated.validation.routes.some((p: any) => p.status === "reachable"));
    assert.equal(generated.validation.protectionBase, foundations.headSha);
    assert.equal(generated.skillReads.length, 6);
    const messages = readFileSync(generated.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const calls = messages.flatMap((m: any) => m.message?.content ?? [])
      .filter((item: any) => item.type === "toolCall");
    const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
    assert.ok(generated.skillReads.every((p: string) => reads.includes(p)));
    assert.ok(calls.some((c: any) => ["write", "edit"].includes(c.name)));
    const report = cli("validate");
    assert.equal(report.status, "passed");
    assert.equal(report.report.coverage.milestoneRoutes
      .find((m: any) => m.id === "milestone.disclosure").routes.some((r: any) => r.status === "reachable"), true);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), generated.headSha);
    assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: event-disclosure/);
    completed = true;
  } finally {
    assert.equal(git(source, "status", "--porcelain"), skillSourceStatus);
    if (!completed && process.env.NT_KEEP_FAILED_LIVE === "1") {
      process.stderr.write("Preserved failed Event Pi job: " + temp + "\n");
    } else {
      removeTestTree(temp);
    }
  }
});
