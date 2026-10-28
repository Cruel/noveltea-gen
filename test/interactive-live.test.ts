import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";

test("opt-in two real pinned Pi specialists build and certify a Choice/Puzzle interactive slice", {
  skip: process.env.NT_LIVE_INTERACTIVE !== "1" ? "set NT_LIVE_INTERACTIVE=1 to certify real specialists" : false,
  timeout: 1_200_000,
}, () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  for (const name of ["nt-interactive-narrative", "nt-puzzle-design"]) {
    assert.ok(existsSync(join(source, "skills", name, "SKILL.md")));
  }
  const temp = mkdtempSync(join(tmpdir(), "nt-interactive-live-"));
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const originalSkillsStatus = git(source, "status", "--porcelain");
  let completed = false;
  try {
    const repo = join(temp, "author");
    const story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A vanished witness"
status: draft
decisions:
  - id: author-choice
    statement: "The player must be able to protect or challenge the archivist's friend"
    origin: user
    authority: user-protected
premise: "A witness vanishes and the archive ledger appears to conceal evidence"
central_conflict: "Protect a friendship or confront concealment"
genre: "Mystery"
tone: "Intimate, uneasy"
player_experience: "Dialogue-led investigative decisions with optional evidence puzzles"
scope: "Two central Characters, one reusable archive location"
---

Ada suspects Neri has concealed the ledger record that could explain the witness's disappearance. A consequential loyalty decision must remain open to the player.
`);
    git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", "."); git(repo, "commit", "-qm", "Author's protected Creative Direction");
    const originalHead = git(repo, "rev-parse", "HEAD");
    const env = { ...process.env, NT_STATE_DIR: join(temp, "state"),
      NT_CONFIG_FILE: join(temp, "missing-config.json"),
      NT_SKILL_CACHE_DIR: join(temp, "skills"),
      NT_VALIDATOR_CACHE_DIR: join(temp, "validator") };
    function cli(...args: string[]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", "live"], {
        cwd: resolve("."), encoding: "utf8", timeout: 1_000_000,
        maxBuffer: 32 * 1024 * 1024, env,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout);
    }
    const job = cli("start");
    const contract = join(temp, "contract.json");
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "partial", depth: "interactive",
        targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route", "challenge-route"] },
      constraints: ["Preserve the explicit player choice to protect or confront Neri"],
      envelope: { presentation: "Dialogue-led visual novel",
        hardLimits: ["Reuse the archive location"], preferences: ["Two Character leads", "No new engine Rooms"] },
    }));
    assert.equal(cli("architecture", "run", "--fixture", "--skills-source", source,
      "--contract", contract).status, "architecture-committed");
    assert.equal(cli("foundations", "run", "--fixture", "--skills-source", source).status, "foundations-committed");
    const event = cli("event", "run", "--fixture", "--milestone", "milestone.disclosure",
      "--skills-source", source);
    assert.equal(event.status, "event-cluster-committed");
    const args = ["interactive", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    if (["low", "high"].includes(process.env.NT_THINKING ?? "")) args.push("--thinking", process.env.NT_THINKING!);
    const result = cli(...args);
    if (["low", "high"].includes(process.env.NT_THINKING ?? "")) assert.equal(result.thinking, process.env.NT_THINKING);
    assert.equal(result.status, "interactive-slice-committed");
    assert.deepEqual(result.specialistUnits.map((u: any) => u.phase), ["committed", "committed"]);
    assert.equal(result.specialistUnits[0].validation.protectionBase, event.headSha);
    assert.equal(result.specialistUnits[1].validation.protectionBase, result.specialistUnits[0].commitSha);
    for (const unit of result.specialistUnits) {
      assert.equal(unit.skillReads.length, 6);
      assert.match(unit.commitSha, /^[0-9a-f]{40}$/);
      const messages = readFileSync(unit.piSessionFile, "utf8").trim().split("\n").map(JSON.parse);
      if (["low", "high"].includes(process.env.NT_THINKING ?? "")) {
        assert.ok(messages.some((m: any) => m.message?.role === "assistant" &&
          m.message?.thinkingLevel === process.env.NT_THINKING), "Pi assistant messages must confirm requested thinking effort");
      }
      const calls = messages.flatMap((m: any) => m.message?.content ?? [])
        .filter((c: any) => c.type === "toolCall");
      const reads = calls.filter((c: any) => c.name === "read").map((c: any) => c.arguments?.path);
      assert.ok(unit.skillReads.every((p: string) => reads.includes(p)));
      assert.ok(calls.some((c: any) => ["write", "edit"].includes(c.name)));
    }
    assert.ok(result.specialistUnits[0].validation.choices.length > 0);
    assert.ok(result.specialistUnits[1].validation.puzzles.length > 0);
    assert.ok(result.specialistUnits[1].validation.puzzles[0].solutions.length >= 2);
    assert.ok(result.specialistUnits[1].validation.puzzles[0].solutions.every((s: any) =>
      s.status === "reachable" && s.clueAccess === "reachable"));
    const catalog = cli("validate");
    assert.equal(catalog.status, "passed");
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), result.headSha);
    assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
    completed = true;
  } finally {
    assert.equal(git(source, "status", "--porcelain"), originalSkillsStatus);
    if (!completed && process.env.NT_KEEP_FAILED_LIVE === "1") {
      process.stderr.write("Preserved failed interactive Pi Story job: " + temp + "\n");
    } else {
      removeTestTree(temp);
    }
  }
});
