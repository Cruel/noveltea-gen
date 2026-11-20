import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createControllerServer, SandboxController, type ControllerConfig } from "../web/src/sandbox-controller.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { collectRecoveryFork, prepareRecoveryFork } from "../src/recovery-fork.js";
import { forkSourceSummary } from "../src/recovery-fork-state.js";
import { sealReviewedOmissionBatch } from "../src/recovery-review-batch.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { compositionOptionalDialoguePolicy, parseSpecialistJson } from "../src/composition-specialist.js";
import { readEventOnlyOmission } from "../src/interactive-event-only.js";
import { runInteractiveWorkItem } from "../src/interactive-work.js";
import { reviewedAdaptiveOmissions } from "../src/adaptive-omission.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments,
  revalidateAdaptiveAmendment } from "../src/adaptive-assignments.js";
import { reconcileInventory, nextExecutionItem, type GenerationInventory } from "../src/generation-plan.js";
import { validateStoryJob } from "../src/validator.js";
import { auditCompositionPaths, optionalDialogueDeferralFeedback, selectAssignment,
  verifyCompositionProse, runCompositionWorkItem } from "../src/composition-work.js";

const root = mkdtempSync(join(tmpdir(), "nt-composition-"));
after(() => {
  if ((process.env.NT_LIVE_COMPOSITION === "1" || process.env.NT_LIVE_EVENT_ONLY === "1") &&
      process.env.NT_KEEP_FAILED_LIVE === "1") {
    process.stderr.write("Live composition fixtures preserved: " + root + "\n");
  } else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function setup(name: string, registered?: { repo: string; jobId: string; env: Record<string, string> }) {
  const repo = registered?.repo ?? join(root, name), story = join(repo, "story");
  const jobId = registered?.jobId ?? "draft";
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
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial Story");
  const original = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "missing-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
    ...registered?.env };
  function cli(args: string[], fixtureCase = "") {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", jobId], { encoding: "utf8",
      timeout: process.env.NT_LIVE_COMPOSITION === "1" || process.env.NT_LIVE_EVENT_ONLY === "1"
        ? 1_000_000 : 120_000,
      maxBuffer: 24 * 1024 * 1024, env: { ...env, NT_COMPOSITION_FIXTURE_CASE: fixtureCase,
        NT_ARCHITECTURE_FIXTURE_CASE: fixtureCase === "event-only" ? "event-only" : "",
        NT_INTERACTIVE_FIXTURE_CASE: fixtureCase,
        NT_EVENT_FIXTURE_CASE: fixtureCase === "event-only" ? "event-only" : "",
        NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE: process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE ?? "" } });
  }
  const cliAsync = async (args: string[], fixtureCase = "") => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", jobId], {
        env: { ...env, NT_COMPOSITION_FIXTURE_CASE: fixtureCase,
          NT_ARCHITECTURE_FIXTURE_CASE: fixtureCase === "event-only" ? "event-only" : "",
          NT_INTERACTIVE_FIXTURE_CASE: fixtureCase,
          NT_EVENT_FIXTURE_CASE: fixtureCase === "event-only" ? "event-only" : "" }, timeout: 1_000_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const [code] = await once(child, "close");
    return { status: code, stdout, stderr };
  };
  const start = cli(["start"]);
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout);
  const contract = join(root, name + "-contract.json");
  writeFileSync(contract, JSON.stringify({
    scope: { kind: "partial", depth: "composition",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["protect", "challenge"] },
    constraints: ["Confrontation and protection remain possible"],
    envelope: { presentation: "Visual novel", hardLimits: ["Reuse archive backdrop"],
      preferences: ["Two Characters"] },
  }));
  function prepare() {
    for (const args of [
      ["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source],
      ["foundations", "run", "--fixture", "--skills-source", source],
      ["event", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
      ["interactive", "run", "--fixture", "--milestone", "milestone.disclosure", "--skills-source", source],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 0, result.stderr);
    }
    return git(job.worktreeRoot, "rev-parse", "HEAD");
  }
  const seal = async (workItem: string) => {
    const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const current = await startStoryJob({ story, job: jobId }, false);
      const point = (await inspectRecoveryCheckpoints(current)).find(p => p.eligible && p.workItem === workItem);
      assert.ok(point?.assurance, "Missing fixture checkpoint " + workItem);
      if (point.semanticReview === "not-required") return;
      assert.equal(point.semanticReview, "required-pending");
      await reviewBoundedAssignments(current, [point], async packet => {
        if (workItem.startsWith("composition-")) {
          assert.match(packet.items[0]!.unitOutcome,
            /REVIEWED MILESTONE STAGE OBLIGATIONS/,
            "Composition postcommit reviewer must see the sealed local plan obligations.");
        }
        return ({ sourceDigest: packet.sourceDigest, verdict: "pass" as const, findings: [],
        evidence: packet.items.map(item => ({
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: item.assurance.changedPaths[0]!, line: 1,
          explanation: "Deterministic fixture: source- and native-validated prerequisite.",
        })),
      }); }, "deterministic-prerequisite-fixture", true);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const prepareWithOptionalPuzzle = async () => {
    const original = JSON.parse(readFileSync(contract, "utf8"));
    const full = { ...original,
      scope: { kind: "full-story", depth: original.scope.depth, targets: [], branches: [] } };
    writeFileSync(contract, JSON.stringify(full));
    saveFixtureTurn(job, full,
      "Make a fair-play mystery with meaningful choices and readable divergent endings.",
      ["Reachable Choice alternatives and earned narrative consequences.",
        "Independent clue and outcome continuity review across the available routes."]);
    const runStage = (stage: string, extra: string[] = [], variant = "") =>
      cli([stage, "run", "--fixture", ...extra, "--skills-source", source], variant);
    const arch = runStage("architecture", ["--contract", contract]);
    assert.equal(arch.status, 0, arch.stderr);
    await seal("global-architecture");
    const first = runStage("foundations");
    assert.notEqual(first.status, 0);
    await seal("world-foundations");
    const foundations = runStage("foundations");
    assert.equal(foundations.status, 0, foundations.stderr);
    await seal("character-foundations");
    const event = runStage("event", ["--milestone", "milestone.disclosure"]);
    assert.equal(event.status, 0, event.stderr);
    await seal("event-disclosure");
    const choice = runStage("interactive", ["--milestone", "milestone.disclosure"], "puzzle-no-write");
    assert.notEqual(choice.status, 0);
    await seal("interactive-choice-disclosure");
    const result = runStage("interactive", ["--milestone", "milestone.disclosure"], "puzzle-no-write");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).completionEvidence.puzzleDisposition, "not-applicable");
    return JSON.parse(result.stdout).headSha as string;
  };
  const prepareEventOnly = async (reviewer: "fixture" | "pi" = "fixture", probeOnly = false) => {
    const original = JSON.parse(readFileSync(contract, "utf8"));
    const full = { ...original, scope: { kind: "full-story", depth: "composition", targets: [], branches: [] } };
    writeFileSync(contract, JSON.stringify(full));
    saveFixtureTurn(job, full,
      "An observational mystery in which Ada discovers Neri concealed the missing witness transfer ledger and verifies the signed record.",
      ["Preserve the exact Event evidence, causal trust shift, and player-facing discovery without fabricating Choice or Puzzle work."]);
    const stage = (name: string, extra: string[] = []) =>
      cli([name, "run", "--fixture", ...extra, "--skills-source", source], "event-only");
    const arch = stage("architecture", ["--contract", contract]);
    assert.equal(arch.status, 0, arch.stderr);
    await seal("global-architecture");
    const first = stage("foundations");
    assert.notEqual(first.status, 0, "World writer must await its independent review");
    await seal("world-foundations");
    const foundations = stage("foundations");
    assert.equal(foundations.status, 0, foundations.stderr);
    await seal("character-foundations");
    const event = stage("event", ["--milestone", "milestone.disclosure"]);
    assert.equal(event.status, 0, event.stderr);
    await seal("event-disclosure");
    const before = git(job.worktreeRoot, "rev-parse", "HEAD");
    let disposition: any;
    if (probeOnly) {
      assert.equal(reviewer, "fixture");
      const old = Object.fromEntries([...Object.keys(env), "NT_INTERACTIVE_FIXTURE_CASE"]
        .map(key => [key, process.env[key]]));
      Object.assign(process.env, env);
      process.env.NT_INTERACTIVE_FIXTURE_CASE = "event-only";
      try {
        disposition = await runInteractiveWorkItem({ story, job: jobId,
          milestone: "milestone.disclosure", action: "review-omission",
          fixture: true, skillsSource: source });
      } finally {
        for (const [key, value] of Object.entries(old)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    } else {
      const interactive = reviewer === "fixture"
        ? stage("interactive", ["--milestone", "milestone.disclosure"])
        : await cliAsync(["interactive", "run", "--milestone", "milestone.disclosure",
          "--skills-source", source, "--provider", process.env.NT_PROVIDER ?? "openai",
          "--model", process.env.NT_MODEL ?? "gpt-6-luna"], "event-only");
      assert.equal(interactive.status, 0, interactive.stderr);
      disposition = JSON.parse(interactive.stdout);
    }
    assert.equal(disposition.completionEvidence.eventOnlyDisposition, "sealed-no-write");
    assert.equal(disposition.completionEvidence.eventOnlyReview,
      reviewer === "pi" ? "independent-pi" : "fixture-structural-only");
    assert.deepEqual(disposition.specialistUnits.map((unit: any) => unit.phase),
      ["not-applicable", "not-applicable"]);
    assert.equal(disposition.headSha, before);
    assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before,
      "Neither omitted specialist is allowed to create a fictitious Git commit");
    return { before, disposition };
  };
  const run = (variant = "") => cli(["composition", "run", "--fixture", "--milestone",
    "milestone.disclosure", "--skills-source", source], variant);
  const inspect = () => cli(["composition", "inspect", "--milestone", "milestone.disclosure"]);
  const recovery = async () => {
    const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      return await inspectRecoveryCheckpoints(await startStoryJob({ story, job: jobId }, false));
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  return { repo, original, job, cli, cliAsync, prepare, prepareWithOptionalPuzzle,
    prepareEventOnly, run, inspect, seal, recovery };
}

test("Event-only Composition defers optional testimony instead of fabricating Mara's response", () => {
  const conflict = "events/mara-brought-out.md describes optional accepted, refused and withdrawn " +
    "recovery conversations but declares no corresponding branches or account-receipt effects. " +
    "Authored the mandatory rescue and quiet recovery offer only; Mara's voucher-pretext and " +
    "reconciliation-demand testimony remains unwritten pending authorized routing.";
  const corrected = optionalDialogueDeferralFeedback({ eventOnly: true }, [conflict]);
  assert.match(corrected ?? "", /EVENT_ONLY_OPTIONAL_DIALOGUE/);
  assert.match(corrected ?? "", /laterObligations/);
  assert.match(corrected ?? "", /Do not impersonate consent/);
  assert.equal(optionalDialogueDeferralFeedback({ eventOnly: false }, [conflict]), null,
    "A required Choice branch may not be silently deferred");
  for (const blocker of [
    "Required testimony cannot be enacted: no corresponding branch or effect.",
    "A protected canon contradiction prevents the optional witness route.",
    "The rescue itself is unreachable, with missing necessary Event effects.",
  ]) {
    assert.equal(optionalDialogueDeferralFeedback({ eventOnly: true }, [blocker]), null, blocker);
  }
  const policy = compositionOptionalDialoguePolicy(true);
  assert.match(policy, /EVENT-ONLY SOURCE CONTRACT/);
  assert.match(policy, /unpressured offer ONLY/);
  assert.match(policy, /laterObligations/);
  assert.equal(compositionOptionalDialoguePolicy(false), "");
});

test("parses a complete nested manifest despite commentary or fenced JSON", () => {
  const manifest = JSON.stringify({ modifiedRecords: ["authored-content/disclosure.md"],
    architecturalConflicts: [], laterObligations: [{ kind: "prose", detail: 'quote "safe"' }] });
  const input = "Completed.\n\n" + "```json\n" + manifest + "\n```";
  assert.deepEqual(parseSpecialistJson(input).modifiedRecords, ["authored-content/disclosure.md"]);
  assert.equal(parseSpecialistJson('review: {"verdict":"pass","sourceEvidence":["event.x"],"concerns":[]}').verdict, "pass");
  assert.throws(() => parseSpecialistJson('No JSON was returned'), /no parseable JSON/);
});

test("composes two outcomes and two alternative puzzle endings into validated content and one isolated commit", { skip: !available }, () => {
  const x = setup("reference");
  const before = x.prepare();
  const run = x.run();
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.validation.protectionBase, before);
  assert.equal(result.validation.branchReview.status, "passed");
  assert.deepEqual(result.validation.branchReview.outcomes, ["challenge", "protect"]);
  assert.deepEqual(result.validation.branchReview.solutions,
    ["event.decode-ledger", "event.request-testimony"]);
  assert.ok(result.paths.some((p: string) => p.startsWith("authored-content/")));
  const body = readFileSync(join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md"), "utf8");
  for (const title of ["## Shared entry", "## Choice wording", "## Protect selected", "## Challenge selected"]) {
    assert.ok(body.includes(title), title);
  }
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"), before);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), result.headSha);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: composition-disclosure/);
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
  assert.equal(JSON.parse(x.inspect().stdout).headSha, result.headSha);
  assert.equal(JSON.parse(x.run().stdout).headSha, result.headSha);
});

test("Choice-only interactive source composes distinct prose without inventing Puzzle endings", { skip: !available }, async () => {
  const x = setup("choice-only-composition");
  const before = await x.prepareWithOptionalPuzzle();
  const composition = x.run();
  assert.equal(composition.status, 0, composition.stderr);
  const result = JSON.parse(composition.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.interactiveHead, before);
  assert.equal(result.validation.branchReview.status, "passed");
  assert.deepEqual(result.validation.branchReview.outcomes, ["challenge", "protect"]);
  assert.deepEqual(result.validation.branchReview.solutions, []);
  assert.ok(result.paths.some((p: string) => p === "authored-content/disclosure-scene.md"));
  const body = readFileSync(join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md"), "utf8");
  assert.match(body, /## Shared entry/);
  assert.match(body, /## Protect selected/);
  assert.match(body, /## Challenge selected/);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(JSON.parse(x.cli(["validate"]).stdout).status, "passed");
  assert.equal(JSON.parse(x.run().stdout).headSha, result.headSha);
  assert.equal(JSON.parse(x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]).stdout)
    .headSha, before);
  const points = await x.recovery();
  const checkpoint = points.find(point => point.workItem === "composition-disclosure");
  assert.ok(checkpoint?.eligible, checkpoint?.reason ?? "Composition recovery checkpoint missing");
  assert.deepEqual(checkpoint.omittedWorkItems?.map(item => item.workItem),
    ["interactive-puzzle-disclosure"]);
  assert.ok(!checkpoint.completedWorkItems.includes("interactive-puzzle-disclosure"),
    "A no-write decision must not masquerade as a completed Git commit");
  assert.ok(!checkpoint.remainingWorkItems.includes("interactive-puzzle-disclosure"));
  assert.ok(checkpoint.remainingWorkItems.includes("review"));
  assert.notEqual(checkpoint.nextWorkItem, "interactive-puzzle-disclosure");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
});

test("real independent Pi reviewer verifies an Event-only omission without dispatching Choice/Puzzle writers", {
  skip: process.env.NT_LIVE_EVENT_ONLY !== "1" ? "requires NT_LIVE_EVENT_ONLY=1" : false,
  timeout: 1_100_000,
}, async () => {
  const flags = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    encoding: "utf8",
  })) as string[];
  assert.ok(flags.some(flag => /(^|=)rootless$/.test(flag)),
    "Live Event-only review requires rootless Docker");
  assert.equal(execFileSync("docker", ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"], {
    encoding: "utf8",
  }).trim(), "2/systemd");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const owner = "event-only-cert-owner", providerRepo = "event-only-cert-repo";
  const jobId = randomUUID();
  const base = join(root, "live-event-only-host");
  const app = join(base, "app"), state = join(base, "state"),
    cache = join(base, "cache"), socketDir = join(base, "controller");
  const scoped = join(cache, sha(owner), sha("github:" + providerRepo));
  const repo = join(scoped, "base");
  for (const path of [app, state, cache, socketDir]) mkdirSync(path, { recursive: true });
  const token = randomBytes(48).toString("hex");
  const tokenFile = join(socketDir, "controller.token");
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  const config: ControllerConfig = {
    socket: join(socketDir, "controller.sock"), token,
    appVolume: app, stateVolume: state, cacheVolume: cache,
    containerState: state, containerCache: cache,
    image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
  };
  const x = setup("live-event-only", { repo, jobId, env: {
    NT_STATE_DIR: state, NT_GIT_CACHE_DIR: scoped,
    NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
    NT_REQUIRE_SANDBOX_TOOLS: "1",
  } });
  const db = new DatabaseSync(join(app, "studio.sqlite"));
  try {
    db.exec(`CREATE TABLE studio_sessions (id TEXT, owner_user_id TEXT, story_id TEXT, source_commit_sha TEXT, generation_config_json TEXT);
      CREATE TABLE stories (id TEXT, owner_user_id TEXT, repository_id TEXT, directory TEXT);
      CREATE TABLE repositories (id TEXT, owner_user_id TEXT, provider TEXT, provider_repository_id TEXT);`);
    db.prepare("INSERT INTO repositories VALUES (?,?,?,?)")
      .run("repo-id", owner, "github", providerRepo);
    db.prepare("INSERT INTO stories VALUES (?,?,?,?)")
      .run("story-id", owner, "repo-id", "story");
    db.prepare("INSERT INTO studio_sessions VALUES (?,?,?,?,?)")
      .run(jobId, owner, "story-id", x.original, null);
  } finally { db.close(); }
  const controller = new SandboxController(config);
  const server = createControllerServer(controller);
  try {
    server.listen(config.socket);
    await once(server, "listening");
    const { before, disposition } = await x.prepareEventOnly("pi");
  assert.equal(disposition.headSha, before);
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  const proof = JSON.parse(readFileSync(join(x.job.stateDir,
    "interactive-event-only/disclosure.json"), "utf8")).payload;
  assert.equal(proof.reviewMode, "pi");
  assert.ok(proof.reviewerSnapshotId);
  assert.ok(proof.reviewerSessionSha256);
  assert.ok(proof.evidence.some((line: string) => line.includes("milestones/disclosure.md:")));
  assert.ok(proof.evidence.some((line: string) => line.includes("events/disclose-ledger.md:")));
  const messages = readFileSync(proof.reviewerSession, "utf8").trim().split("\n").map(JSON.parse);
  const calls = messages.flatMap((entry: any) => entry.message?.content ?? [])
    .filter((call: any) => call.type === "toolCall");
  assert.ok(calls.some((call: any) => call.name === "read" &&
    String(call.arguments?.path).includes("nt-narrative-review/SKILL.md")));
  assert.ok(!calls.some((call: any) => ["write", "edit", "bash"].includes(call.name)));
  const repeat = await x.cliAsync(["interactive", "run", "--milestone", "milestone.disclosure",
    "--skills-source", source, "--provider", process.env.NT_PROVIDER ?? "openai",
    "--model", process.env.NT_MODEL ?? "gpt-6-luna"], "event-only");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).headSha, before);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), before);

  // Follow the exact production adaptive admission seam with the real Pi
  // review, not a fabricated positive proof or a fixture-only reviewer.
  const arch = JSON.parse(readFileSync(join(x.job.stateDir, "architecture.json"), "utf8")).plan;
  const validation = await validateStoryJob(x.job, source, { ...x.job, baseSha: before });
  assert.equal(validation.status, "passed", JSON.stringify(validation.report?.diagnostics));
  const canonical = (validation.report as { records: Array<{ path: string; metadata: {
    id: string; type: string; status: string; decisions?: unknown[] } }> }).records;
  const hashes = Object.fromEntries(canonical.map(record => [record.path,
    sha(readFileSync(join(x.job.worktreeStoryRoot, record.path)))]));
  const inventory = reconcileInventory(arch, validation, before, [
    { stage: "foundation", headSha: before, status: "committed" },
    { stage: "architecture", headSha: before, status: "architecture-committed" },
    { stage: "foundations", headSha: before, status: "foundations-committed" },
    { stage: "event", milestone: "milestone.disclosure", headSha: before,
      status: "event-cluster-committed" },
  ], {});
  const target = "interactive:milestone.disclosure";
  assert.equal(inventory.items.find(item => item.id === target)?.status, "pending");
  const interactiveReceipt = JSON.parse(readFileSync(join(x.job.stateDir,
    "interactive-items/disclosure.json"), "utf8"));
  const reviewedOptions = {
    job: x.job, request: { story: x.story, job: x.job.jobId,
      task: "An observational ledger discovery", contract: arch.contract, fixture: false },
    inventory, records: canonical, sourceHashes: hashes, saved: [], allowReview: true,
    authorTargets: [], protectedPaths: canonical.filter(record =>
      record.metadata.type === "creative-direction" || record.metadata.decisions?.length)
      .map(record => record.path),
    // The fixture's observational Turn has no mandatory per-Milestone Choice;
    // this admission exercises the no-Choice profile without claiming to grade it.
    planning: { choice_frequency: "none" as const, puzzle_emphasis: "none" as const },
    planDigest: interactiveReceipt.planDigest as string,
  };
  const acceptedProofs = await reviewedAdaptiveOmissions(reviewedOptions);
  assert.equal(acceptedProofs.length, 1);
  assert.equal(acceptedProofs[0]!.sourceSha, before);
  assert.equal(acceptedProofs[0]!.reviewerSession, proof.reviewerSession);
  assert.ok(acceptedProofs[0]!.eventOnly);
  const order = inventory.items.filter(item => item.status === "pending" && item.id !== target)
    .map(item => item.id);
  const proposal = {
    sourceSha: before, turnDigest: proof.turnDigest as string, beforeVersion: 1,
    reason: "The independent Event-only review found this scene observational",
    actions: [{ kind: "omit" as const, item: target }], order,
  };
  const admission = {
    proposal, inventory, plan: arch, turnDigest: proof.turnDigest as string,
    version: 1, verifiedSource: true, records: canonical, sourceHashes: hashes,
    milestoneSourceHashes: hashes, protectedPaths: reviewedOptions.protectedPaths,
    planning: reviewedOptions.planning, typedEdges: [], authorTargets: [],
    carried: inventory.items.filter(item => item.status === "verified")
      .map(item => ({ id: item.id, sha: item.verifiedSha! })),
    omissionProofs: acceptedProofs,
  };
  const amendment = admitAdaptiveAssignments(admission);
  const applied = applyAdaptiveAssignments(inventory, amendment);
  const omitted = applied.items.find(item => item.id === target)!;
  assert.equal(omitted.status, "verified");
  assert.equal(omitted.verifiedSha, before, "the omission is not a writer commit");
  assert.equal(applied.items.find(item => item.id === "review")?.status, "pending");
  assert.equal(nextExecutionItem(applied)?.stage, "composition");
  const composed = x.run("event-only");
  assert.equal(composed.status, 0, composed.stderr);
  assert.equal(JSON.parse(composed.stdout).status, "composition-committed");
  const advanced = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(advanced, before);
  // After a validated independent descendant advances HEAD, the original
  // reviewed source and reviewer session are retained without a new Pi call.
  const descendantValidation = await validateStoryJob(x.job, source, {
    ...x.job, baseSha: advanced });
  assert.equal(descendantValidation.status, "passed");
  const descendantRecords = (descendantValidation.report as { records: typeof canonical }).records;
  const descendantHashes = Object.fromEntries(descendantRecords.map(record => [record.path,
    sha(readFileSync(join(x.job.worktreeStoryRoot, record.path)))]));
  const recoveredProofs = await reviewedAdaptiveOmissions({
    ...reviewedOptions, inventory: { ...inventory, headSha: advanced },
    records: descendantRecords, sourceHashes: descendantHashes,
    saved: acceptedProofs, allowReview: false,
  });
  assert.deepEqual(recoveredProofs, acceptedProofs);
  const descendantInventory = structuredClone(inventory);
  descendantInventory.headSha = advanced;
  const composition = descendantInventory.items.find(item =>
    item.id === "composition:milestone.disclosure")!;
  composition.status = "verified"; composition.verifiedSha = advanced;
  assert.equal(revalidateAdaptiveAmendment(amendment, { ...admission,
    inventory: descendantInventory, sourceHashes: descendantHashes,
    records: descendantRecords, carried: descendantInventory.items.filter(item =>
      item.status === "verified").map(item => ({ id: item.id, sha: item.verifiedSha! })),
    authenticatedProofAncestors: [before], omissionProofs: recoveredProofs,
  }).inventory.items.find(item => item.id === target)?.verifiedSha, before);
  await assert.rejects(reviewedAdaptiveOmissions({
    ...reviewedOptions, inventory: descendantInventory,
    records: [...descendantRecords, { path: "choice-points/new-local.md", metadata: {
      id: "choice-point.new-local", type: "choice-point", status: "draft",
      events: proof.eventIds } }],
    sourceHashes: descendantHashes, saved: acceptedProofs, allowReview: false,
  }), /newly linked Choice\/Puzzle.*reassessment/,
  "newly related mechanics invalidate the exact omission without re-reviewing unrelated work");
  } finally {
    await controller.dispose(jobId);
    await new Promise<void>(done => server.close(() => done()));
  }
});

