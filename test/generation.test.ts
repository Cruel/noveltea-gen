import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { createGenerationGraph } from "../src/generation.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const root = mkdtempSync(join(tmpdir(), "nt-generation-"));
after(() => {
  if (process.env.NT_LIVE_GENERATION === "1" && process.env.NT_KEEP_FAILED_LIVE === "1")
    console.error("Preserved disposable generation evidence: " + root);
  else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial Story");
  const initial = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(root, "config.json"), JSON.stringify({ novelteaSkills: source, skillDiscovery: "explicit-only" }));
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
    NT_VALIDATOR_CACHE_DIR: join(root, "validators") };
  function cli(args: string[], success = true) {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
      "job", ...args, "--story", story, "--job", "single"], {
      encoding: "utf8", env, timeout: process.env.NT_LIVE_GENERATION === "1" ? 1_800_000 : 240_000, maxBuffer: 32 * 1024 * 1024 });
    if (!success) { assert.notEqual(result.status, 0); return result.stderr; }
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  }
  const job = cli(["start"]);
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({ scope: { kind: "partial", depth: "composition",
    targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
    constraints: ["The player can protect or challenge the witness"],
    envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] } }));
  const start = ["generate", "start", "--task", "A missing archive witness; invent unspecified details",
    "--contract", contract, "--fixture", "--skills-source", source];
  return { repo, story, initial, cli, job, start, contract, env };
}

test("single-Milestone generation checkpoints foundation then resumes all specialists in a new process", { skip: !available }, () => {
  const f = setup("complete");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.nextStage, "architecture");
  assert.ok(existsSync(join(dirname(f.job.worktreeRoot), "generation.sqlite")));
  const foundationHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(foundationHead, f.initial);
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), foundationHead);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.reason, "editorial-unverified");
  assert.equal(result.report.generation.review.phase, "completed");
  assert.equal(result.report.evidence.scope.deterministic, "passed");
  assert.equal(result.completedStages.length, 7);
  const finalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(f.cli(["generate", "resume"]).reason, "editorial-unverified");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalHead);
  assert.match(readFileSync(join(f.job.worktreeStoryRoot, "authored-content/disclosure-scene.md"), "utf8"), /Ada/);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
});

test("generation honors author pause, questions, cancellation and cumulative budgets without dispatching", { skip: !available }, () => {
  const f = setup("controls");
  f.cli(["author", "control", "--state", "paused"]);
  assert.equal(f.cli(f.start).status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  f.cli(["author", "control", "--state", "running"]);
  f.cli(["pi", "configure", "--max-steps", "0"]);
  assert.equal(f.cli(["generate", "resume"]).status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  f.cli(["pi", "configure", "--max-steps", "50"]);
  assert.equal(f.cli(["generate", "resume", "--pause-after", "foundation"]).nextStage, "architecture");
  const message = join(root, "question.json");
  writeFileSync(message, JSON.stringify({ id: "ask", kind: "question", payload: { question: "May the witness lie?" } }));
  f.cli(["author", "send", "--file", message]);
  const question = f.cli(["generate", "resume"]);
  assert.equal(question.status, "blocked");
  assert.match(question.reason, /awaiting-author/);
  const response = join(root, "answer.json");
  writeFileSync(response, JSON.stringify({ type: "answer", messageId: "ask", answer: "Yes" }));
  f.cli(["author", "resume", "--file", response]);
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).nextStage, "foundations");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["author", "control", "--state", "cancelled"]);
  assert.equal(f.cli(["generate", "resume"]).status, "cancelled");
  assert.equal(f.cli(["generate", "resume"]).status, "cancelled");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("generation preserves unexpected edits and rejects new contracts on resume", { skip: !available }, () => {
  const f = setup("dirty");
  f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const path = join(f.job.worktreeStoryRoot, "author-notes.txt");
  writeFileSync(path, "Preserve my unfinished work");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /clean|unexpected|dirty/i);
  assert.equal(readFileSync(path, "utf8"), "Preserve my unfinished work");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.match(inspection.reason, /clean|unexpected|dirty/i);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.match(f.cli(["generate", "resume", "--contract", f.contract], false), /pinned/);
  assert.match(f.cli(f.start, false), /already exists/);
});

