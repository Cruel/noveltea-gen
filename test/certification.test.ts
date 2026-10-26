import { removeTestTree } from "./helpers.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { runCoordinator, DIRECT_WORKER_DESTINATION, WORKER_DESTINATION, type CoordinatorOptions } from "../src/graph.js";
import { readLocalTrace } from "../src/local-trace.js";
import { createProjectResourceLoader } from "../src/pi.js";
import { createSkillReadTool } from "../src/skills.js";
import { verifiedSkillFiles } from "../src/snapshot.js";

const cli = resolve("src/cli.ts");
const note = "A secret in the opening scene changes everything.";
const tagline = "Every secret has a final chapter.";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function certificationFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nt-gen-certification-"));
  t.after(() => removeTestTree(root));
  const checkout = join(root, "noveltea-skills");
  const catalog = join(checkout, "skills", "nt-catalog");
  mkdirSync(join(catalog, "references"), { recursive: true });
  mkdirSync(join(checkout, "skills", "nt-story-discovery"), { recursive: true });
  writeFileSync(join(catalog, "SKILL.md"),
    "---\nname: nt-catalog\ndescription: Catalog reference\n---\nRead only\n");
  writeFileSync(join(checkout, "skills", "nt-story-discovery", "SKILL.md"),
    "---\nname: nt-story-discovery\ndescription: Discovery reference\n---\nFoundation\n");
  for (const name of ["records.md", "authority-and-validation.md", "glossary.md"]) {
    writeFileSync(join(catalog, "references", name), "# " + name + "\nOriginal skill source\n");
  }
  git(checkout, "init", "-q");
  git(checkout, "add", "skills");
  git(checkout, "-c", "user.name=Certifier", "-c", "user.email=certifier@example.invalid",
    "commit", "-qm", "Baseline reference");
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ novelteaSkills: checkout, skillDiscovery: "explicit-only" }));
  const env = {
    ...process.env,
    NT_CONFIG_FILE: config,
    NT_STATE_DIR: join(root, "state"),
    NT_SKILL_CACHE_DIR: join(root, "snapshots"),
    NT_LOCAL_TRACE_DIR: join(root, "traces"),
    LANGSMITH_TRACING: "true",
    LANGCHAIN_TRACING_V2: "true",
    TRACE_TO_LANGSMITH: "true",
    LANGSMITH_API_KEY: "",
    LANGCHAIN_API_KEY: "",
  };
  const execute = (command: "run" | "demo-story", project: string, args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, command, "--project", project, ...args], {
      cwd: resolve("."), env, encoding: "utf8", timeout: 45_000,
    });
  const success = (command: "run" | "demo-story", project: string, args: string[]) => {
    const result = execute(command, project, args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, checkout, catalog, env, execute, success };
}

test("certification: public CLI selects only the routed worker, resumes the same coordinator and isolates two Story roots", async t => {
  const f = certificationFixture(t);
  const firstRoot = join(f.root, "first-story");
  const secondRoot = join(f.root, "second-story");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  writeFileSync(join(firstRoot, "keep.txt"), "first private file");
  writeFileSync(join(secondRoot, "keep.txt"), "second private file");
  const first = f.success("run", firstRoot,
    ["--fixture", "--thread", "same-thread", "--task", "A locked-room clue", "--trace-local"]);
  const second = f.success("run", secondRoot,
    ["--fixture", "--fixture-direct", "--thread", "same-thread", "--task", "A gloomy slogan", "--trace-local"]);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.tracing, false, "inherited tracing environment must not enable hosting");
  assert.equal(second.tracing, false);
  assert.equal(first.handoffDestination, WORKER_DESTINATION);
  assert.equal(first.storyNote, note);
  assert.equal(first.tagline, undefined);
  assert.ok(first.workerPiSessionId);
  assert.notEqual(first.workerPiSessionId, first.piSessionId);
  assert.match(first.response, /A locked-room clue/);
  assert.match(first.response, /worker note/);
  assert.equal(second.handoffDestination, DIRECT_WORKER_DESTINATION);
  assert.equal(second.tagline, tagline);
  assert.equal(second.storyNote, undefined);
  assert.equal(second.workerPiSessionId, undefined);
  assert.match(second.response, /A gloomy slogan/);
  assert.match(second.response, /direct tagline/);
  assert.notEqual(first.projectId, second.projectId);
  assert.notEqual(first.graphThreadId, second.graphThreadId);
  assert.notEqual(first.piSessionId, second.piSessionId);
  assert.equal(first.skillSnapshot.id, second.skillSnapshot.id);
  assert.equal(first.skillSnapshot.id, first.skillSnapshot.digest);
  assert.equal(first.skillSnapshot.commit, git(f.checkout, "rev-parse", "HEAD"));
  for (const [run, selected, unselected] of [
    [first, WORKER_DESTINATION, DIRECT_WORKER_DESTINATION],
    [second, DIRECT_WORKER_DESTINATION, WORKER_DESTINATION],
  ] as const) {
    const spans = await readLocalTrace(run.localTrace);
    const names = spans.map(span => span.name);
    for (const required of ["pi_coordinator", selected, "pi_continuation"]) {
      assert.ok(names.includes(required), "Missing " + required + ": " + names.join(", "));
    }
    assert.ok(!names.includes(unselected), "Unselected worker ran: " + names.join(", "));
  }
  for (const [root, original, marker] of [
    [firstRoot, first, "first private file"], [secondRoot, second, "second private file"],
  ] as const) {
    const again = f.success("run", root, ["--fixture", "--thread", "same-thread", "--resume"]);
    assert.equal(again.status, "completed");
    assert.equal(again.piSessionId, original.piSessionId);
    assert.equal(again.response, original.response);
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), marker);
    assert.deepEqual(readdirSync(root), ["keep.txt"]);
  }
});