/** Reinspect one real paid reviewer checkpoint without re-running its Pi turn.
 * Only explicit private local opt-in roots are read; never copy historical job state. */
test("preserved live Event-only review survives a process restart without replaying the model", {
  skip: !process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT
    ? "set NT_PRESERVED_LIVE_EVENT_ONLY_ROOT to a saved live fixture root" : false,
}, () => {
  const saved = process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT!;
  const host = join(saved, "live-event-only-host");
  const state = join(host, "state");
  const jobs = readdirSync(join(state, "jobs"));
  assert.equal(jobs.length, 1, "A preserved certification root must select exactly one Job");
  const jobState = join(state, "jobs", jobs[0]!);
  const job = JSON.parse(readFileSync(join(jobState, "job.json"), "utf8"));
  const proof = JSON.parse(readFileSync(join(jobState,
    "interactive-event-only/disclosure.json"), "utf8")).payload;
  assert.equal(proof.reviewMode, "pi");
  git(job.worktreeRoot, "merge-base", "--is-ancestor", proof.reviewHead, "HEAD");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  const messages = readFileSync(proof.reviewerSession, "utf8").trim().split("\n").map(JSON.parse);
  const calls = messages.flatMap((entry: any) => entry.message?.content ?? [])
    .filter((call: any) => call.type === "toolCall");
  assert.ok(calls.some((call: any) => call.name === "read" &&
    String(call.arguments?.path).includes("nt-narrative-review/SKILL.md")));
  assert.ok(!calls.some((call: any) => ["write", "edit", "bash"].includes(call.name)));
  assert.ok(proof.evidence.some((line: string) => line.includes("milestones/disclosure.md:")));
  assert.ok(proof.evidence.some((line: string) => line.includes("events/disclose-ledger.md:")));
  for (const action of ["inspect", "run"]) {
    const result = spawnSync(process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "job", "interactive", action,
        "--milestone", "milestone.disclosure", "--story", job.storyRoot, "--job", job.jobId,
        ...(action === "run" ? ["--skills-source", source] : [])], {
        encoding: "utf8", timeout: 120_000,
        env: { ...process.env, NT_STATE_DIR: state,
          NT_GIT_CACHE_DIR: dirname(dirname(job.storyRoot)),
          NT_SKILL_CACHE_DIR: join(saved, "skills"),
          NT_CONFIG_FILE: join(saved, "missing-config.json"),
          NT_SANDBOX_SOCKET: "", NT_SANDBOX_TOKEN_FILE: "" },
      });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "interactive-slice-committed");
    assert.equal(output.headSha, proof.reviewHead);
    assert.equal(output.completionEvidence.eventOnlyReview, "independent-pi");
    assert.deepEqual(output.specialistUnits.map((unit: any) => unit.phase),
      ["not-applicable", "not-applicable"]);
  }
  git(job.worktreeRoot, "merge-base", "--is-ancestor", proof.reviewHead, "HEAD");
});

