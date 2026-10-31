import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Client } from "@langchain/langgraph-sdk";
import { removeTestTree } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "noveltea-skein-"));
const skills = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(skills, "src/cli.ts"));
let server: ChildProcess | undefined;
const env = { ...process.env, NT_STATE_DIR: join(root, "state"),
  NT_SKILL_CACHE_DIR: join(root, "skills"), NT_VALIDATOR_CACHE_DIR: join(root, "validators"),
  NT_VALIDATOR_TEST_LEGACY: "1", LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false",
  NT_SKEIN_QUALIFY_DB: join(root, "skein.sqlite"), NT_SKEIN_QUALIFY_PORT: "0" };

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function cli(story: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
    "job", ...args, "--story", story, "--job", "skein-test"], {
    env, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function setup() {
  const repo = join(root, "repository"), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Story baseline");
  const base = git(repo, "rev-parse", "HEAD");
  cli(story, "start");
  return { repo, story, base };
}
async function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/skein-qualification-host.ts")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  let output = "", errors = "";
  child.stderr!.on("data", chunk => { errors += chunk.toString(); });
  return new Promise<Client>((resolveClient, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); reject(new Error("Skein startup timeout: " + errors + output));
    }, 15_000);
    child.stdout!.on("data", chunk => {
      output += chunk.toString();
      const line = output.split("\n").find(x => x.startsWith('{"ready":true'));
      if (!line) return;
      clearTimeout(timer);
      const address = JSON.parse(line) as { port: number };
      resolveClient(new Client({ apiUrl: `http://127.0.0.1:${address.port}` }));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Skein exited (${code} / ${signal}): ${errors}${output}`));
    });
  });
}
async function stopServer() {
  const child = server; server = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    child.kill("SIGTERM");
  });
}
after(async () => { await stopServer(); removeTestTree(root); });

test("Skein rejects an overlapping run on the same thread", { timeout: 30_000 }, async () => {
  const client = await startServer();
  const thread = await client.threads.create();
  const first = client.runs.wait(thread.thread_id, "slow_probe", {
    input: {}, multitaskStrategy: "reject",
  });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 180));
  await assert.rejects(client.runs.wait(thread.thread_id, "slow_probe", {
    input: {}, multitaskStrategy: "reject",
  }), /active|already|409|conflict|in.progress|rejected/i);
  assert.equal((await first as { completed?: boolean }).completed, true);
  await stopServer();
});

test("opt-in real Pi foundation executes inside the Skein-hosted production graph", {
  skip: process.env.NT_LIVE_SKEIN !== "1" ? "set NT_LIVE_SKEIN=1 for paid Pi smoke" : false,
  timeout: 240_000,
}, async () => {
  assert.ok(available, "NovelTea skill checkout required");
  const repo = join(root, "live-repository"), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Live Story baseline");
  const head = git(repo, "rev-parse", "HEAD");
  const start = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
    "job", "start", "--story", story, "--job", "skein-live"], {
    env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout) as { worktreeRoot: string; worktreeStoryRoot: string };
  const client = await startServer();
  const thread = await client.threads.create();
  const state = await client.runs.wait(thread.thread_id, "story_generation", {
    input: { request: {
      story, job: "skein-live", task: "Develop Creative Direction for a witness mystery",
      contract: { scope: { kind: "partial", depth: "composition",
        targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
        constraints: ["An archive witness is missing"],
        envelope: { presentation: "Dialogue-driven mystery", hardLimits: [], preferences: [] } },
      fixture: false, skillsSource: skills, validatorSource: skills,
      ...(process.env.NT_PROVIDER ? { provider: process.env.NT_PROVIDER } : {}),
      ...(process.env.NT_MODEL ? { model: process.env.NT_MODEL } : {}),
    }, pauseAfter: "foundation" },
    config: { recursion_limit: 10000 },
  }) as { status?: string; reason?: string; completedStages?: unknown[] };
  assert.equal(state.status, "paused", JSON.stringify(state));
  assert.equal(state.completedStages?.length, 1);
  assert.notEqual(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.ok(existsSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md")));
  await stopServer();
});

test("Skein approval interrupt survives a process restart and needs an explicit resume", {
  timeout: 45_000,
}, async () => {
  const client = await startServer();
  const thread = await client.threads.create();
  const result = await client.runs.wait(thread.thread_id, "approval_probe", {
    input: { proposal: "reviewed exact proposal" },
  });
  assert.ok(result, "first call returns an interrupted run result");
  const waiting = await client.threads.getState(thread.thread_id);
  assert.ok((waiting.tasks ?? []).some(task => task.interrupts?.length));
  await stopServer();

  const resumedClient = await startServer();
  const recovered = await resumedClient.threads.getState(thread.thread_id);
  assert.ok((recovered.tasks ?? []).some(task => task.interrupts?.length),
    "approval must remain pending without consent");
  const approved = await resumedClient.runs.wait(thread.thread_id, "approval_probe", {
    command: { resume: "approve" },
  }) as { approved?: boolean };
  assert.equal(approved.approved, true);
  await stopServer();
});

test("real Story-generation graph runs through Skein and recovers a checkpoint after server restart", {
  skip: !available, timeout: 240_000,
}, async () => {
  const { repo, story, base } = setup();
  const request = {
    story, job: "skein-test", task: "A missing archive witness; invent unspecified details",
    contract: { scope: { kind: "partial", depth: "composition",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
      constraints: ["The player can protect or challenge the witness"],
      envelope: { presentation: "Dialogue-led visual novel", hardLimits: [], preferences: [] } },
    fixture: true, skillsSource: skills,
  };
  const client = await startServer();
  const thread = await client.threads.create();
  const config = { recursion_limit: 10000 };
  const first = await client.runs.wait(thread.thread_id, "story_generation", {
    input: { request, pauseAfter: "foundation" }, config,
  }) as { status?: string; completedStages?: unknown[] };
  assert.equal(first.status, "paused", JSON.stringify(first));
  assert.equal(first.completedStages?.length, 1);
  const cliTakeover = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
    "job", "generate", "resume", "--story", story, "--job", "skein-test"], {
    env, encoding: "utf8", timeout: 30_000,
  });
  assert.notEqual(cliTakeover.status, 0, "CLI must not compete with server checkpoints");
  assert.match(cliTakeover.stderr, /server-owned generation thread/i);
  const rival = await client.threads.create();
  const duplicate = await client.runs.wait(rival.thread_id, "story_generation", {
    input: { request, pauseAfter: null }, config,
  }) as { status?: string; reason?: string };
  assert.equal(duplicate.status, "blocked", JSON.stringify(duplicate));
  assert.match(duplicate.reason ?? "", /another thread|second writer/i);
  const headAfterFoundation = git(repo, "rev-parse", "HEAD");
  assert.equal(headAfterFoundation, base, "Author branch remains untouched");
  const before = await client.threads.getState(thread.thread_id);
  assert.equal((before.values as { status: string }).status, "paused");
  const questionFile = join(root, "question.json");
  writeFileSync(questionFile, JSON.stringify({ id: "skein-question", kind: "question",
    payload: { question: "May the witness lie?" } }));
  cli(story, "author", "send", "--file", questionFile);
  const pending = cli(story, "author", "process");
  assert.equal(pending.status, "blocked");
  assert.deepEqual(pending.blockers, ["awaiting-author:skein-question"]);
  await stopServer();

  const resumedClient = await startServer();
  const saved = await resumedClient.threads.getState(thread.thread_id);
  assert.equal((saved.values as { status: string }).status, "paused", "Skein must reopen the original SQLite checkpoint");
  const waiting = await resumedClient.runs.wait(thread.thread_id, "story_generation", {
    input: { request, pauseAfter: null }, config,
  }) as { status?: string; reason?: string };
  assert.equal(waiting.status, "blocked", JSON.stringify(waiting));
  assert.match(waiting.reason ?? "", /awaiting-author:skein-question/);
  const responseFile = join(root, "answer.json");
  writeFileSync(responseFile, JSON.stringify({ type: "answer", messageId: "skein-question",
    answer: "Leave it ambiguous." }));
  const answer = cli(story, "author", "resume", "--file", responseFile);
  assert.equal(answer.phase, "applied");
  const second = await resumedClient.runs.wait(thread.thread_id, "story_generation", {
    input: { request, pauseAfter: null }, config,
  }) as { status?: string; completedStages?: unknown[]; reason?: string };
  assert.equal(second.status, "blocked", JSON.stringify(second));
  assert.equal(second.reason, "editorial-unverified");
  assert.ok((second.completedStages?.length ?? 0) >= 7);
  assert.equal(git(repo, "rev-parse", "HEAD"), base);
  const changed = await resumedClient.runs.wait(thread.thread_id, "story_generation", {
    input: { request: { ...request, task: "unauthorized changed task" }, pauseAfter: null }, config,
  }) as { status?: string; reason?: string };
  assert.equal(changed.status, "blocked", JSON.stringify(changed));
  assert.match(changed.reason ?? "", /pinned request/i);
  await stopServer();
});
