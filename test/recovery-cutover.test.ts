import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireGenerationTurn } from "../src/generation.js";
import { planWholeStory } from "../web/src/lib/turn-plan.js";
import { saveJobTurnPlan } from "../web/src/lib/turn-plan-receipt.server.js";
import { verifiedResumeAdmission } from "../web/src/lib/generation-controls.server.js";
import { preflightCompositionBoundary } from "../src/cross-domain-prerequisite-controller.js";
import type { JobStartResult } from "../src/job.js";
import type { CompositionBoundaryRequest } from "../src/cross-domain-prerequisite-controller.js";

test("R14 Composition prerequisite cannot promote a missing Turn pin to ready", async () => {
  // The proof must be checked before accessing any Git, validator or Pi effect.
  const job = new Proxy({} as JobStartResult, {
    get() { throw Error("Unadmitted prerequisite touched the job"); },
  });
  const request: CompositionBoundaryRequest = {
    task: "Continue the original Story",
    contract: {
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [],
      envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    },
  };
  for (const fixture of [false, true]) {
    const result = await preflightCompositionBoundary(job, { ...request, fixture },
      "milestone.original", 1);
    assert.equal(result.kind, "refuse");
  }
});

test("obsolete direct live stage commands refuse before opening a Story job", () => {
  for (const args of [
    ["foundation", "--mode", "collaborative"],
    ["foundation", "--mode", "autonomous"],
    ["architecture", "run"],
    ["foundations", "run"], ["event", "run"], ["interactive", "run"],
    ["composition", "run"], ["review", "run"], ["repair", "run"],
    ["ideas", "place"], ["ideas", "reassess", "--record"], ["ideas", "relocate"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts",
      "job", ...args, "--story", "/nonexistent-story", "--job", "obsolete"], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /retired.*Generation/i, args.join(" "));
  }
});

test("obsolete production server resume refuses before opening the writer lock", async () => {
  const job = { storyRoot: "/nonexistent-story", jobId: "obsolete",
    stateDir: "/nonexistent-state" } as JobStartResult;
  const request = { story: job.storyRoot, job: job.jobId, task: "Continue",
    fixture: false };
  await assert.rejects(verifiedResumeAdmission(job, "old-thread", JSON.stringify(request), false),
    /authenticated current-format Turn plan/);
});

test("current Turn admission authenticates exact request and source, not a claimed digest", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nt-r14k-turn-"));
  try {
    const job = { storyRoot: "/isolated/story", stateDir, jobId: "current",
      baseSha: "a".repeat(40) } as JobStartResult;
    const contract = {
      scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
      constraints: [],
      envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    };
    const task = "Continue the original Story";
    const plan = planWholeStory(task, contract, job.baseSha);
    await saveJobTurnPlan(job, plan);
    const request = { story: job.storyRoot, job: job.jobId, task, contract,
      fixture: false, turnPlanDigest: plan.digest };
    assert.deepEqual(await requireGenerationTurn(job, request), plan);
    await assert.rejects(requireGenerationTurn(job, { ...request, turnPlanDigest: "b".repeat(64) }),
      /corrupt\/stale/);
    await assert.rejects(requireGenerationTurn(job, { ...request, job: "other" }),
      /another Story Job/);
    await assert.rejects(requireGenerationTurn(job, { ...request, task: "Different objective" }),
      /corrupt\/stale/);
    assert.deepEqual(readdirSync(stateDir), ["turn-plan.json"], "admission must not acquire a writer or create receipts");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});


test("obsolete CLI Generation start does not claim SQLite ownership or mutate Git", () => {
  const root = mkdtempSync(join(tmpdir(), "nt-r14k-cli-"));
  try {
    const story = join(root, "story");
    mkdirSync(story);
    writeFileSync(join(story, ".gitkeep"), "");
    function git(...args: string[]) {
      const r = spawnSync("git", ["-C", story, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    }
    git("init", "-q");
    git("config", "user.name", "Author");
    git("config", "user.email", "author@example.test");
    git("add", ".");
    git("commit", "-qm", "Initial Story");
    const contract = join(root, "contract.json");
    writeFileSync(contract, JSON.stringify({
      scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
      constraints: [], envelope: { presentation: "Interactive Story", hardLimits: [], preferences: [] },
    }));
    function cli(...args: string[]) {
      return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "job", ...args,
        "--story", story, "--job", "obsolete"], {
        encoding: "utf8", timeout: 30_000,
        env: { ...process.env, NT_STATE_DIR: join(root, "state") },
      });
    }
    const started = cli("start");
    assert.equal(started.status, 0, started.stderr);
    const job = JSON.parse(started.stdout) as JobStartResult;
    const before = readdirSync(job.stateDir).sort();
    const head = git("rev-parse", "HEAD");
    const refused = cli("generate", "start", "--task", "Continue", "--contract", contract);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /authenticated current-format Turn plan/);
    assert.deepEqual(readdirSync(job.stateDir).sort(), before);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