test("opt-in real Pi Composition and independent review resume a preserved Event-only checkpoint", {
  skip: process.env.NT_LIVE_EVENT_ONLY_COMPOSITION !== "1" ||
    !process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT
    ? "requires NT_LIVE_EVENT_ONLY_COMPOSITION=1 and NT_PRESERVED_LIVE_EVENT_ONLY_ROOT" : false,
  timeout: 1_100_000,
}, async () => {
  const saved = process.env.NT_PRESERVED_LIVE_EVENT_ONLY_ROOT!;
  const host = join(saved, "live-event-only-host");
  const state = join(host, "state");
  const jobs = readdirSync(join(state, "jobs"));
  assert.equal(jobs.length, 1);
  const job = JSON.parse(readFileSync(join(state, "jobs", jobs[0]!, "job.json"), "utf8"));
  const tokenFile = join(host, "controller/controller.token");
  const config: ControllerConfig = {
    socket: join(host, "controller/composition.sock"),
    token: readFileSync(tokenFile, "utf8").trim(),
    appVolume: join(host, "app"), stateVolume: state, cacheVolume: join(host, "cache"),
    containerState: state, containerCache: join(host, "cache"),
    image: process.env.NT_TEST_SANDBOX_IMAGE ?? "noveltea-sandbox:local",
  };
  const controller = new SandboxController(config);
  const server = createControllerServer(controller);
  const env = { ...process.env, NT_STATE_DIR: state,
    NT_GIT_CACHE_DIR: dirname(dirname(job.storyRoot)),
    NT_SKILL_CACHE_DIR: join(saved, "skills"),
    NT_CONFIG_FILE: join(saved, "missing-config.json"),
    NT_SANDBOX_SOCKET: config.socket, NT_SANDBOX_TOKEN_FILE: tokenFile,
    NT_REQUIRE_SANDBOX_TOOLS: "1" };
  const cli = async (action: "run" | "inspect") => {
    const args = ["--import", "tsx", resolve("src/cli.ts"), "job", "composition", action,
      "--milestone", "milestone.disclosure", "--skills-source", source,
      "--story", job.storyRoot, "--job", job.jobId];
    if (action === "run") args.push("--provider", process.env.NT_PROVIDER ?? "openai",
      "--model", process.env.NT_MODEL ?? "gpt-6-luna");
    const child = spawn(process.execPath, args, { env, timeout: 1_000_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr || stdout);
    return JSON.parse(stdout);
  };
  try {
    server.listen(config.socket);
    await once(server, "listening");
    const before = git(job.worktreeRoot, "rev-parse", "HEAD");
    const composed = await cli("run");
    assert.equal(composed.status, "composition-committed");
    assert.equal(composed.interactiveHead, before);
    assert.equal(composed.validation.branchReview.reviewer, "independent-pi");
    assert.deepEqual(composed.validation.branchReview.outcomes, []);
    assert.deepEqual(composed.validation.branchReview.solutions, []);
    assert.ok(composed.paths.some((path: string) => path.startsWith("authored-content/")));
    assert.equal(composed.headSha, git(job.worktreeRoot, "rev-parse", "HEAD"));
    assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
    assert.equal((await cli("inspect")).headSha, composed.headSha);
  } finally {
    await controller.dispose(job.jobId);
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("Event-only Milestone composes playable evidence with two genuine no-write omissions and recoverable provenance", { skip: !available }, async () => {
  const x = setup("event-only-composition");
  const { before, disposition } = await x.prepareEventOnly();
  assert.equal(disposition.specialistUnits[0].eventOnly.digest,
    disposition.specialistUnits[1].eventOnly.digest);
  const proofFile = join(x.job.stateDir, "interactive-event-only/disclosure.json");
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  assert.equal(proof.payload.decision, "event-only");
  assert.equal(proof.payload.eventHead, before);
  assert.equal(proof.payload.reviewHead, before);
  assert.equal(proof.payload.reviewerSession, null, "Fixture cannot claim real Pi review");
  assert.equal(JSON.parse(x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]).stdout)
    .headSha, before);
  const composition = x.run("event-only");
  assert.equal(composition.status, 0, composition.stderr);
  const result = JSON.parse(composition.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.interactiveHead, before);
  assert.deepEqual(result.validation.branchReview.outcomes, []);
  assert.deepEqual(result.validation.branchReview.solutions, []);
  assert.match(readFileSync(join(x.job.worktreeStoryRoot, "authored-content/disclose-ledger-scene.md"), "utf8"),
    /observational|discovery|witness|evidence/i);
  assert.equal(JSON.parse(x.run("event-only").stdout).headSha, result.headSha);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD^"), before);
  assert.equal(git(x.job.worktreeRoot, "log", "-1", "--format=%B").includes("NovelTea-Work-Item: composition-disclosure"), true);
  const checkpoint = (await x.recovery()).find(point => point.workItem === "composition-disclosure");
  assert.ok(checkpoint?.eligible, checkpoint?.reason ?? "Missing Event-only recovery checkpoint");
  assert.deepEqual(checkpoint.omittedWorkItems?.map(entry => entry.workItem),
    ["interactive-choice-disclosure", "interactive-puzzle-disclosure"]);
  assert.ok(!checkpoint.completedWorkItems.includes("interactive-choice-disclosure"));
  assert.ok(!checkpoint.completedWorkItems.includes("interactive-puzzle-disclosure"));
  assert.ok(!checkpoint.remainingWorkItems.includes("interactive-choice-disclosure"));
  assert.ok(!checkpoint.remainingWorkItems.includes("interactive-puzzle-disclosure"));
  assert.ok(checkpoint.remainingWorkItems.includes("review"));
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
});

test("omission-only production preflight seals both interactive dispositions without invoking writers, but fixture review cannot authorize a live plan", { skip: !available }, async () => {
  const x = setup("adaptive-omission-probe");
  const { before, disposition } = await x.prepareEventOnly("fixture", true);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(disposition.completionEvidence.eventOnlyDisposition, "sealed-no-write");
  const resumed = x.cli(["interactive", "run", "--fixture", "--milestone",
    "milestone.disclosure", "--skills-source", source], "event-only");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).headSha, before);
  const path = "milestones/disclosure.md";
  const sourceHash = createHash("sha256")
    .update(readFileSync(join(x.job.worktreeStoryRoot, path))).digest("hex");
  const original = disposition.specialistUnits[0].eventOnly;
  const evidence = {
    assignmentId: "interactive:milestone.disclosure", sourceSha: before, path, sourceHash,
    evidence: path + ":12 untrusted fixture assertion",
    reviewerSession: "/private/fixture.jsonl", reviewerSnapshot: "f".repeat(64),
    eventOnly: original,
  };
  await assert.rejects(reviewedAdaptiveOmissions({
    job: x.job, request: { story: x.job.storyRoot, job: x.job.jobId, task: "Observe",
      fixture: false, contract: { scope: { kind: "full-story", depth: "composition",
        targets: [], branches: [] }, constraints: [], envelope: {
          presentation: "visual novel", hardLimits: [], preferences: [] } } },
    inventory: { version: 1, planVersion: 1, headSha: before, rationale: "",
      items: [] }, records: [{ path, metadata: {
        id: "milestone.disclosure", type: "milestone", status: "approved" } }],
    sourceHashes: { [path]: sourceHash }, saved: [evidence],
    allowReview: false, authorTargets: [], protectedPaths: [],
    planning: { choice_frequency: "none", puzzle_emphasis: "none" },
    planDigest: JSON.parse(readFileSync(join(x.job.stateDir,
      "interactive-items/disclosure.json"), "utf8")).planDigest,
  }), /omission|review|provenance/i,
  "fixture-only no-write may certify structure but never claim a live independent Pi review");
  const composition = x.run("event-only");
  assert.equal(composition.status, 0, composition.stderr);
  assert.equal(JSON.parse(composition.stdout).status, "composition-committed");
});