test("certification: cross-process safe handoff resumes the original pinned skill generation after source revisions", async t => {
  const f = certificationFixture(t);
  const story = join(f.root, "resume-story");
  mkdirSync(story);
  const originalCommit = git(f.checkout, "rev-parse", "HEAD");
  const paused = f.success("run", story,
    ["--fixture", "--thread", "pinned", "--task", "An old manor", "--pause-after", "handoff"]);
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.next, [WORKER_DESTINATION]);
  assert.equal(paused.response, undefined);
  const originalPath = paused.skillSnapshot.path;
  const reference = join("skills", "nt-catalog", "references", "records.md");
  const oldContents = readFileSync(join(originalPath, reference), "utf8");
  assert.equal(paused.skillSnapshot.commit, originalCommit);
  // Deliberately update the source checkout between separate CLI processes.
  writeFileSync(join(f.catalog, "references", "records.md"), "# records.md\nNew skill source\n");
  git(f.checkout, "add", "skills");
  git(f.checkout, "-c", "user.name=Certifier", "-c", "user.email=certifier@example.invalid",
    "commit", "-qm", "Revised catalog");
  const changedCommit = git(f.checkout, "rev-parse", "HEAD");
  assert.notEqual(changedCommit, originalCommit);
  const resumed = f.success("run", story, ["--fixture", "--thread", "pinned", "--resume"]);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.piSessionId, paused.piSessionId);
  assert.equal(resumed.graphThreadId, paused.graphThreadId);
  assert.equal(resumed.skillSnapshot.id, paused.skillSnapshot.id);
  assert.equal(resumed.skillSnapshot.commit, originalCommit);
  assert.equal(readFileSync(join(originalPath, reference), "utf8"), oldContents);
  assert.match(readFileSync(join(f.catalog, "references", "records.md"), "utf8"), /New skill source/);
  // Exercise the same restricted skill reader used by Pi against the pinned
  // snapshot, not just the cache bytes or the checkpoint metadata.
  const { loader } = createProjectResourceLoader({ root: story, id: resumed.projectId },
    join(f.root, "agent"), true, {
      discovery: "explicit-only", novelteaSkills: originalPath,
      skillDirs: [], requiredSkills: ["nt-catalog"],
    });
  await loader.reload();
  const originalCache = process.env.NT_SKILL_CACHE_DIR;
  process.env.NT_SKILL_CACHE_DIR = f.env.NT_SKILL_CACHE_DIR;
  let approved;
  try { approved = await verifiedSkillFiles(paused.skillSnapshot.id); }
  finally {
    if (originalCache === undefined) delete process.env.NT_SKILL_CACHE_DIR;
    else process.env.NT_SKILL_CACHE_DIR = originalCache;
  }
  const read = createSkillReadTool(loader.getSkills().skills, approved);
  const result = await read.execute("certification",
    { path: join(originalPath, reference) }, undefined, undefined, {} as never);
  assert.equal(result.content[0]?.type, "text");
  if (result.content[0]?.type === "text") assert.equal(result.content[0].text, oldContents);
  await assert.rejects(read.execute("certification",
    { path: join(f.catalog, "references", "records.md") }, undefined, undefined, {} as never),
  /Skill read denied/);
  const fresh = f.success("run", story,
    ["--fixture", "--thread", "new-generation", "--task", "Another clue"]);
  assert.equal(fresh.status, "completed");
  assert.notEqual(fresh.skillSnapshot.id, paused.skillSnapshot.id);
  assert.equal(fresh.skillSnapshot.commit, changedCommit);
  assert.match(readFileSync(join(fresh.skillSnapshot.path, reference), "utf8"), /New skill source/);
  const replay = f.success("run", story, ["--fixture", "--thread", "pinned", "--resume"]);
  assert.equal(replay.response, resumed.response);
  assert.equal(replay.skillSnapshot.id, paused.skillSnapshot.id);
  assert.deepEqual(readdirSync(story), [], "graph invocation never writes Story canon");
});

