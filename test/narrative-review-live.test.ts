import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";

/** An opt-in qualitative test of #26's actual public review gate.
 * Upstream work is deterministic so the review's Pi judgment is isolated. */
test("independent live Pi reviewer inspects saved branching prose and reports source-linked findings", {
  skip: process.env.NT_LIVE_NARRATIVE_REVIEW !== "1"
    ? "set NT_LIVE_NARRATIVE_REVIEW=1 to use configured Pi credentials" : false,
  timeout: 1_200_000,
}, () => {
  const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
  assert.ok(existsSync(join(source, "skills/nt-narrative-review/SKILL.md")));
  const dir = mkdtempSync(join(tmpdir(), "nt-review-live-"));
  let complete = false;
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const repo = join(dir, "author"), story = join(repo, "story");
    mkdirSync(join(story, "creative-direction"), { recursive: true });
    writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player can protect a friend or demand accountability"
    origin: user
    authority: user-protected
premise: "A witness disappears before an archive inquiry"
central_conflict: "Expose a concealed ledger or preserve loyalty"
genre: "Mystery"
tone: "Intimate and uneasy"
player_experience: "Investigation and consequential conversations"
scope: "Two Characters and a single archive background"
---

Ada questions Neri about the missing witness and a disputed custody ledger.
`);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Author");
    git(repo, "config", "user.email", "author@example.test");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Original protected Story");
    const original = git(repo, "rev-parse", "HEAD");
    const env = { ...process.env, NT_STATE_DIR: join(dir, "state"),
      NT_SKILL_CACHE_DIR: join(dir, "skills"),
      NT_CONFIG_FILE: join(dir, "missing-config.json") };
    function cli(...args: string[]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
        "job", ...args, "--story", story, "--job", "live-review"], {
        cwd: resolve("."), encoding: "utf8", timeout: 1_000_000,
        maxBuffer: 32 * 1024 * 1024, env,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout);
    }
    const job = cli("start");
    const contract = join(dir, "contract.json");
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "partial", depth: "composition",
        targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
      constraints: ["The player can protect Neri or challenge the concealment"],
      envelope: { presentation: "Visual novel", hardLimits: ["Reuse the archive backdrop"],
        preferences: ["Two principal Characters"] },
    }));
    for (const stage of [
      ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source],
      ["foundations", "run", "--fixture", "--skills-source", source],
      ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["composition", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ]) cli(...stage);
    const head = git(job.worktreeRoot, "rev-parse", "HEAD");
    const args = ["review", "run", "--skills-source", source];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    if (["low", "high"].includes(process.env.NT_THINKING ?? ""))
      args.push("--thinking", process.env.NT_THINKING!);
    const review = cli(...args);
    assert.equal(review.worker, "pi");
    assert.equal(review.audit.deterministic, "passed");
    assert.equal(review.audit.contractVersion, 1);
    assert.equal(review.status, "blocked", "The fixture's unearned clues and branch truth must not be certified");
    assert.equal(review.editorial.verdict, "block");
    assert.ok(review.editorial.findings.some((f: any) => f.severity === "blocking"));
    assert.ok(review.sessionFiles.length);
    const reviewerFile = review.sessionFiles[0];
    assert.ok(existsSync(reviewerFile));
    const messages = readFileSync(reviewerFile, "utf8").trim().split("\n").map(JSON.parse);
    const calls = messages.flatMap((m: any) => m.message?.content ?? [])
      .filter((c: any) => c.type === "toolCall");
    assert.ok(calls.some((c: any) => c.name === "read" &&
      c.arguments?.path?.includes("nt-narrative-review/SKILL.md")));
    assert.ok(calls.some((c: any) => c.name === "read" &&
      c.arguments?.path?.includes("authored-content/")));
    assert.ok(!calls.some((c: any) => ["write", "edit", "bash"].includes(c.name)));
    assert.ok(review.editorial.evidence.length);
    assert.ok(review.editorial.evidence.some((x: string) =>
      /authored-content\/[^\s:]+\.md:[1-9]/.test(x)));
    assert.equal(git(repo, "rev-parse", "HEAD"), original);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    complete = true;
    process.stdout.write("LIVE_NARRATIVE_REVIEW_VERDICT " + JSON.stringify({
      status: review.status, verdict: review.editorial.verdict,
      findings: review.editorial.findings, evidenceCount: review.editorial.evidence.length,
      sessionFile: reviewerFile,
    }) + "\n");
  } finally {
    if (!complete && process.env.NT_KEEP_FAILED_LIVE === "1") {
      process.stderr.write("Preserved live narrative review fixture: " + dir + "\n");
    } else {
      removeTestTree(dir);
    }
  }
});