test("Event-only omission rejects modified sealed proof and cannot replay an interrupted reviewer", { skip: !available }, async () => {
  const x = setup("event-only-tamper");
  await x.prepareEventOnly();
  const proofFile = join(x.job.stateDir, "interactive-event-only/disclosure.json");
  const saved = readFileSync(proofFile, "utf8");
  const proof = JSON.parse(saved);
  proof.payload.eventHead = "0".repeat(40);
  writeFileSync(proofFile, JSON.stringify(proof));
  const inspect = x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]);
  assert.notEqual(inspect.status, 0);
  assert.match(inspect.stderr, /omission|digest|source|Event-only/i);
  writeFileSync(proofFile, saved);
  const restored = x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(restored.status, 0, restored.stderr);
  writeFileSync(proofFile, JSON.stringify({ phase: "reviewing", eventHead: proof.payload.eventHead }));
  const blocked = x.cli(["interactive", "run", "--fixture", "--milestone", "milestone.disclosure",
    "--skills-source", source], "event-only");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /omission|controller|review/i);
});

test("Event-only proof rejects foreign Thread, validator/snapshot changes and a dirty original Event", { skip: !available }, async () => {
  const x = setup("event-only-stale");
  const { disposition } = await x.prepareEventOnly();
  const ref = disposition.specialistUnits[0].eventOnly;
  const proof = JSON.parse(readFileSync(join(x.job.stateDir, "interactive-event-only/disclosure.json"), "utf8")).payload;
  const original = await readEventOnlyOmission(x.job, "milestone.disclosure", ref);
  assert.equal(original.turnDigest, proof.turnDigest);
  await assert.rejects(readEventOnlyOmission(
    { ...x.job, threadId: "foreign-thread" }, "milestone.disclosure", ref),
    /identity|source|validator/, "A fork must not inherit the parent's no-write approval");
  await assert.rejects(readEventOnlyOmission(
    { ...x.job, validatorVersion: "999.0.0" }, "milestone.disclosure", ref),
    /validator/, "Validator identity must remain pinned");
  await assert.rejects(readEventOnlyOmission(x.job, "milestone.disclosure", ref, {
    eventHead: proof.eventHead, planDigest: proof.planDigest,
    eventSnapshotId: "f".repeat(64), validatorVersion: proof.validatorVersion,
  }), /identity|source|validator/, "Changed Event skill snapshot invalidates an old omission");
  const path = join(x.job.worktreeStoryRoot, "events/disclose-ledger.md");
  const bytes = readFileSync(path, "utf8");
  writeFileSync(path, bytes + "\\nUnreviewed source material.\\n");
  await assert.rejects(readEventOnlyOmission(x.job, "milestone.disclosure", ref),
    /canonical evidence changed/, "A source mutation invalidates a previously reviewed omission");
  const run = x.cli(["composition", "run", "--fixture", "--milestone", "milestone.disclosure",
    "--skills-source", source], "event-only");
  assert.notEqual(run.status, 0, "Composition may not proceed from a dirty Event source");
});