test("certification: two disposable Story roots produce only minimal draft foundations from pinned skills", t => {
  const f = certificationFixture(t);
  const before = git(f.checkout, "status", "--porcelain");
  const revision = git(f.checkout, "rev-parse", "HEAD");
  for (const name of ["foundation-a", "foundation-b"]) {
    const root = join(f.root, name);
    mkdirSync(root);
    const result = f.success("demo-story", root,
      ["--fixture", "--task", "A murder mystery; delegate the remaining creative choices"]);
    assert.equal(result.mode, "fixture", "fixture must not claim actual Pi skill use");
    assert.equal(result.status, "completed");
    assert.equal(result.recordStatus, "draft");
    assert.equal(result.catalogValidation, "unverified");
    assert.equal(result.skillSnapshot.id, result.skillSnapshot.digest);
    assert.equal(result.skillSnapshot.commit, revision);
    assert.equal(result.skillReads.length, 5);
    assert.ok(result.skillReads.every((path: string) =>
      path.startsWith(join(result.skillSnapshot.path, "skills") + "/")));
    assert.deepEqual(readdirSync(root), ["creative-direction"]);
    assert.deepEqual(readdirSync(join(root, "creative-direction")), ["foundation.md"]);
    const source = readFileSync(result.artifact, "utf8");
    assert.match(source, /schema: '0.1'/);
    assert.match(source, /status: draft/);
    assert.match(source, /origin: user\n\s+authority: user-protected/);
    assert.match(source, /origin: agent\n\s+authority: delegated/);
    const duplicate = f.execute("demo-story", root, ["--fixture", "--task", "overwrite"]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /fresh empty Story directory/);
  }
  assert.equal(git(f.checkout, "status", "--porcelain"), before,
    "source checkout must not be modified by demo authoring");
});

test("certification: invalid Pi handoff, invalid updates and model errors never run a fallback worker", async () => {
  const project = { root: "/certification/fictional-project", id: "c".repeat(64) };
  for (const scenario of ["bad-route", "bad-note", "bad-tagline", "provider-failure"] as const) {
    const calls: string[] = [];
    const destination = scenario === "bad-tagline" || scenario === "provider-failure"
      ? DIRECT_WORKER_DESTINATION : WORKER_DESTINATION;
    const options: CoordinatorOptions = {
      project, task: "An isolated graph", provider: "test", model: "fixture", threadId: scenario,
      startPi: async () => {
        calls.push("coordinator");
        return { piSessionId: "same-original-session", handoff: {
          destination: scenario === "bad-route" ? "unauthorized-worker" : destination,
          brief: "A concise brief",
        } };
      },
      invokeWorker: async () => {
        calls.push("story-worker");
        return { piSessionId: "independent-worker-session",
          update: { storyNote: "valid", extra: "forbidden" } };
      },
      invokeDirectWorker: async () => {
        calls.push("direct-worker");
        if (scenario === "provider-failure") throw new Error("provider temporarily unavailable");
        return { update: { tagline: "", extra: "forbidden" } };
      },
      resumePi: async () => {
        calls.push("continuation");
        return { piSessionId: "same-original-session", response: "unexpected" };
      },
    };
    await assert.rejects(runCoordinator(options),
      scenario === "bad-route" ? /Invalid Pi handoff/ :
        scenario === "bad-note" ? /Invalid worker result/ :
          scenario === "bad-tagline" ? /Invalid direct worker result/ :
            /provider temporarily unavailable/);
    assert.deepEqual(calls, scenario === "bad-route" ? ["coordinator"] :
      ["coordinator", destination === WORKER_DESTINATION ? "story-worker" : "direct-worker"]);
  }
});