test("inspection detects dirty work after a saved pause without advancing checkpoints", { skip: !available }, () => {
  const f = setup("inspect-drift");
  f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.job.worktreeStoryRoot, "new.txt"), "Do not overwrite");
  const inspection = f.cli(["generate", "inspect"]);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.checkpointStatus, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("parent restart reconciles a specialist commit made before receipt/checkpoint publication", { skip: !available }, async () => {
  const f = setup("recovery");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const file = join(dirname(f.job.worktreeRoot), "foundation.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  receipt.stage = "writing";
  delete receipt.commitSha;
  writeFileSync(file, JSON.stringify(receipt));
  // Simulate a crash window: Git committed, while the parent still schedules
  // foundation and the specialist's final receipt has not been published.
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const graph = createGenerationGraph(saver);
    await graph.updateState({ configurable: { thread_id: paused.threadId } },
      { cursor: 0, completedStages: [], result: null });
  } finally { saver.db.close(); }
  const recovered = f.cli(["generate", "resume", "--pause-after", "foundation"]);
  assert.equal(recovered.status, "paused", JSON.stringify(recovered));
  assert.equal(recovered.completedStages[0].headSha, head);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).stage, "committed");
});

test("opt-in real Pi single-Milestone generation uses pinned skills and reports honest completion", {
  skip: process.env.NT_LIVE_GENERATION !== "1" ? "set NT_LIVE_GENERATION=1 for paid Pi verification" : false,
  timeout: 3_600_000,
}, () => {
  assert.ok(available);
  const f = setup("live");
  const args = f.start.filter(x => x !== "--fixture");
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const first = f.cli([...args, "--pause-after", "foundation"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  const foundation = JSON.parse(readFileSync(join(dirname(f.job.worktreeRoot), "foundation.json"), "utf8"));
  const calls = readFileSync(foundation.piSessionFile, "utf8").trim().split("\n").map(JSON.parse)
    .flatMap((entry: any) => entry.message?.content ?? []).filter((item: any) => item.type === "toolCall");
  assert.ok(calls.some((item: any) => item.name === "read" && item.arguments?.path?.includes("nt-story-discovery/SKILL.md")));
  assert.ok(calls.some((item: any) => ["write", "edit"].includes(item.name)));
  const result = f.cli(["generate", "resume"]);
  assert.ok(["completed", "blocked", "paused"].includes(result.status));
  if (result.status === "completed") assert.equal(result.report.evidence.editorial.verdict, "pass");
  else assert.ok(result.reason, "A blocked live run must explain what needs reconciliation");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  console.error(JSON.stringify({ status: result.status, reason: result.reason, completedStages: result.completedStages }));
});

test("Studio exposes production scheduling rather than the retired prototype", async () => {
  const config = JSON.parse(readFileSync(resolve("langgraph.json"), "utf8"));
  assert.equal(config.graphs.noveltea, undefined);
  assert.equal(config.graphs.story_generation, "./src/studio.ts:graph");
  const f = setup("studio-input");
  const prepared = spawnSync(process.execPath, ["--import", "tsx", resolve("src/studio-input.ts"),
    "--story", f.story, "--job", "single", "--task", "A scoped mystery", "--contract", f.contract, "--fixture"],
  { encoding: "utf8", env: f.env, timeout: 30_000 });
  assert.equal(prepared.status, 0, prepared.stderr);
  const input = JSON.parse(prepared.stdout);
  assert.equal(input.request.story, f.story);
  assert.equal(input.request.fixture, true);
  assert.equal(input.request.contract.scope.targets[1], "milestone.disclosure");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  const topology = await createGenerationGraph().getGraphAsync();
  for (const node of ["schedule", "author_update_intake", "specialist_dispatch", "verify_committed_work", "completion_decision"])
    assert.ok(topology.nodes[node], node);
});