test("Event-only recovery refuses a changed original Event skill snapshot", { skip: !available }, async () => {
  const x = setup("event-only-snapshot-drift");
  await x.prepareEventOnly();
  const result = x.run("event-only");
  assert.equal(result.status, 0, result.stderr);
  const before = (await x.recovery()).find(point => point.workItem === "composition-disclosure");
  assert.ok(before?.eligible);
  const sourceFile = join(x.job.stateDir, "event-items/disclosure.json");
  const sourceReceipt = JSON.parse(readFileSync(sourceFile, "utf8"));
  sourceReceipt.snapshot.id = "f".repeat(64);
  writeFileSync(sourceFile, JSON.stringify(sourceReceipt));
  const after = (await x.recovery()).find(point => point.commitSha === before.commitSha);
  assert.ok(after && !after.eligible, "Recovery must not preserve a sealed omission after Event skill pin drift");
  assert.match(after.reason ?? "", /Event-only|event|snapshot|source|recovery/i);
});

test("Event-only fork admission fails before child allocation rather than losing no-write proofs", { skip: !available }, async () => {
  const x = setup("event-only-fork");
  await x.prepareEventOnly();
  const result = x.run("event-only");
  assert.equal(result.status, 0, result.stderr);
  const checkpoint = (await x.recovery()).find(point =>
    point.workItem === "composition-disclosure");
  assert.ok(checkpoint?.eligible);
  const architecture = JSON.parse(readFileSync(join(x.job.stateDir, "architecture.json"), "utf8"));
  await assert.rejects(
    collectRecoveryFork(x.job, "a2df21df-67bf-430a-afae-07c0b4ee07c3",
      checkpoint.commitSha, architecture.plan.contract, source),
    /Event-only omissions|cannot inherit.*no-write|omission/i,
    "A child must not inherit skipped assignments without their original source-bound review");
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
});

