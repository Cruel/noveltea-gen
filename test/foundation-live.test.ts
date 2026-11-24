import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import type { CompletionContract } from "../src/architecture.js";

test("opt-in real Pi specialist reads pinned skills and directly writes validated Markdown", {
  skip: process.env.NT_LIVE_FOUNDATION !== "1" ? "set NT_LIVE_FOUNDATION=1 for paid live Pi certification" : false,
  timeout: 300_000,
}, async () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT || "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-story-discovery/SKILL.md")));
  const temp = mkdtempSync(join(tmpdir(), "nt-foundation-live-"));
  function git(cwd: string, ...args: string[]) {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  }
  function command(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args], {
      cwd: resolve("."), encoding: "utf8", timeout: 270_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NT_STATE_DIR: join(temp, "state"),
        NT_SKILL_CACHE_DIR: join(temp, "skill-cache"),
         },
    });
  }
  const originalStatus = git(source, "status", "--porcelain");
  try {
    const repo = join(temp, "author");
    const story = join(repo, "story");
    mkdirSync(story, { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Story Author");
    git(repo, "config", "user.email", "story@example.test");
    writeFileSync(join(repo, "README.txt"), "Existing author-managed Git repository\n");
    git(repo, "add", "README.txt");
    git(repo, "commit", "-qm", "Author baseline");
    const base = git(repo, "rev-parse", "HEAD");

    const init = command("start", "--story", story, "--job", "live-foundation");
    assert.equal(init.status, 0, init.stderr);
    const job = JSON.parse(init.stdout);
    const task = "Create a concise mystery visual novel: an archivist on a stranded midnight train discovers that every passenger is concealing part of a disappearance. Use a small cast, two reusable locations and dialogue-led clues. You are delegated all unspecified creative choices.";
    const contract: CompletionContract = {
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: ["Small cast", "Two reusable locations", "Dialogue-led clues"],
      envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] },
    };
    const contractFile = join(temp, "contract.json");
    writeFileSync(contractFile, JSON.stringify(contract));
    await saveJobTurnPlan(job, planWholeStory(task, contract, job.baseSha));
    const args = ["generate", "start", "--story", story, "--job", "live-foundation",
      "--task", task, "--contract", contractFile, "--skills-source", source,
      "--pause-after", "foundation"];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const result = command(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generation = JSON.parse(result.stdout);
    assert.equal(generation.status, "paused", JSON.stringify(generation));
    assert.ok(generation.completedStages.some((entry: { stage: string }) => entry.stage === "foundation"));
    const outcome = JSON.parse(readFileSync(join(job.stateDir, "foundation.json"), "utf8"));
    assert.equal(outcome.stage, "committed");
    assert.equal(outcome.validation, "passed", "Native CLI must verify valid empty Git baselines");
    assert.equal(outcome.skillReads.length, 5);
    const entries = readFileSync(outcome.piSessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const calls = entries.flatMap((entry: any) => entry.message?.content ?? [])
      .filter((item: any) => item.type === "toolCall");
    const reads = calls.filter((item: any) => item.name === "read")
      .map((item: any) => item.arguments?.path);
    assert.ok(outcome.skillReads.every((path: string) => reads.includes(path)));
    assert.ok(calls.some((item: any) => item.name === "write" || item.name === "edit"),
      "Actual Pi must write/edit Markdown itself, not call a record authoring tool");
    assert.ok(calls.some((item: any) => item.name === "story_validate"),
      "Actual Pi must invoke native story_validate, not merely claim a validation pass");
    const record = readFileSync(join(job.worktreeStoryRoot, outcome.target), "utf8");
    assert.match(record, /^---\nschema: ['"]?0\.1/);
    assert.match(record, /origin: user\n\s+authority: user-protected/);
    assert.match(record, /origin: agent\n\s+authority: delegated/);
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: foundation/);
  } finally {
    assert.equal(git(source, "status", "--porcelain"), originalStatus,
      "Pinned source skill checkout must remain untouched by the specialist");
    removeTestTree(temp);
  }
});
