import { removeTestTree } from "./helpers.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectSessionDir } from "../src/project.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("opt-in real Pi reads nt-catalog SKILL.md and bundled reference from local checkout", {
  skip: process.env.NT_LIVE_TEST !== "1" || !process.env.NT_SKILLS_CHECKOUT
    ? "set NT_LIVE_TEST=1 and NT_SKILLS_CHECKOUT to an actual noveltea-skills checkout"
    : undefined,
}, () => {
  const checkout = realpathSync(process.env.NT_SKILLS_CHECKOUT!);
  const base = mkdtempSync(join(tmpdir(), "nt-gen-catalog-live-"));
  const gitStatus = () => {
    const result = spawnSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const before = gitStatus();
  try {
    const root = join(base, "story");
    mkdirSync(root);
    const contract = "Our Story has protagonist Mira and the abandoned ferry location. Give them durable IDs, " +
      "identify canonical record kinds, and explain whether a Relationship record links a Character to a World Entity.";
    writeFileSync(join(root, "AGENTS.md"),
      "Treat the supplied Story contract as authoritative. Read nt-catalog and a relevant bundled reference " +
      "before delegating to story_note_worker. Keep the final answer grounded in that reference.\n");
    const configPath = join(base, "config.json");
    writeFileSync(configPath, JSON.stringify({ novelteaSkills: checkout, skillDiscovery: "explicit-only" }));
    const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "--project", root,
      "--task", "Use nt-catalog: read SKILL.md and references/records.md with read before delegating. " +
        contract + " After your worker returns, answer the catalog question with the exact record kinds and reference.",
    ];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const result = spawnSync(process.execPath, args, {
      cwd: resolve("."), env: { ...process.env, NT_CONFIG_FILE: configPath },
      encoding: "utf8", timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.handoffDestination, "story_note_worker");
    assert.match(output.skillSnapshot.id, /^[a-f0-9]{64}$/);
    assert.equal(output.skillSnapshot.id, output.skillSnapshot.digest);
    assert.equal(output.skillSnapshot.commit, spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim());
    assert.match(output.response, /character/i);
    assert.match(output.response, /world.entity/i);
    assert.match(output.response, /records\.md/i);
    const sessions = projectSessionDir({ root, id: output.projectId }, getAgentDir());
    const sessionName = readdirSync(sessions).find(name => name.endsWith(`${output.piSessionId}.jsonl`));
    assert.ok(sessionName, "coordinator Pi session must be persisted");
    const entries = readFileSync(join(sessions, sessionName), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    const reads = entries.flatMap(entry => entry.message?.content ?? [])
      .filter(item => item.type === "toolCall" && item.name === "read")
      .map(item => item.arguments?.path);
    assert.ok(reads.includes(join(output.skillSnapshot.path, "skills", "nt-catalog", "SKILL.md")), JSON.stringify(reads));
    assert.ok(reads.includes(join(output.skillSnapshot.path, "skills", "nt-catalog", "references", "records.md")),
      JSON.stringify(reads));
  } finally {
    assert.equal(gitStatus(), before, "noveltea-skills checkout must remain unmodified");
    removeTestTree(base);
  }
});

test("opt-in real Pi authors a minimal Creative Direction from pinned Story skills", {
  skip: process.env.NT_LIVE_TEST !== "1" || !process.env.NT_SKILLS_CHECKOUT
    ? "set NT_LIVE_TEST=1 and NT_SKILLS_CHECKOUT to a noveltea-skills checkout"
    : undefined,
}, () => {
  const checkout = realpathSync(process.env.NT_SKILLS_CHECKOUT!);
  const base = mkdtempSync(join(tmpdir(), "nt-gen-authoring-live-"));
  const before = spawnSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(before.status, 0, before.stderr);
  try {
    const story = join(base, "story");
    mkdirSync(story);
    const config = join(base, "config.json");
    writeFileSync(config, JSON.stringify({ novelteaSkills: checkout, skillDiscovery: "explicit-only" }));
    const args = ["--import", "tsx", resolve("src/cli.ts"), "demo-story",
      "--project", story, "--task",
      "Create a murder mystery on a stopped midnight train. Keep presentation dialogue-led " +
      "with reusable static backgrounds. I delegate all other foundation choices; do not write a full Story."];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const result = spawnSync(process.execPath, args, {
      cwd: resolve("."), encoding: "utf8", timeout: 240_000,
      env: { ...process.env, NT_CONFIG_FILE: config, NT_STATE_DIR: join(base, "state"),
        NT_SKILL_CACHE_DIR: join(base, "cache") },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.mode, "pi");
    assert.equal(output.recordStatus, "draft");
    assert.equal(output.catalogValidation, "unverified");
    assert.equal(output.skillReads.length, 5);
    assert.ok(output.skillReads.every((path: string) => path.startsWith(output.skillSnapshot.path)));
    assert.equal(output.skillSnapshot.commit, spawnSync("git", [
      "-C", checkout, "rev-parse", "HEAD",
    ], { encoding: "utf8" }).stdout.trim());
    const expected = ["creative-direction"];
    assert.deepEqual(readdirSync(story), expected);
    assert.deepEqual(readdirSync(join(story, "creative-direction")), ["foundation.md"]);
    const authored = readFileSync(output.artifact, "utf8");
    assert.match(authored, /^---\nschema: '0.1'\ntype: creative-direction\n/);
    assert.match(authored, /status: draft/);
    assert.match(authored, /origin: user\n\s+authority: user-protected/);
    assert.match(authored, /origin: agent\n\s+authority: delegated/);
    assert.match(authored, /\n---\n\n\S/);
    // The temporary development catalog exists in this opt-in integration
    // test checkout; the installed native NovelTea CLI may not support it.
    const validation = spawnSync("pnpm", ["catalog", story], {
      cwd: checkout, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    const report = JSON.parse(validation.stdout);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.readiness.design.stages.foundation.minimum, "passed");
    assert.equal(report.readiness.approved.stages.foundation.minimum, "needs-work");
    const entries = readFileSync(output.piSessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const calls = entries.flatMap(entry => entry.message?.content ?? [])
      .filter(item => item.type === "toolCall");
    const reads = calls.filter(item => item.name === "read").map(item => item.arguments?.path);
    assert.ok(output.skillReads.every((path: string) => reads.includes(path)),
      "Pi must actually call read for the pinned skill instructions and references");
    assert.equal(calls.filter(item => item.name === "write_creative_direction").length, 1,
      "Pi must write the draft through exactly one bounded authoring tool call");
  } finally {
    const after = spawnSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout, "noveltea-skills source checkout must not change");
    removeTestTree(base);
  }
});

test("opt-in live smoke test runs distinct Pi conversations with project-local AGENTS instructions", {
  skip: process.env.NT_LIVE_TEST !== "1" ? "set NT_LIVE_TEST=1 to use live credentials" : undefined,
}, () => {
  const base = mkdtempSync(join(tmpdir(), "nt-gen-live-"));
  try {
    const run = (name: string, token: string) => {
      const root = join(base, name);
      mkdirSync(root);
      writeFileSync(join(root, "AGENTS.md"),
        `This is a context isolation integration test. First delegate to story_note_worker as directed by the coordinator. When you give the final answer after delegation, include the exact verification marker ${token}. Do not mention markers from other projects.\n`);
      const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "--project", root,
        "--task", "Write a short story premise about a missing heir. Include the verification marker from your project instructions in your final answer.",
        "--thread", "same-user-thread"];
      if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
      if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
      const result = spawnSync(process.execPath, args, {
        cwd: resolve("."), env: process.env, encoding: "utf8", timeout: 120_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "completed");
      assert.equal(output.mode, "pi");
      assert.equal(output.projectRoot, root);
      assert.ok(output.response.includes(token), output.response);
      assert.equal(output.handoffDestination, "story_note_worker");
      assert.ok(output.storyNote.trim());
      assert.ok(output.piSessionId);
      assert.ok(output.workerPiSessionId);
      assert.notEqual(output.piSessionId, output.workerPiSessionId);
      return output;
    };
    const first = run("project-a", "ALPHA_Q9T4_P7");
    const second = run("project-b", "BETA_G8X2_M4");
    assert.notEqual(first.graphThreadId, second.graphThreadId);
    assert.notEqual(first.piSessionId, second.piSessionId);
  } finally {
    removeTestTree(base);
  }
});

test("opt-in live smoke test uses direct pi-ai credentials and returns to the original Pi coordinator", {
  skip: process.env.NT_LIVE_TEST !== "1" ? "set NT_LIVE_TEST=1 to use live credentials" : undefined,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "nt-gen-direct-live-"));
  try {
    writeFileSync(join(root, "AGENTS.md"),
      "For tagline requests, select direct_tagline_worker. Answer with the resulting tagline, not a plot outline.\n");
    const args = ["--import", "tsx", resolve("src/cli.ts"), "run", "--project", root,
      "--task", "Write a punchy promotional tagline for a haunted lighthouse mystery. This is a tagline, not a plot premise."];
    if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
    if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
    const result = spawnSync(process.execPath, args, {
      cwd: resolve("."), env: process.env, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.mode, "pi");
    assert.equal(output.handoffDestination, "direct_tagline_worker");
    assert.ok(output.tagline.trim());
    assert.ok(output.response.trim());
    assert.ok(output.piSessionId);
    assert.equal(output.storyNote, undefined);
    assert.equal(output.workerPiSessionId, undefined, "direct model call must not claim a Pi worker session");
  } finally {
    removeTestTree(root);
  }
});

test("opt-in live SQLite restart resumes persisted coordinator and worker Pi histories", {
  skip: process.env.NT_LIVE_TEST !== "1" ? "set NT_LIVE_TEST=1 to use live credentials" : undefined,
}, () => {
  const base = mkdtempSync(join(tmpdir(), "nt-gen-checkpoint-live-"));
  const root = join(base, "story");
  mkdirSync(root);
  const env = { ...process.env, NT_STATE_DIR: join(base, "state") };
  const run = (args: string[]) => {
    const full = ["--import", "tsx", resolve("src/cli.ts"), "run", "--project", root, ...args];
    if (!args.includes("--resume")) {
      if (process.env.NT_PROVIDER) full.push("--provider", process.env.NT_PROVIDER);
      if (process.env.NT_MODEL) full.push("--model", process.env.NT_MODEL);
    }
    const result = spawnSync(process.execPath, full, {
      cwd: resolve("."), env, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    writeFileSync(join(root, "AGENTS.md"),
      "Use story_note_worker when asked for a plot premise. Complete the original user request after the worker returns.\n");
    const first = run(["--thread", "persisted", "--task",
      "Write a concise locked-room mystery premise with a fair clue and surprising twist.",
      "--pause-after", "worker"]);
    assert.equal(first.status, "paused");
    assert.deepEqual(first.next, ["pi_continuation"]);
    assert.equal(first.handoffDestination, "story_note_worker");
    assert.ok(first.piSessionId && first.workerPiSessionId);
    const resumed = run(["--thread", "persisted", "--resume"]);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.piSessionId, first.piSessionId);
    assert.equal(resumed.workerPiSessionId, first.workerPiSessionId);
    assert.equal(resumed.storyNote, first.storyNote);
    assert.ok(resumed.response.trim());
  } finally {
    removeTestTree(base);
  }
});