test("a reviewed no-write batch survives a same-Thread fork without a Git commit or reviewer replay",
  { skip: !available, timeout: 160_000 }, async () => {
    const x = setup("review-batch-handoff");
    const { before } = await x.prepareEventOnly();
    const env = { NT_STATE_DIR: join(root, "review-batch-handoff-state"),
      NT_CONFIG_FILE: join(root, "missing-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills") };
    const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      const parent = await startStoryJob({ story: x.job.storyRoot, job: x.job.jobId }, false);
      const checkpoint = (await inspectRecoveryCheckpoints(parent))
        .find(point => point.eligible && point.workItem === "event-disclosure");
      assert.ok(checkpoint?.eligible);
      assert.equal(checkpoint.commitSha, before);
      const branchBefore = git(parent.worktreeRoot, "rev-parse", "HEAD");
      await sealReviewedOmissionBatch(parent, checkpoint, {
        items: [{ stage: "interactive", milestone: "milestone.disclosure",
          status: "verified", omission: { reason: "Source-bound observational milestone",
            evidence: "reviewed", reviewerSession: "fixture" } }],
      } as GenerationInventory);
      assert.equal(git(parent.worktreeRoot, "rev-parse", "HEAD"), branchBefore,
        "The review batch must not manufacture a Git commit");
      const plan = JSON.parse(readFileSync(join(parent.stateDir, "architecture.json"), "utf8")).plan;
      const markers = join(parent.stateDir, "recovery-review-batches");
      const markerPath = join(markers, readdirSync(markers)[0]!);
      const marker = readFileSync(markerPath, "utf8");
      const tampered = JSON.parse(marker);
      tampered.milestones = [];
      writeFileSync(markerPath, JSON.stringify(tampered));
      await assert.rejects(collectRecoveryFork(parent,
        "6575baa6-f069-4bfb-9ea1-a8d88f344c0f", checkpoint.commitSha,
        plan.contract, source, "same-thread"),
        /Saved review-batch boundary was tampered/,
        "A mutated review-batch marker cannot authorize a continuation");
      writeFileSync(markerPath, marker);
      const startedReviewPath = join(parent.stateDir, "interactive-event-only", "interrupted.json");
      writeFileSync(startedReviewPath, JSON.stringify({
        phase: "reviewing", eventHead: before, milestone: "milestone.interrupted",
      }));
      await assert.rejects(collectRecoveryFork(parent,
        "a824c819-6fc6-4945-89c1-82c67e5eab73", checkpoint.commitSha,
        plan.contract, source, "same-thread"),
        /Interrupted independent Event-only review must be reconciled/,
        "A half-finished independent reviewer may never be silently repeated");
      unlinkSync(startedReviewPath);
      const childId = "116d1c99-1498-4f9b-a9f6-c800d080b7ba";
      const bundle = await collectRecoveryFork(parent, childId, checkpoint.commitSha,
        plan.contract, source, "same-thread");
      assert.deepEqual(bundle.reviewBatch?.entries.map(entry => entry.milestoneId),
        ["milestone.disclosure"]);
      assert.ok(bundle.completedStages.some(entry => entry.stage === "interactive" &&
        entry.milestone === "milestone.disclosure" &&
        entry.status === "interactive-slice-committed"));
      const child = await prepareRecoveryFork(parent, bundle);
      const saved = JSON.parse(readFileSync(join(child.stateDir, "interactive-items/disclosure.json"), "utf8"));
      assert.equal(saved.units[0].phase, "not-applicable");
      assert.deepEqual(saved.units[0].eventOnly, saved.units[1].eventOnly);
      const original = await readEventOnlyOmission(child,
        "milestone.disclosure", saved.units[0].eventOnly);
      assert.equal(original.reviewHead, before);
      assert.equal(original.jobId, childId);
      const summary = forkSourceSummary(child);
      assert.ok(summary && !summary.remainingWorkItems.includes("interactive-choice-disclosure"));
      assert.equal(summary?.nextWorkItem, "composition-disclosure", JSON.stringify({
        completed: bundle.checkpoint.completedWorkItems,
        remaining: summary?.remainingWorkItems,
        dependencies: bundle.checkpoint.dependencies,
      }));
      // The incoming Git anchor must also be eligible when this child has
      // completed only no-write reviews (zero native checkpoints of its own).
      const nested = await collectRecoveryFork(child,
        "8123d504-ad46-4a7e-8677-f79ec1cc7647", before,
        plan.contract, source, "same-thread");
      assert.deepEqual(nested.reviewBatch?.entries.map(entry => entry.milestoneId),
        ["milestone.disclosure"]);
      const composed = await runCompositionWorkItem({
        story: child.storyRoot, job: child.jobId, action: "run",
        milestone: "milestone.disclosure", fixture: true, skillsSource: source,
      });
      assert.equal(composed.status, "composition-committed");
      const composedPoint = (await inspectRecoveryCheckpoints(child)).find(point =>
        point.eligible && point.workItem === "composition-disclosure" &&
        point.omittedWorkItems?.some(entry => entry.workItem === "interactive-choice-disclosure"));
      assert.ok(composedPoint);
      const afterComposition = await collectRecoveryFork(child,
        "0b87445f-184c-46be-a987-ddf22c526018", composedPoint.commitSha,
        plan.contract, source, "same-thread");
      assert.deepEqual(afterComposition.reviewBatch?.entries.map(entry => entry.milestoneId),
        ["milestone.disclosure"],
        "A later Git checkpoint must retain the earlier reviewed omission");
      const grandchild = await prepareRecoveryFork(child, afterComposition);
      const grandchildReceipt = JSON.parse(readFileSync(join(grandchild.stateDir,
        "interactive-items/disclosure.json"), "utf8"));
      assert.equal((await readEventOnlyOmission(grandchild,
        "milestone.disclosure", grandchildReceipt.units[0].eventOnly)).eventHead,
        original.eventHead, "Multi-hop continuation must preserve original Event provenance");
      await assert.rejects(collectRecoveryFork(child,
        "cfcc4427-0b2c-45b0-9c5c-488e2103b1e4", composedPoint.commitSha,
        plan.contract, source, "isolated"), /Event-only omissions|isolated fork/,
        "An isolated historical Thread must not inherit source-bound no-write reviews");

      const proofPath = join(child.stateDir, "interactive-event-only/disclosure.json");
      const sealed = readFileSync(proofPath, "utf8");
      const corrupt = JSON.parse(sealed);
      corrupt.inherited.sourcePayloadDigest = "0".repeat(64);
      writeFileSync(proofPath, JSON.stringify(corrupt));
      await assert.rejects(readEventOnlyOmission(child,
        "milestone.disclosure", saved.units[0].eventOnly),
        /Inherited Event-only review/, "Tampered provenance cannot be reused");
      writeFileSync(proofPath, sealed);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

test("a newly linked formal Choice invalidates the Event-only Composition exemption", { skip: !available }, async () => {
  const x = setup("event-only-late-choice");
  await x.prepareEventOnly();
  const native = JSON.parse(x.cli(["validate"]).stdout).report;
  const source = JSON.parse(readFileSync(join(x.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
  const event = JSON.parse(readFileSync(join(x.job.stateDir, "event-items/disclosure.json"), "utf8"));
  const architecture = JSON.parse(readFileSync(join(x.job.stateDir, "architecture.json"), "utf8"));
  const altered = { ...native, records: [...native.records, {
    path: "choice-points/late-branch.md",
    metadata: { id: "choice-point.late-branch", type: "choice-point", status: "draft",
      events: ["event.disclose-ledger"], outcomes: ["protect", "challenge"] },
  }] };
  assert.throws(() => selectAssignment(architecture.plan, altered, source, event, "milestone.disclosure"),
    /stale: a linked Choice or Puzzle/);
});

test("composition audit accepts unstaged edits to assigned prose but rejects staged or canonical changes",
  { skip: !available }, async () => {
    const x = setup("existing-prose-audit");
    x.prepare();
    const run = x.run();
    assert.equal(run.status, 0, run.stderr);
    const validation = x.cli(["validate"]);
    assert.equal(validation.status, 0, validation.stderr);
    const report = JSON.parse(validation.stdout).report;
    const architecture = JSON.parse(x.cli(["architecture", "inspect"]).stdout);
    const dir = x.job.stateDir;
    const interactive = JSON.parse(readFileSync(join(dir, "interactive-items/disclosure.json"), "utf8"));
    const event = JSON.parse(readFileSync(join(dir, "event-items/disclosure.json"), "utf8"));
    const assignment = selectAssignment(architecture.plan, report, interactive, event, "milestone.disclosure");
    const path = "authored-content/disclosure-scene.md";
    assert.ok(assignment.allowedExistingContent.includes(path));

    // The first Git porcelain entry begins with a meaningful space: " M".
    const full = join(x.job.worktreeStoryRoot, path);
    writeFileSync(full, readFileSync(full, "utf8") + "\nA later quiet exchange.\n");
    assert.deepEqual(await auditCompositionPaths(x.job, assignment, [path]), [path]);
    git(x.job.worktreeRoot, "add", "story/" + path);
    await assert.rejects(auditCompositionPaths(x.job, assignment, [path]),
      /staged\/removed\/renamed/, "A staged modification must still fail closed");
    git(x.job.worktreeRoot, "reset", "--", "story/" + path);
    const canon = join(x.job.worktreeStoryRoot, "creative-direction/foundation.md");
    writeFileSync(canon, readFileSync(canon, "utf8") + "\nUnauthorized change.\n");
    await assert.rejects(auditCompositionPaths(x.job, assignment, [path]),
      /Unauthorized composition edit/, "Non-prose canon must stay read-only");
  });

test("scoped prose revision may reuse other fully composed Event content", { skip: !available }, async () => {
  const x = setup("existing-composition");
  x.prepare();
  const original = x.run();
  assert.equal(original.status, 0, original.stderr);
  const validation = x.cli(["validate"]);
  assert.equal(validation.status, 0, validation.stderr);
  const report = JSON.parse(validation.stdout).report;
  const architecture = JSON.parse(x.cli(["architecture", "inspect"]).stdout);
  const dir = x.job.stateDir;
  const interactive = JSON.parse(readFileSync(join(dir, "interactive-items/disclosure.json"), "utf8"));
  const event = JSON.parse(readFileSync(join(dir, "event-items/disclosure.json"), "utf8"));
  const assignment = selectAssignment(architecture.plan, report, interactive, event, "milestone.disclosure");
  assert.ok(assignment.allowedExistingContent.length > 1);
  const changedPath = "authored-content/disclosure-scene.md";
  const originalText = readFileSync(join(x.job.worktreeStoryRoot, changedPath), "utf8");
  writeFileSync(join(x.job.worktreeStoryRoot, changedPath), originalText + "\nA more restrained response closes the scene.\n");
  const checked = await verifyCompositionProse(x.job, report, assignment, [changedPath]);
  assert.ok(checked.outcomes.length >= 2);
  assert.ok(checked.solutions.length >= 2);
  // Real Pi authors sometimes use canonical Choice outcome IDs rather than
  // display names as section headings and selectable labels. Both are
  // unambiguous; neither invents a new Story option.
  const slugged = originalText
    .replace("## Protect selected", "## protect selected")
    .replace("## Challenge selected", "## challenge selected")
    .replace(/^\*\*Protect:\*\*.*$/m, "- protect")
    .replace(/^\*\*Challenge:\*\*.*$/m, "- challenge");
  writeFileSync(join(x.job.worktreeStoryRoot, changedPath), slugged);
  const stillValid = await verifyCompositionProse(x.job, report, assignment, [changedPath]);
  assert.deepEqual(stillValid.outcomes.sort(), ["challenge", "protect"]);
  writeFileSync(join(x.job.worktreeStoryRoot, changedPath),
    slugged.replace("## challenge selected", "## unrelated selected"));
  await assert.rejects(verifyCompositionProse(x.job, report, assignment, [changedPath]),
    /Missing shared\/choice\/branch prose sections/,
    "Unknown branch labels cannot masquerade as the authorized outcome.");
  writeFileSync(join(x.job.worktreeStoryRoot, changedPath),
    slugged.replace("- protect", "- unrelated"));
  await assert.rejects(verifyCompositionProse(x.job, report, assignment, [changedPath]),
    /Choice wording must be selectable labels only/,
    "An unknown menu option cannot pass merely because the count matches.");
});

test("verified deferred capture between Interactive and Composition does not block prose", { skip: !available }, () => {
  const x = setup("capture-between-stages");
  const interactiveHead = x.prepare();
  const file = join(root, "deferred-" + x.job.jobId + "-" + Math.random().toString(36).slice(2) + ".json");
  writeFileSync(file, JSON.stringify({
    kind: "event-concept", source: { kind: "author-continuation", reference: "note" },
    original: "The witness recants in a private interview",
    requirements: { meaning: [{ text: "The recantation changes trust", binding: true }], wording: [], participants: [] },
    identities: { known: [], unresolved: ["witness"] }, prerequisites: [],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" }, upstreamConstraints: [],
  }));
  const capture = x.cli(["ideas", "capture", "--file", file]);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(capture.stdout).commitSha;
  const result = x.run();
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.interactiveHead, interactiveHead);
  assert.equal(data.validation.protectionBase, captured);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", data.headSha + "^"), captured);
});

test("Choice → verified capture → Puzzle → Composition retains exact intermediary provenance", { skip: !available }, () => {
  const x = setup("capture-between-choice-puzzle");
  const payloadFile = join(root, "capture-between-choice-puzzle-message.json");
  writeFileSync(payloadFile, JSON.stringify({ id: "choice-puzzle-interruption", kind: "idea", payload: {
    kind: "event-concept", source: { kind: "author-continuation", reference: "active writing" },
    original: "The witness interrupts the interrogation",
    requirements: { meaning: [{ text: "Interruption challenges trust", binding: true }], wording: [], participants: [] },
    identities: { known: [], unresolved: ["witness"] }, prerequisites: [],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" }, upstreamConstraints: [],
  }}));
  const previous = process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE;
  process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE = payloadFile;
  try { x.prepare(); }
  finally {
    if (previous === undefined) delete process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE;
    else process.env.NT_TEST_INTERACTIVE_SEND_AFTER_CHOICE = previous;
  }
  const puzzle = git(x.job.worktreeRoot, "rev-parse", "HEAD");
  const capture = git(x.job.worktreeRoot, "rev-parse", "HEAD^");
  const choice = git(x.job.worktreeRoot, "rev-parse", "HEAD^^");
  assert.match(git(x.job.worktreeRoot, "log", "-1", "--format=%B", capture), /NovelTea-Work-Item: idea-capture/);
  const interactive = JSON.parse(x.cli(["interactive", "inspect", "--milestone", "milestone.disclosure"]).stdout);
  assert.equal(interactive.specialistUnits[0].commitSha, choice);
  assert.equal(interactive.specialistUnits[1].beforeHead, capture);
  assert.equal(interactive.specialistUnits[1].commitSha, puzzle);
  const result = x.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).validation.protectionBase, puzzle);
});

test("paused Composition job does not start writing", { skip: !available }, () => {
  const x = setup("paused-composition");
  x.prepare();
  const pause = x.cli(["author", "control", "--state", "paused"]);
  assert.equal(pause.status, 0, pause.stderr);
  const run = x.run();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /paused|cannot advance/);
  assert.equal(existsSync(join(x.job.worktreeStoryRoot, "authored-content/disclosure-scene.md")), false);
});

test("refuses branch-exclusive revelation leaked in shared prose", { skip: !available }, () => {
  const x = setup("leak");
  const prior = x.prepare();
  const run = x.run("shared-leak");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /shared|exclusive|revelation|leak/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  assert.equal(JSON.parse(x.inspect().stdout).phase, "authored");
});

test("refuses omitted choice branch even if canonical validator passes", { skip: !available }, () => {
  const x = setup("missing");
  const prior = x.prepare();
  const run = x.run("missing-branch");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing|branch|section/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("does not presume optional Puzzle discovery on shared Choice entry", { skip: !available }, () => {
  const x = setup("optional-clue");
  const prior = x.prepare();
  const result = x.run("shared-optional-clue");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /optional discovery|shared prose|clue/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses missing Puzzle solution ending even when all Events are reachable", { skip: !available }, () => {
  const x = setup("missing-ending");
  const prior = x.prepare();
  const result = x.run("missing-ending");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing.*ending|missing.*solution|missing separate playable Event coverage/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses missing distinct protect/challenge aftermath presentation", { skip: !available }, () => {
  const x = setup("missing-aftermath");
  const prior = x.prepare();
  const run = x.run("missing-aftermath");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing separate playable Event coverage|aftermath/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("refuses unauthorised edits to Event or protected prose", { skip: !available }, () => {
  const x = setup("scope");
  const prior = x.prepare();
  const run = x.run("event-retcon");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unauthorized|scope|Event|read-only/i);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), prior);
});

test("cannot compose before a verified interactive cluster", { skip: !available }, () => {
  const x = setup("missing-interactive");
  const run = x.run();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /interactive|verified|committed/i);
});

test("opt-in real Pi composition and independent reviewer read the pinned skill and saved prose", {
  skip: process.env.NT_LIVE_COMPOSITION !== "1" ? "requires NT_LIVE_COMPOSITION=1" : false,
  timeout: 1_200_000,
}, () => {
  const x = setup("live-composition");
  const prior = x.prepare();
  const args = ["composition", "run", "--milestone", "milestone.disclosure", "--skills-source", source];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  if (["low", "high"].includes(process.env.NT_THINKING ?? ""))
    args.push("--thinking", process.env.NT_THINKING!);
  const run = x.cli(args);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "composition-committed");
  assert.equal(result.validation.protectionBase, prior);
  assert.equal(result.validation.branchReview.reviewer, "independent-pi");
  assert.ok(result.validation.branchReview.sourceEvidence.length >= 2);
  for (const file of [result.sessionFile, result.reviewSessionFile]) {
    assert.ok(existsSync(file));
    const messages = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    const calls = messages.flatMap((m: any) => m.message?.content ?? [])
      .filter((c: any) => c.type === "toolCall");
    const reads = calls.filter((c: any) => c.name === "read")
      .map((c: any) => c.arguments?.path);
    assert.ok(reads.some((path: string) => path?.includes("nt-narrative-composition/SKILL.md")));
    assert.ok(reads.some((path: string) => path?.includes("authored-content/disclosure-scene.md") ||
      path?.includes("events/disclose-ledger.md")));
    if (file === result.reviewSessionFile)
      assert.ok(!calls.some((c: any) => ["write", "edit", "bash"].includes(c.name)));
  }
  assert.equal(git(x.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(x.repo, "rev-parse", "HEAD"), x.original);
});
