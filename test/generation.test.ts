import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { saveFixtureTurn } from "./puzzle-obligation-fixtures.js";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { reviewBoundedAssignments } from "../src/semantic-assignment-review.js";
import { createGenerationGraph, dispatchGenerationAssignment } from "../src/generation.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments } from "../src/adaptive-assignments.js";
import { milestoneFulfillmentProjection } from "../src/milestone-field-scope.js";
import { reconcileInventory, nextExecutionItem, withCausalEventPriority } from "../src/generation-plan.js";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const root = mkdtempSync(join(tmpdir(), "nt-generation-"));
after(() => {
  if ((process.env.NT_LIVE_GENERATION === "1" ||
    process.env.NT_LIVE_GENERATION_IDEA === "1") && process.env.NT_KEEP_FAILED_LIVE === "1")
    console.error("Preserved disposable generation evidence: " + root);
  else removeTestTree(root);
});
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
// All scenarios share one immutable seed object database, not one writable
// repository. Each local --shared clone retains its own refs, index, checkout
// and worktree registry, so mutation and crash-recovery tests cannot leak
// state across scenarios. Avoid Git init/config/add/commit for every empty case.
let seedSha: string | undefined;
let compiledEntry: readonly string[] | undefined;
function cliEntry(): readonly string[] {
  // The test still starts a fresh process for each public CLI invocation.
  // Compile the current checkout only once rather than reloading the TS
  // transpiler in every child. Explicit opt-out aids source-level debugging.
  if (process.env.NT_GENERATION_TEST_SOURCE_CLI === "1")
    return ["--import", "tsx", resolve("src/cli.ts")];
  if (!compiledEntry) {
    const build = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"),
      "-p", resolve("tsconfig.json")], { encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, build.stderr || build.stdout || "Unable to build generation test CLI.");
    compiledEntry = [resolve("dist/cli.js")];
  }
  return compiledEntry;
}
function prepareSeed(): string {
  if (seedSha) return seedSha;
  const template = join(root, "template-repo");
  const story = join(template, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  git(template, "init", "-q");
  git(template, "config", "user.name", "Author");
  git(template, "config", "user.email", "author@example.test");
  git(template, "add", ".");
  git(template, "commit", "-qm", "Initial Story");
  writeFileSync(join(root, "config.json"),
    JSON.stringify({ novelteaSkills: source, skillDiscovery: "explicit-only" }));
  seedSha = git(template, "rev-parse", "HEAD");
  return seedSha;
}
function setup(name: string, seed?: (story: string) => void) {
  const base = prepareSeed();
  cliEntry();
  const repo = join(root, name), story = join(repo, "story");
  git(root, "clone", "-q", "--shared", "-c", "user.name=Author",
    "-c", "user.email=author@example.test", join(root, "template-repo"), repo);
  if (seed) {
    seed(story);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Initial Story");
  }
  const initial = seed ? git(repo, "rev-parse", "HEAD") : base;
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "config.json"), NT_SKILL_CACHE_DIR: join(root, "skills") };
  function cli(args: string[], success = true) {
    const result = spawnSync(process.execPath, [...cliEntry(),
      "job", ...args, "--story", story, "--job", "single"], {
      encoding: "utf8", env, timeout: process.env.NT_LIVE_GENERATION === "1" ||
        process.env.NT_LIVE_GENERATION_IDEA === "1" ? 1_800_000 : 240_000, maxBuffer: 32 * 1024 * 1024 });
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

test("parent integrates eligible deferred ideas through the dedicated placement workflow and preserves source intent", { skip: !available }, () => {
  const f = setup("ideas-parent");
  const file = join(root, "ideas-parent-idea.json");
  const original = "The archive bell proves someone visited after midnight.";
  writeFileSync(file, JSON.stringify({
    id: "archive-bell", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "opening-notes" },
    original,
    requirements: {
      meaning: [{ text: "The bell establishes the timeline", binding: true }],
      wording: [], participants: [],
    },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const captured = f.cli(["ideas", "capture", "--file", file]);
  const paused = f.cli([...f.start, "--pause-after", "event"]);
  assert.equal(paused.status, "paused");
  assert.equal(paused.ideaHistory?.length ?? 0, 0, "safe-boundary pause precedes idea scheduling");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.ok(result.ideaHistory.some((entry: any) => entry.id === "archive-bell" &&
    entry.status === "integrated-editorial-unverified"));
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/archive-bell.yaml"), "utf8"));
  assert.equal(inbox.original, original);
  assert.equal(inbox.lifecycle.status, "integrated");
  assert.ok(inbox.lifecycle.placements[0].alternatives.length >= 2);
  assert.equal(inbox.lifecycle.placements[0].verified, "fixture-unverified");
  const target = inbox.lifecycle.placements[0].recordIds[0];
  assert.ok(readFileSync(join(f.job.worktreeStoryRoot, target.replace(".", "s/") + ".md"), "utf8").includes(original));
  assert.deepEqual(result.report.evidence.deferredIdeas.scopedOutstanding, ["archive-bell"]);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.notEqual(captured.commitSha, git(f.job.worktreeRoot, "rev-parse", "HEAD"));
  const history = result.ideaHistory;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.deepEqual(f.cli(["generate", "resume"]).ideaHistory, history);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("later canonical development triggers a bounded persisted idea reassessment", { skip: !available }, () => {
  const f = setup("ideas-reassessment");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const file = join(root, "ideas-reassessment.json");
  writeFileSync(file, JSON.stringify({
    id: "bell-revisit", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "draft-notes" },
    original: "A bell echoes from the locked archive.",
    requirements: { meaning: [{ text: "A bell explains the chronology", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  f.cli([...f.start, "--pause-after", "event"]);
  const second = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(second.status, "paused", JSON.stringify(second));
  assert.ok(second.ideaHistory.some((h: any) => h.action === "place"));
  const done = f.cli(["generate", "resume"]);
  assert.equal(done.status, "blocked", JSON.stringify(done));
  const steps = done.ideaHistory.filter((h: any) => h.id === "bell-revisit");
  assert.equal(steps[0].action, "place");
  assert.ok(steps.length >= 2 && steps.length <= 3, "reconsideration is bounded");
  assert.ok(steps.slice(1).every((h: any) => h.action === "reassess" &&
    h.status === "reassessed-editorial-unverified"));
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/bell-revisit.yaml"), "utf8"));
  assert.equal(inbox.lifecycle.placements.length, steps.length);
  assert.ok(inbox.lifecycle.placements.slice(1).every((p: any) => p.action === "reassessed"));
  const checkpoint = done.ideaHistory;
  assert.deepEqual(f.cli(["generate", "inspect"]).ideaHistory, checkpoint);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("rejected placement remains dormant, blocks binding completion, and is not blindly retried", { skip: !available }, () => {
  const f = setup("ideas-rejected");
  f.env.NT_IDEA_FIXTURE_REJECT = "rejected-concept";
  const file = join(root, "ideas-rejected.json");
  writeFileSync(file, JSON.stringify({
    id: "rejected-concept", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "editor-notes" },
    original: "An unverified clue should not be forced into a scene.",
    requirements: { meaning: [{ text: "The clue must be causal", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] }, prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.ok(result.ideaHistory.some((h: any) => h.id === "rejected-concept" &&
    h.status === "deferred"));
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot, ".story-inbox/ideas/rejected-concept.yaml"), "utf8"));
  assert.equal(inbox.lifecycle.status, "dormant");
  assert.deepEqual(inbox.lifecycle.placements, []);
  assert.deepEqual(result.report.evidence.deferredIdeas.scopedOutstanding, ["rejected-concept"]);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.deepEqual(f.cli(["generate", "resume"]).ideaHistory, result.ideaHistory);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("amended Event objective reaches the real production dispatcher and resume reuses its verified commit", { skip: !available }, async () => {
  const f = setup("adaptive-dispatch");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  const selected = first.inventory.items.find((item: any) =>
    item.id === "event:milestone.disclosure");
  assert.equal(selected?.status, "pending");
  const outcome = "Expose both the ledger's time discrepancy and the witness's independent testimony.";
  const milestonePath = "milestones/disclosure.md";
  const bytes = readFileSync(join(f.job.worktreeStoryRoot, milestonePath));
  const fullHash = createHash("sha256").update(bytes).digest("hex");
  const projectedHash = createHash("sha256")
    .update(milestoneFulfillmentProjection(bytes.toString("utf8"))).digest("hex");
  const architecture = JSON.parse(readFileSync(join(f.job.stateDir, "architecture.json"), "utf8")).plan;
  const pending = first.inventory.items.filter((item: any) => item.status === "pending")
    .map((item: any) => item.id);
  const turnDigest = "b".repeat(64);
  const proposal = {
    sourceSha: first.inventory.headSha, turnDigest, beforeVersion: 1,
    reason: "Native Milestone needs two concrete, independently testable evidence sources.",
    actions: [{ kind: "narrow" as const, item: selected.id,
      sourcePath: milestonePath, sourceHash: projectedHash, outcome }],
    order: pending,
  };
  const admitted = admitAdaptiveAssignments({
    proposal, inventory: first.inventory, plan: architecture, turnDigest, version: 1,
    verifiedSource: true,
    records: [{ path: milestonePath, metadata: { id: selected.milestone,
      type: "milestone", status: "draft" } }],
    sourceHashes: { [milestonePath]: fullHash },
    milestoneSourceHashes: { [milestonePath]: projectedHash },
    protectedPaths: [], typedEdges: [], authorTargets: [],
    planning: { choice_frequency: "frequent", puzzle_emphasis: "none",
      choice_points: { min: 2, max: 10 } },
    carried: first.inventory.items.filter((item: any) => item.status === "verified")
      .map((item: any) => ({ id: item.id, sha: item.verifiedSha })),
    omissionProofs: [],
  });
  const refined = applyAdaptiveAssignments(first.inventory, admitted).items.find((item: any) =>
    item.id === selected.id)!;
  const request = { story: f.story, job: "single",
    task: "A missing archive witness; invent unspecified details",
    contract, fixture: true, skillsSource: source };
  // The child-process CLI uses a private state/config root. The in-process
  // dispatcher must use that same job rather than the host developer's state.
  const keys = ["NT_STATE_DIR", "NT_CONFIG_FILE", "NT_SKILL_CACHE_DIR", "NT_EVENT_FIXTURE_CASE"] as const;
  const prior = keys.map(key => process.env[key]);
  let dispatched: { status: string; headSha?: string };
  try {
    for (const key of keys) process.env[key] = f.env[key];
    process.env.NT_EVENT_FIXTURE_CASE = "alternative-routes";
    dispatched = await dispatchGenerationAssignment({ request, active: refined });
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
  }
  assert.equal(dispatched.status, "event-cluster-committed");
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  assert.match(receipt.assignment.authorTask, /CONTROLLER-ADMITTED ASSIGNMENT REFINEMENT/);
  assert.match(receipt.assignment.authorTask, /ledger's time discrepancy/);
  assert.deepEqual(receipt.validation.eventIds.sort(), ["event.disclose-ledger", "event.inspect-ledger"],
    "one Event assignment can deliver two native-verified causal Events when justified");
  const commit = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(resumed.status, "paused", JSON.stringify(resumed));
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), commit,
    "the graph must reconcile the original specialist receipt instead of creating a second Event");
  assert.equal(resumed.inventory.items.find((i: any) =>
    i.id === "event:milestone.disclosure")?.status, "verified");
  assert.ok(resumed.recoveryCheckpoints.some((point: any) =>
    point.workItem === "event-disclosure" && point.commitSha === commit && point.eligible));
});

async function sealFixtureGenerationCheckpoint(f: ReturnType<typeof setup>, workItem: string) {
    const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, f.env);
    try {
      const job = await startStoryJob({ story: f.story, job: "single" }, false);
      const point = (await inspectRecoveryCheckpoints(job)).find(p =>
        p.eligible && p.workItem === workItem);
      assert.ok(point?.assurance, "Missing native-validated " + workItem);
      if (point.semanticReview === "not-required" || point.semanticReview === "passed") return;
      assert.equal(point.semanticReview, "required-pending", workItem);
      await reviewBoundedAssignments(job, [point], async packet => ({
        sourceDigest: packet.sourceDigest, verdict: "pass" as const,
        findings: [], evidence: packet.items.map(item => ({
          commitSha: item.assurance.commitSha, assignmentId: item.assignment.id,
          path: item.assurance.changedPaths[0]!, line: 1,
          explanation: "Deterministic fixture structural review, never a live Pi verdict.",
        })),
      }), "deterministic-prerequisite-fixture", true);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
}

test("actual generation graph resumes Event-only Composition without Choice/Puzzle writer commits (fixture structural certification)", { skip: !available }, async () => {
  const f = setup("generation-event-only-no-write");
  for (const key of ["NT_ARCHITECTURE_FIXTURE_CASE", "NT_EVENT_FIXTURE_CASE",
    "NT_INTERACTIVE_FIXTURE_CASE", "NT_COMPOSITION_FIXTURE_CASE"])
    f.env[key] = "event-only";
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const task = "An observational mystery where Ada uncovers and validates the concealed archive ledger.";
  f.start[3] = task;
  saveFixtureTurn(f.job, contract, task,
    ["Carry forward the Event evidence and real conversational consequence, without fabricated mechanics."]);
  const seal = (workItem: string) => sealFixtureGenerationCheckpoint(f, workItem);
  const foundation = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(foundation.status, "paused", JSON.stringify(foundation));
  await seal("foundation");
  const architecture = f.cli(["generate", "resume", "--pause-after", "architecture"]);
  assert.equal(architecture.status, "paused", JSON.stringify(architecture));
  await seal("global-architecture");
  const firstWorld = f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  assert.match(firstWorld, /review|independent/i);
  await seal("world-foundations");
  const foundations = f.cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(foundations.status, "foundations-committed");
  await seal("character-foundations");
  const first = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  await seal("event-disclosure");
  const eventHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume", "--pause-after", "composition"]);
  assert.equal(resumed.status, "paused", JSON.stringify(resumed));
  const omission = JSON.parse(readFileSync(join(f.job.stateDir,
    "interactive-items/disclosure.json"), "utf8"));
  assert.deepEqual(omission.units.map((unit: any) => unit.phase),
    ["not-applicable", "not-applicable"]);
  assert.equal(omission.worker, "fixture", "fixture proof is not independent live Pi judgment");
  assert.equal(omission.units[0].beforeHead, eventHead);
  assert.equal(omission.units[1].beforeHead, eventHead);
  assert.ok(omission.units.every((unit: any) => !unit.commitSha));
  assert.equal(resumed.inventory.items.find((item: any) =>
    item.id === "interactive:milestone.disclosure")?.status, "verified");
  assert.equal(resumed.inventory.items.find((item: any) =>
    item.id === "composition:milestone.disclosure")?.status, "verified");
  assert.equal(resumed.inventory.items.find((item: any) => item.stage === "review")?.status,
    "pending", "omission does not waive the final Story-wide reviewer");
  const composed = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD^"), eventHead,
    "Composition is the next Git commit, with no Choice or Puzzle writer commit");
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "paused");
  assert.equal(inspected.inventory.items.find((item: any) =>
    item.id === "interactive:milestone.disclosure")?.status, "verified");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), composed);
  assert.deepEqual(inspected.recoveryCheckpoints.find((point: any) =>
    point.workItem === "composition-disclosure")?.omittedWorkItems
    ?.map((entry: any) => entry.workItem),
  ["interactive-choice-disclosure", "interactive-puzzle-disclosure"]);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("stale original Turn after a reviewed World checkpoint fails closed instead of retrying foundations forever", { skip: !available }, async () => {
  const f = setup("stale-turn-world-checkpoint");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const task = "Create an archive mystery with a protected Story foundation.";
  f.start[3] = task;
  saveFixtureTurn(f.job, contract, task, ["Preserve the original authenticated Turn."]);
  assert.equal(f.cli([...f.start, "--pause-after", "foundation"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "foundation");
  assert.equal(f.cli(["generate", "resume", "--pause-after", "architecture"]).status, "paused");
  await sealFixtureGenerationCheckpoint(f, "global-architecture");
  const firstWorld = f.cli(["foundations", "run", "--fixture", "--skills-source", source], false);
  assert.match(firstWorld, /review|independent/i);
  await sealFixtureGenerationCheckpoint(f, "world-foundations");
  const worldHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const file = join(f.job.stateDir, "turn-plan.json");
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.originalRequest = "A different, unapproved objective";
  const { digest: _saved, ...body } = changed;
  changed.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  writeFileSync(file, JSON.stringify(changed));
  const run = spawnSync(process.execPath, [...cliEntry(), "job", "generate", "resume",
    "--pause-after", "event", "--story", f.story, "--job", "single"], {
    encoding: "utf8", env: f.env, timeout: 25_000, maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /original.*Turn|stale|corrupt|source base/i);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), worldHead,
    "neither a Character writer nor a planner may replay after Turn drift");
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "character-world.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.equal(receipt.units[1].phase, "pending");
});

test("one authorized Choice assignment can certify multiple meaningful Choices within a Milestone", { skip: !available }, () => {
  const f = setup("multi-choice-bundle");
  f.env.NT_INTERACTIVE_FIXTURE_CASE = "two-choices";
  const paused = f.cli([...f.start, "--pause-after", "interactive"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "interactive-items/disclosure.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.deepEqual(receipt.units[0].validation.choices.map((choice: any) => choice.id).sort(),
    ["choice-point.loyalty", "choice-point.testimony"]);
  const choices = paused.recoveryCheckpoints.filter((p: any) =>
    p.workItem === "interactive-choice-disclosure" && p.eligible);
  assert.equal(choices.length, 1, "a source-bounded Choice cluster requires only one independently reviewed commit");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const again = f.cli(["generate", "inspect"]);
  assert.equal(again.status, "paused");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

/**
 * Run the actual compiled production graph from an already committed fixture
 * Foundation. Only the external Pi transport/review boundary is deterministic:
 * the graph's verification, author boundary and next specialist are real.
 * This is a routing regression, not a substitute for a live Pi certification.
 */
async function runFixtureRecoveryGraph(
  name: string, refused: boolean,
) {
  const f = setup(name);
  saveFixtureTurn(f.job, JSON.parse(readFileSync(f.contract, "utf8")), f.start[3]!,
    ["Retain the approved archive witness objective and its causal requirements."]);
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  // The deterministic mock replaces the negative-review transport, not the
  // graph's mandatory source assurance. Keep the independently sealed fixture
  // proof real or the scheduler must refuse to carry this Foundation forward.
  await sealFixtureGenerationCheckpoint(f, "foundation");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const foundation = paused.inventory.items.find((item: { id: string }) => item.id === "foundation");
  assert.ok(foundation, "Recovery needs the already authored Foundation assignment");
  const log: string[] = [];
  // Persist the controller's phase across repeated graph boundary entry:
  // an already sealed repair is reconciled, never written a second time.
  const original = { sourceCommitSha: before };
  let repair = { ...original, phase: refused ? "needs-plan" : "ready",
    repairedCommitSha: undefined as string | undefined };
  const set = (phase: typeof repair.phase, repairedCommitSha?: string) =>
    repair = { ...repair, phase, repairedCommitSha };
  const priorEnv = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  const saver = SqliteSaver.fromConnString(paused.checkpointPath);
  try {
    const graph = createGenerationGraph(saver, "cli", async state => {
      if (state.active?.id !== "foundation") return {}; // Later fixture stages require no Pi review.
      assert.equal(state.active?.id, "foundation");
      assert.equal(state.result?.headSha, before);
      const { driveRejectedRepairCycle } = await import("../src/rejected-repair-controller.js");
      const outcome = await driveRejectedRepairCycle({
        begin: async () => repair,
        inspect: async sourceSha => {
          assert.equal(sourceSha, original.sourceCommitSha);
          return repair;
        },
        correct: async () => {
          log.push("original-session-correction");
          return set("validating");
        },
        choice: async () => { throw Error("No author question is expected"); },
        consume: async () => { throw Error("No author response is expected"); },
        validate: async () => {
          log.push("native-validation");
          return set("awaiting-checkpoint");
        },
        commit: async () => {
          log.push("correction-proof-publication");
          return set("reviewing", before);
        },
        reviewStatus: async () => "required-pending" as const,
        rereview: async () => { log.push("fresh-independent-review"); },
        finishReview: async () => {
          log.push("independent-verdict");
          return set("passed", before);
        },
        nextFailure: async () => { throw Error("Unexpected rejected correction"); },
        adjudicate: async () => { throw Error("Unexpected dispute"); },
      });
      if (outcome.next === "controller-replan") {
        log.push("refuse-other-owner-write");
        return { status: "blocked" as const, reason: "Outside original specialist authority",
          escalation: {
            kind: "dependency-replan" as const, requiresTrustedApproval: false,
            sources: [{ source: "characters/witness.md", message: "Another owner must correct this record",
              repair: "controller-amendment" }],
            action: "Require a separate authenticated controller assignment",
          } };
      }
      assert.equal(outcome.next, "completed");
      return { result: state.result };
    });
    const config = { configurable: { thread_id: paused.threadId } };
    await graph.updateState(config, {
      active: foundation, result: { status: "foundation-committed", headSha: before },
      status: "running", reason: null, completedStages: [], pauseAfter: "architecture",
    }, "specialist_dispatch");
    const next = await graph.invoke(null, config);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial,
      "The author's original Story repository must not be rewritten");
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
    return { f, next, before, log };
  } finally {
    saver.db.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("production generation graph routes bounded correction, independent review and next specialist without replay", {
  skip: !available,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("repair-graph-success", false);
  assert.deepEqual(log, [
    "original-session-correction", "native-validation", "correction-proof-publication",
    "fresh-independent-review", "independent-verdict",
  ]);
  assert.equal(next.status, "paused", JSON.stringify(next));
  assert.deepEqual(next.completedStages.map((stage: { stage: string }) => stage.stage),
    ["foundation", "architecture"], "Graph must dispatch subsequent authorized work");
  assert.notEqual(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before,
    "Subsequent specialist makes its own distinct fixture commit");
  assert.equal(next.completedStages[0]?.headSha, before,
    "Original completed Foundation is carried forward, not written again");
});

test("production generation graph refuses another owner's recovery without advancing work", {
  skip: !available,
}, async () => {
  const { f, next, before, log } = await runFixtureRecoveryGraph("repair-graph-refusal", true);
  assert.deepEqual(log, ["refuse-other-owner-write"]);
  assert.equal(next.status, "blocked");
  assert.equal(next.escalation?.kind, "dependency-replan");
  assert.match(next.reason!, /Outside original specialist authority/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before,
    "No unauthorized source mutation or downstream dispatch is allowed");
  assert.deepEqual(next.completedStages, []);
});

test("single-Milestone generation checkpoints foundation then resumes all specialists in a new process", { skip: !available }, () => {
  const f = setup("complete");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.nextStage, "architecture");
  const selected = paused.orchestrationSelection;
  assert.equal(selected.schema, "noveltea-orchestrator-selection/v1");
  assert.equal(selected.role, "orchestrator");
  assert.equal(selected.skillName, "nt-story-orchestrate");
  assert.equal(selected.objectiveKind, "partial");
  assert.equal(selected.storySourceSha, f.initial);
  assert.equal(selected.graphThreadId, f.job.threadId + ":generation");
  assert.equal(selected.skillSnapshot.commit, git(source, "rev-parse", "HEAD"));
  assert.equal(selected.skillSnapshot.id, selected.skillSnapshot.digest);
  assert.equal(selected.skillEntrypointSha256, createHash("sha256").update(
    readFileSync(join(selected.skillSnapshot.path, selected.skillEntrypoint))).digest("hex"));
  assert.deepEqual(JSON.parse(readFileSync(join(f.job.stateDir, "orchestrator-selection.json"), "utf8")), selected);
  assert.ok(existsSync(join(dirname(f.job.worktreeRoot), "generation.sqlite")));
  const foundationHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.notEqual(foundationHead, f.initial);
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "paused");
  assert.deepEqual(inspected.orchestrationSelection, selected);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), foundationHead);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.reason, "editorial-unverified");
  assert.deepEqual(result.orchestrationSelection, selected);
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

test("a committed Interactive checkpoint ignores later diagnostics but rejects altered verified evidence", {
  skip: !available,
}, () => {
  const f = setup("committed-interactive-diagnostic");
  const result = f.cli(f.start);
  const checkpoint = result.recoveryCheckpoints.find((point: any) =>
    point.workItem === "interactive-choice-disclosure");
  assert.ok(checkpoint?.eligible, JSON.stringify(result.recoveryCheckpoints));
  const originalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const path = join(f.job.stateDir, "interactive-items/disclosure.json");
  const original = readFileSync(path, "utf8");
  const receipt = JSON.parse(original);
  const unit = receipt.units.find((item: any) =>
    item.id === "interactive-choice-disclosure");
  assert.equal(unit?.phase, "committed");
  unit.failure = "Error: Controller scheduling failed after the validated commit.";
  writeFileSync(path, JSON.stringify(receipt));
  const inspect = () => f.cli(["generate", "inspect"]).recoveryCheckpoints.find(
    (point: any) => point.commitSha === checkpoint.commitSha);
  assert.ok(inspect()?.eligible, "An after-the-fact diagnostic cannot change an immutable proof.");
  unit.validation.status = "failed";
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(inspect()?.eligible, false,
    "Actual validation evidence is still covered by the checkpoint proof.");
  writeFileSync(path, original);
  assert.ok(inspect()?.eligible);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), originalHead,
    "No diagnostic or receipt inspection can regenerate the specialist.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("generation rejects a lost orchestrator selection after checkpoint without repinning or replay", { skip: !available }, () => {
  const f = setup("missing-orchestrator-selection");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const initialPin = paused.orchestrationSelection.skillSnapshot.id;
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const receiptPath = join(f.job.stateDir, "orchestrator-selection.json");
  unlinkSync(receiptPath);
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.match(resumed.reason, /orchestrator receipt is missing|selection receipt is missing/i);
  assert.equal(existsSync(receiptPath), false, "a lost pin must not be replaced");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head,
    "no specialist can run after missing source-bound selection");
  assert.notEqual(initialPin, "", "checkpoint originally recorded an immutable pin");
});

test("inspection rejects a different valid pinned method and never displays its forged provenance", { skip: !available }, () => {
  const f = setup("swapped-orchestrator-snapshot");
  const paused = f.cli([...f.start, "--pause-after", "foundation"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");

  const changedSource = join(root, "second-method-checkout");
  git(root, "clone", "-q", source, changedSource);
  const entry = join(changedSource, "skills/nt-story-orchestrate/SKILL.md");
  writeFileSync(entry, readFileSync(entry, "utf8") + "\nTest method revision\n");
  git(changedSource, "add", ".");
  git(changedSource, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "Revise portable method");
  const next = setup("other-orchestrator-snapshot");
  const other = next.cli([...next.start.slice(0, -1), changedSource, "--pause-after", "foundation"]);
  assert.equal(other.status, "paused", JSON.stringify(other));
  assert.notEqual(other.orchestrationSelection.skillSnapshot.id,
    paused.orchestrationSelection.skillSnapshot.id);

  const receiptPath = join(f.job.stateDir, "orchestrator-selection.json");
  const forged = JSON.parse(readFileSync(receiptPath, "utf8"));
  forged.skillSnapshot = other.orchestrationSelection.skillSnapshot;
  forged.skillEntrypointSha256 = other.orchestrationSelection.skillEntrypointSha256;
  writeFileSync(receiptPath, JSON.stringify(forged));
  const inspected = f.cli(["generate", "inspect"]);
  assert.equal(inspected.status, "blocked");
  assert.match(inspected.reason, /Pinned orchestrator snapshot changed/);
  assert.equal(inspected.orchestrationSelection, null, "a mismatched receipt is not trusted provenance");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
});

test("independent World and Character checkpoints survive restart and reconcile a lost finalization without writer replay", { skip: !available }, () => {
  const f = setup("threads-checkpoints");
  const paused = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  const points = paused.recoveryCheckpoints as Array<{
    workItem: string; commitSha: string; eligible: boolean; nextWorkItem: string | null;
    completedWorkItems: string[]; remainingWorkItems: string[];
  }>;
  const world = points.find(point => point.workItem === "world-foundations");
  const character = points.find(point => point.workItem === "character-foundations");
  assert.ok(world?.eligible, JSON.stringify(points));
  assert.ok(character?.eligible, JSON.stringify(points));
  assert.notEqual(world.commitSha, character.commitSha);
  assert.equal(world.nextWorkItem, "character-foundations");
  assert.ok(world.completedWorkItems.includes("world-foundations"));
  assert.ok(!world.completedWorkItems.includes("character-foundations"));
  assert.ok(world.remainingWorkItems.includes("character-foundations"));
  assert.ok(character.completedWorkItems.includes("character-foundations"));
  assert.equal(character.nextWorkItem, "event-disclosure");
  const headBefore = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const worldFile = join(f.job.stateDir, "recovery-checkpoints", world.commitSha + ".json");
  assert.ok(existsSync(worldFile));
  // Simulate a SIGKILL after specialist/verified-head receipt publication but
  // before recovery-point finalization. A read must not synthesize a point.
  unlinkSync(worldFile);
  const incomplete = f.cli(["generate", "inspect"]).recoveryCheckpoints as Array<{
    workItem: string; commitSha: string; eligible: boolean; reason: string | null;
  }>;
  assert.ok(incomplete.some(point => point.commitSha === world.commitSha &&
    !point.eligible && /incomplete/.test(point.reason ?? "")));
  const resumed = f.cli(["generate", "resume", "--pause-after", "event"]);
  assert.ok(existsSync(worldFile), "resume reconciles from the original specialist receipt");
  const repaired = (resumed.recoveryCheckpoints as typeof points).find(point => point.commitSha === world.commitSha);
  assert.ok(repaired?.eligible, JSON.stringify(resumed.recoveryCheckpoints));
  assert.equal(repaired.nextWorkItem, "character-foundations");
  const commits = git(f.job.worktreeRoot, "log", "--format=%B", headBefore)
    .split("NovelTea-Work-Item: world-foundations").length - 1;
  assert.equal(commits, 1, "recovery never invokes World writer or duplicates its commit");
  const restarted = f.cli(["generate", "inspect"]);
  assert.ok((restarted.recoveryCheckpoints as typeof points).some(point =>
    point.commitSha === world.commitSha && point.eligible));
  const savedPoint = readFileSync(worldFile, "utf8");
  // Altered continuation must not become a branchable checkpoint.
  const forged = JSON.parse(savedPoint);
  forged.nextWorkItem = "event-invented";
  writeFileSync(worldFile, JSON.stringify(forged));
  const tampered = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(tampered.some(point => point.commitSha === world.commitSha && !point.eligible));
  writeFileSync(worldFile, savedPoint);
  const invented = JSON.parse(savedPoint);
  invented.completedWorkItems.push("repair-" + "f".repeat(40));
  writeFileSync(worldFile, JSON.stringify(invented));
  assert.ok((f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points).some(point =>
    point.commitSha === world.commitSha && !point.eligible),
    "A fabricated repair is not a legitimate historical completed work item.");
  writeFileSync(worldFile, savedPoint);
  // A self-consistent hash inside an edited checkpoint is not authorization:
  // the independently saved intent and controller plan must match exactly.
  const rewritten = JSON.parse(savedPoint);
  rewritten.plan.contract.constraints = ["Unauthorised substitute author constraint"];
  rewritten.planDigest = createHash("sha256").update(JSON.stringify(rewritten.plan)).digest("hex");
  writeFileSync(worldFile, JSON.stringify(rewritten));
  const untrustedPlan = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(untrustedPlan.some(point => point.commitSha === world.commitSha && !point.eligible),
    "rehashing a modified plan must never authenticate it");
  writeFileSync(worldFile, savedPoint);
  // Validator evidence in the original specialist receipt is authoritative.
  const receiptPath = join(f.job.stateDir, "character-world.json");
  const savedReceipt = readFileSync(receiptPath, "utf8");
  const invalid = JSON.parse(savedReceipt);
  invalid.units[0].validation.status = "failed";
  writeFileSync(receiptPath, JSON.stringify(invalid));
  const invalidReceipt = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(invalidReceipt.some(point => point.commitSha === world.commitSha && !point.eligible));
  writeFileSync(receiptPath, savedReceipt);
  // A later uncommitted draft never adds an eligible checkpoint. Earlier
  // immutable points remain valid and independently inspectable.
  const draft = join(f.job.worktreeStoryRoot, "characters", "unfinished-draft.md");
  writeFileSync(draft, "unfinished draft");
  const dirty = f.cli(["generate", "inspect"]).recoveryCheckpoints as typeof points;
  assert.ok(dirty.find(point => point.commitSha === world.commitSha)?.eligible);
  assert.ok(dirty.find(point => point.commitSha === character.commitSha)?.eligible);
  assert.ok(!dirty.some(point => point.commitSha === headBefore &&
    ![world.commitSha, character.commitSha].includes(point.commitSha)));
  unlinkSync(draft);
});

test("crash after World commit before finalization never replays writer or grants an incomplete point", { skip: !available }, () => {
  const f = setup("threads-crash");
  f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT = "world-foundations";
  const crashed = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(crashed.status, "blocked", JSON.stringify(crashed));
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.match(git(f.job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: world-foundations/);
  assert.ok(crashed.recoveryCheckpoints.some((p: any) => p.commitSha === head && !p.eligible));
  delete f.env.NT_RECOVERY_FIXTURE_CRASH_AFTER_INTENT;
  const reconciled = f.cli(["generate", "resume", "--pause-after", "foundations"]);
  assert.ok(reconciled.recoveryCheckpoints.some((p: any) =>
    p.commitSha === head && p.workItem === "world-foundations" && p.eligible));
  assert.equal(git(f.job.worktreeRoot, "rev-list", "--count", f.initial + "..HEAD").trim(),
    String(reconciled.recoveryCheckpoints.filter((p: any) => p.eligible).length));
  assert.equal(reconciled.status, "paused", JSON.stringify({ reason: reconciled.reason, nextStage: reconciled.nextStage }));
});

test("multi-Milestone generation develops every selected cluster across process restarts", { skip: !available }, () => {
  const f = setup("multi");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const foundations = f.cli([...f.start, "--pause-after", "foundations"]);
  assert.equal(foundations.status, "paused", JSON.stringify(foundations));
  const character = foundations.recoveryCheckpoints.find((p: any) =>
    p.workItem === "character-foundations" && p.eligible);
  assert.ok(character, JSON.stringify(foundations.recoveryCheckpoints));
  assert.deepEqual(character.dependencies["event-disclosure"], ["character-foundations"]);
  assert.deepEqual(character.dependencies["event-reckoning"], ["character-foundations"]);
  assert.equal(character.nextWorkItem, "event-disclosure",
    "aggregate composition/review plans must not create cyclic Event prerequisites");
  const paused = f.cli(["generate", "resume", "--pause-after", "composition"]);
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.nextStage, "event");
  const firstHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.reason, "editorial-unverified");
  assert.equal(result.inventory.items.filter((i: any) => i.stage === "composition" && i.status === "verified").length, 2);
  assert.notEqual(git(f.job.worktreeRoot, "rev-parse", "HEAD"), firstHead);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

function plannedCluster(story: string, arc: string, milestone: string) {
  const direction = join(story, "creative-direction/foundation.md");
  if (!existsSync(direction)) {
    mkdirSync(dirname(direction), { recursive: true });
    writeFileSync(direction, `---\nschema: '0.1'\ntype: creative-direction\nid: creative-direction.foundation\ntitle: "The Archive Mystery"\nstatus: draft\ndecisions: []\npremise: "A missing witness challenges an archivist to investigate a hidden truth."\ncentral_conflict: "The archivist must choose between truth and protecting witnesses."\ngenre: "Mystery"\ntone: "Suspenseful"\nplayer_experience: "A dialogue-led investigation with meaningful choices."\nscope: "A small town and its archive."\n---\n\n# Foundation\n\nAn investigator discovers the cost of secrecy.\n`);
  }
  for (const [folder, slug, type, fields] of [
    ["arcs", arc, "arc", 'dramatic_question: "Will loyalty survive?"\ncharacters: []'],
    ["milestones", milestone, "milestone", `completeness: partial\nchange: "The witness accepts responsibility"\narcs: [arc.${arc}]\nfulfillment: {any_of: []}`],
  ]) {
    mkdirSync(join(story, folder!), { recursive: true });
    writeFileSync(join(story, folder!, slug + ".md"), `---\nschema: '0.1'\ntype: ${type}\nid: ${type}.${slug}\ntitle: "${slug}"\nstatus: draft\ndecisions: []\n${fields}\n---\n\nThe witness must choose between silence and accountability.\n`);
  }
}

test("full-Story scope discovers multiple canonical Arc clusters rather than stopping at the first", { skip: !available }, () => {
  const f = setup("full", story => plannedCluster(story, "justice", "reckoning"));
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.orchestrationSelection.skillName, "nt-story-orchestrate");
  assert.equal(result.orchestrationSelection.objectiveKind, "full-story");
  assert.deepEqual(result.inventory.items.filter((i: any) => i.stage === "composition").map((i: any) => [i.milestone, i.status]),
    [["milestone.disclosure", "verified"], ["milestone.reckoning", "verified"]]);
  assert.equal(result.inventory.audit.deterministic, "passed");
});

test("bounded partial Arc expands its Milestones but leaves an unfinished optional Arc untouched", { skip: !available }, () => {
  const f = setup("partial-arc", story => {
    plannedCluster(story, "truth", "reckoning");
    plannedCluster(story, "optional", "deferred");
  });
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.inventory.items.filter((i: any) => i.stage === "composition" && i.status === "verified").length, 2);
  assert.ok(!result.inventory.items.some((i: any) => i.milestone === "milestone.deferred"));
  assert.equal(git(f.job.worktreeRoot, "diff", f.initial, "HEAD", "--", "story/milestones/deferred.md"), "");
});

test("alternative Milestone routes retain separately owned Event-design prose obligations", { skip: !available }, () => {
  const f = setup("alternatives");
  f.env.NT_EVENT_FIXTURE_CASE = "alternative-routes";
  const result = f.cli(f.start);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  const routes = result.inventory.audit.routeCoverage.milestones.filter((m: any) =>
    m.milestone === "milestone.disclosure");
  assert.deepEqual(routes.map((r: any) => r.status), ["reachable", "reachable"]);
  assert.equal(result.inventory.audit.deterministic, "passed");
  assert.ok(existsSync(join(f.job.worktreeStoryRoot, "authored-content/inspect-ledger-scene.md")));
});

function plannedDependencyInventory(f: ReturnType<typeof setup>, edit: (items: any[]) => void) {
  const file = join(dirname(f.job.worktreeRoot), "architecture.json");
  const architecture = JSON.parse(readFileSync(file, "utf8"));
  // Model typed dependencies in memory. Editing the already-committed
  // controller receipt in place would be an unauthorized replan and must not
  // be used as a fixture for a production recovery checkpoint.
  edit(architecture.plan.items);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const validated = spawnSync(process.execPath, [...cliEntry(),
    "job", "validate", "--story", f.story, "--job", "single"], {
    encoding: "utf8", env: f.env, timeout: 90000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.ok(validated.status === 0 || validated.status === 2, validated.stderr);
  return reconcileInventory(architecture.plan, JSON.parse(validated.stdout), head, [
    { stage: "foundation", headSha: head, status: "committed" },
    { stage: "architecture", headSha: head, status: "architecture-committed", planVersion: 1 },
    { stage: "foundations", headSha: head, status: "foundations-committed", planVersion: 1 },
  ], {});
}

test("source-bound Architecture order schedules the earliest causal Event before alphabetical resolution", { skip: !available }, () => {
  const f = setup("causal-event-order");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, () => {});
  assert.deepEqual(inventory.items.filter(i => i.stage === "event").map(i => i.id),
    ["event:milestone.disclosure", "event:milestone.reckoning"],
    "The canonical inventory and carry-forward identity remain unchanged");
  const causal = withCausalEventPriority({ items: [
    { kind: "realization", targetIds: ["milestone.reckoning"] },
    { kind: "realization", targetIds: ["milestone.disclosure"] },
  ] } as any, ["foundation", "architecture", "foundations", "event", "interactive", "composition"]);
  assert.deepEqual(causal.slice(3, 6),
    ["event:milestone.reckoning", "event:milestone.disclosure", "event"]);
  assert.equal(nextExecutionItem(inventory, causal)?.id, "event:milestone.reckoning");
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.disclosure");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("a new typed cross-Milestone dependency changes the next runnable work item", { skip: !available }, () => {
  const f = setup("dependency");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const paused = f.cli([...f.start, "--pause-after", "architecture"]);
  assert.equal(paused.status, "paused");
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    const reckoning = items.find(i => i.targetIds.includes("milestone.reckoning") && i.kind === "realization");
    assert.ok(disclosure && reckoning, "typed plan contains both realization obligations");
    disclosure.dependencies.push(reckoning.id);
  });
  assert.deepEqual(inventory.items.find(i => i.id === "event:milestone.disclosure")?.dependencies,
    ["foundations", "architecture", "event:milestone.reckoning"]);
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.reckoning");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("an unknown typed dependency blocks its cluster without silently dropping it", { skip: !available }, () => {
  const f = setup("unknown-dependency");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    assert.ok(disclosure);
    disclosure.dependencies.push("nonexistent-dependency");
  });
  assert.match(inventory.items.find(i => i.id === "event:milestone.disclosure")?.blockingReason ?? "",
    /nonexistent-dependency/);
  assert.equal(inventory.items.find(i => i.id === "event:milestone.reckoning")?.status, "pending");
  assert.equal(nextExecutionItem(inventory)?.id, "event:milestone.reckoning");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("cyclic typed dependencies block their work without dispatch", { skip: !available }, () => {
  const f = setup("cycle");
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["arc.truth", "milestone.disclosure", "milestone.reckoning"];
  writeFileSync(f.contract, JSON.stringify(contract));
  f.cli([...f.start, "--pause-after", "architecture"]);
  const inventory = plannedDependencyInventory(f, items => {
    const disclosure = items.find(i => i.targetIds.includes("milestone.disclosure") && i.kind === "realization");
    const reckoning = items.find(i => i.targetIds.includes("milestone.reckoning") && i.kind === "realization");
    assert.ok(disclosure && reckoning);
    disclosure.dependencies.push(reckoning.id);
    reckoning.dependencies.push(disclosure.id);
  });
  assert.match(inventory.items.find(i => i.id === "event:milestone.disclosure")?.blockingReason ?? "", /Cyclic/);
  assert.match(inventory.items.find(i => i.id === "event:milestone.reckoning")?.blockingReason ?? "", /Cyclic/);
  assert.equal(inventory.items.filter(i => i.stage === "event" && i.status === "verified").length, 0);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("clean Event no-write prerequisite is blocked for typed plan approval without replay or new grants", { skip: !available }, () => {
  const f = setup("event-prerequisite-report");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-prerequisite" });
  const first = f.cli(f.start);
  assert.equal(first.status, "blocked");
  const item = first.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(item.status, "blocked");
  assert.match(item.blockingReason, /Clean no-write Event prerequisite report/);
  assert.match(item.blockingReason, /controller-approved bounded architecture\/work-plan revision/);
  assert.equal(first.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure").status,
    "blocked", "A Choice unit must not bypass its original Event prerequisite");
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = readFileSync(receiptPath, "utf8");
  assert.equal(JSON.parse(receipt).phase, "prerequisite-reported");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(readFileSync(receiptPath, "utf8"), receipt,
    "The same completed no-write specialist must not be invoked twice");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(resumed.inventory.version, first.inventory.version);
});

test("clean no-write Event report authorizes one new bounded Event setup without changing Choice grants", { skip: !available }, () => {
  const f = setup("event-prerequisite-reassign");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-once" });
  const result = f.cli(f.start);
  const event = result.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(event.status, "verified", JSON.stringify(event));
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.phase, "committed");
  assert.equal(receipt.reroutedFrom?.length, 64);
  assert.equal(receipt.reroutedTask?.includes("Do not bind Choice outcomes"), true);
  const archive = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + receipt.reroutedFrom + ".json");
  const original = JSON.parse(readFileSync(archive, "utf8"));
  assert.equal(original.phase, "prerequisite-reported");
  assert.equal(original.prerequisite.reportDigest, receipt.reroutedFrom);
  assert.deepEqual(original.claimedPaths, []);
  assert.equal(original.expectedHead, receipt.expectedHead);
  assert.equal(result.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure")?.status,
    "verified", "Authorized downstream Choice work resumes only after a real Event commit");
  const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.equal(readFileSync(receiptPath, "utf8"), JSON.stringify(receipt, null, 2) + "\n",
    "A restart cannot repeat the original no-write report or Event writer");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial,
    "The source author's checkout stays unmodified");
});

test("S14 #173: clean unmet access evidence gets one authorized Event reassignment, then Choice can proceed", {
  skip: !available,
}, () => {
  const f = setup("event-local-access-evidence");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-evidence-once" });
  const result = f.cli(f.start);
  const stage = result.inventory.items.find((i: any) => i.id === "event:milestone.disclosure");
  assert.equal(stage?.status, "verified", JSON.stringify(stage));
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const raw = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(raw);
  assert.equal(receipt.phase, "committed");
  assert.match(receipt.reroutedTask, /IN-SCOPE EVENT EVIDENCE/);
  const originalPath = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + receipt.reroutedFrom + ".json");
  const original = JSON.parse(readFileSync(originalPath, "utf8"));
  assert.equal(original.phase, "prerequisite-reported");
  assert.deepEqual(original.claimedPaths, []);
  assert.deepEqual(original.obligations, []);
  assert.equal(original.prerequisite.reportDigest, receipt.reroutedFrom);
  assert.equal(result.inventory.items.find((i: any) =>
    i.id === "interactive:milestone.disclosure")?.status, "verified",
    "Downstream Choice must wait for a real, verified Event commit.");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(receiptPath, "utf8"), raw, "The original no-write turn cannot be replayed.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
});

test("S14 #173: competing-account evidence no-write gets one Event-local retry without replay", {
  skip: !available,
}, () => {
  const f = setup("event-local-competing-accounts");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-accounts-once" });
  const result = f.cli(f.start);
  assert.equal(result.inventory.items.find((i: any) =>
    i.id === "event:milestone.disclosure")?.status, "verified");
  const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
  const saved = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(saved);
  assert.equal(receipt.phase, "committed");
  assert.match(receipt.reroutedTask, /independent observation/);
  assert.match(receipt.reroutedTask, /new on-page testimony/);
  const previous = JSON.parse(readFileSync(join(f.job.stateDir,
    "event-prerequisite-history/disclosure-" + receipt.reroutedFrom + ".json"), "utf8"));
  assert.equal(previous.phase, "prerequisite-reported");
  assert.deepEqual(previous.claimedPaths, []);
  assert.deepEqual(previous.obligations, []);
  assert.match(previous.conflicts[0], /sources establish neither/);
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  f.cli(["generate", "resume"]);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(receiptPath, "utf8"), saved);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
});

test("rerouted Event task and original receipt remain immutable across recovery", { skip: !available }, () => {
  const f = setup("event-prerequisite-immutable");
  Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: "no-write-once" });
  const first = f.cli(f.start);
  assert.equal(first.inventory.items.find((i: any) => i.id === "event:milestone.disclosure")?.status,
    "verified");
  const file = join(f.job.stateDir, "event-items/disclosure.json");
  const saved = readFileSync(file, "utf8");
  const current = JSON.parse(saved);
  const eventArgs = ["event", "run", "--fixture", "--milestone", "milestone.disclosure",
    "--skills-source", source];
  writeFileSync(file, JSON.stringify({ ...current, reroutedTask: "Change all protected records." }));
  assert.match(f.cli(eventArgs, false), /task changed/);
  writeFileSync(file, saved);
  const history = join(f.job.stateDir, "event-prerequisite-history",
    "disclosure-" + current.reroutedFrom + ".json");
  const original = readFileSync(history, "utf8");
  const tampered = JSON.parse(original);
  tampered.conflicts = ["Different report"];
  writeFileSync(history, JSON.stringify(tampered));
  assert.match(f.cli(eventArgs, false), /predecessor receipt is tampered/);
  writeFileSync(history, original);
  const recovered = f.cli(eventArgs);
  assert.equal(recovered.status, "event-cluster-committed");
});

test("second no-write report and protected prerequisite remain honestly blocked", { skip: !available }, () => {
  for (const variant of ["no-write-prerequisite", "no-write-protected"]) {
    const f = setup("event-prerequisite-" + variant);
    Object.assign(f.env, { NT_EVENT_FIXTURE_CASE: variant });
    const first = f.cli(f.start);
    assert.equal(first.status, "blocked");
    const receiptPath = join(f.job.stateDir, "event-items/disclosure.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.phase, "prerequisite-reported");
    assert.equal(Boolean(receipt.reroutedFrom), variant === "no-write-prerequisite");
    assert.equal(first.inventory.items.find((i: any) => i.id === "interactive:milestone.disclosure")?.status,
      "blocked");
    const before = git(f.job.worktreeRoot, "rev-parse", "HEAD");
    const resumed = f.cli(["generate", "resume"]);
    assert.equal(resumed.status, "blocked");
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), before);
    assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(readFileSync(receiptPath, "utf8"), JSON.stringify(receipt, null, 2) + "\n");
  }
});

test("a clean local cluster block does not stop independent work or spin on resume", { skip: !available }, () => {
  const f = setup("local-block", story => plannedCluster(story, "z-optional", "aaa-optional"));
  Object.assign(f.env, { NT_FOUNDATIONS_FIXTURE_CASE: "one-arc-only" });
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope = { kind: "full-story", depth: "composition", targets: [], branches: [] };
  writeFileSync(f.contract, JSON.stringify(contract));
  const result = f.cli(f.start);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /linked Character foundations/);
  assert.equal(result.inventory.items.find((i: any) => i.id === "event:milestone.aaa-optional").status, "blocked");
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").status, "verified");
  const head = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  const resumed = f.cli(["generate", "resume"]);
  assert.equal(resumed.status, "blocked");
  assert.equal(resumed.inventory.version, result.inventory.version,
    "unchanged local blockers should not be re-dispatched on every resume");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("a controller-approved later scope revision adds a cluster without repeating unaffected commits", { skip: !available }, () => {
  const f = setup("replan", story => plannedCluster(story, "truth", "reckoning"));
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["milestone.disclosure"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "composition"]);
  assert.equal(first.status, "paused", first.reason);
  const oldCommit = first.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha;
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const carry = join(root, "carry.json");
  writeFileSync(carry, JSON.stringify(["foundations", "event:milestone.disclosure", "interactive:milestone.disclosure", "composition:milestone.disclosure"]));
  const proposal = f.cli(["architecture", "propose", "--contract", f.contract, "--carry-forward", carry]);
  const payload = { ...proposal.authorSigningRequest, reason: "Test author approves the second Milestone and retains the reviewed first cluster." };
  const evidence = authorApproval(f.story, "single", f.env, root, payload).file;
  f.cli(["architecture", "approve", "--proposal", proposal.proposal.digest, "--approval", evidence]);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.reason, "editorial-unverified", JSON.stringify(result));
  assert.equal(result.inventory.planVersion, 2);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha, oldCommit);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.reckoning").status, "verified");
  assert.equal(git(f.job.worktreeRoot, "log", "--format=%B").split("NovelTea-Work-Item: composition-disclosure").length - 1, 1);
});

test("approved scope expansion activates an early deferred idea without replaying prior specialist commits", { skip: !available }, () => {
  const f = setup("idea-replan", story => plannedCluster(story, "truth", "reckoning"));
  const idea = join(root, "idea-replan.json");
  writeFileSync(idea, JSON.stringify({
    id: "replan-witness", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "plot-notes" },
    original: "The witness finally admits why they hid the ledger.",
    requirements: { meaning: [{ text: "The witness explains their earlier secrecy", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: [] },
    prerequisites: ["milestone.reckoning"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", idea]);
  const contract = JSON.parse(readFileSync(f.contract, "utf8"));
  contract.scope.targets = ["milestone.disclosure"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const first = f.cli([...f.start, "--pause-after", "composition"]);
  assert.equal(first.status, "paused", JSON.stringify(first));
  assert.equal(first.ideaHistory.length, 0, "idea waits for the authorized second Milestone");
  const oldCommit = first.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha;
  contract.scope.targets = ["arc.truth"];
  writeFileSync(f.contract, JSON.stringify(contract));
  const carry = join(root, "idea-replan-carry.json");
  writeFileSync(carry, JSON.stringify(["foundations", "event:milestone.disclosure",
    "interactive:milestone.disclosure", "composition:milestone.disclosure"]));
  const proposal = f.cli(["architecture", "propose", "--contract", f.contract, "--carry-forward", carry]);
  const payload = { ...proposal.authorSigningRequest, reason: "Authorize a second Milestone and keep the first." };
  const evidence = authorApproval(f.story, "single", f.env, root, payload).file;
  f.cli(["architecture", "approve", "--proposal", proposal.proposal.digest, "--approval", evidence]);
  const result = f.cli(["generate", "resume"]);
  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.inventory.planVersion, 2);
  assert.equal(result.inventory.items.find((i: any) => i.id === "composition:milestone.disclosure").verifiedSha, oldCommit);
  assert.ok(result.ideaHistory.some((h: any) => h.id === "replan-witness" &&
    h.status === "integrated-editorial-unverified"), JSON.stringify(result.ideaHistory));
  assert.equal(result.report.evidence.deferredIdeas.scopedOutstanding.includes("replan-witness"), true);
  const finalHead = git(f.job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(f.cli(["generate", "resume"]).status, "blocked");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), finalHead);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
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
  // A cancelled Pi writer can leave these bytes after its checkpoint. Neither
  // inspect nor resume may reopen dispatch or mistake dirty recovery for a
  // generic scheduling failure on the terminal job.
  const partial = join(f.job.worktreeStoryRoot, "interrupted-specialist.md");
  writeFileSync(partial, "Original unfinished specialist work");
  assert.equal(f.cli(["generate", "inspect"]).status, "cancelled");
  assert.equal(f.cli(["generate", "resume"]).status, "cancelled");
  assert.equal(readFileSync(partial, "utf8"), "Original unfinished specialist work");
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
      { cursor: 0, completedStages: [], result: null,
        active: { ...paused.inventory.items.find((i: any) => i.id === "foundation"), status: "pending" } });
  } finally { saver.db.close(); }
  const recovered = f.cli(["generate", "resume", "--pause-after", "foundation"]);
  assert.equal(recovered.status, "paused", JSON.stringify(recovered));
  assert.equal(recovered.completedStages[0].headSha, head);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).stage, "committed");
});

test("opt-in real Pi generation semantically chooses and reviews a deferred idea", {
  skip: process.env.NT_LIVE_GENERATION_IDEA !== "1"
    ? "set NT_LIVE_GENERATION_IDEA=1 for paid semantic placement evaluation" : false,
  timeout: 3_600_000,
}, () => {
  assert.ok(available);
  const f = setup("live-idea-parent");
  const file = join(root, "live-idea-parent.json");
  const original = "The missing witness heard the archive bell after midnight.";
  writeFileSync(file, JSON.stringify({
    id: "witness-bell", kind: "event-concept",
    source: { kind: "author-onboarding", reference: "story-seed" }, original,
    requirements: { meaning: [{ text: "The bell changes the timeline", binding: true }],
      wording: [], participants: [{ text: "character.ada", binding: true }] },
    identities: { known: ["character.ada"], unresolved: [] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  f.cli(["ideas", "capture", "--file", file]);
  const args = [...f.start];
  if (process.env.NT_PROVIDER) args.push("--provider", process.env.NT_PROVIDER);
  if (process.env.NT_MODEL) args.push("--model", process.env.NT_MODEL);
  const result = f.cli(args);
  const inbox = JSON.parse(readFileSync(join(f.job.worktreeRoot,
    ".story-inbox/ideas/witness-bell.yaml"), "utf8"));
  assert.equal(inbox.original, original);
  const integrated = result.ideaHistory.some((entry: any) => entry.id === "witness-bell" &&
    entry.status === "integrated");
  if (integrated) {
    assert.equal(inbox.lifecycle.placements.at(-1).verified, "pi");
    assert.ok(inbox.lifecycle.placements[0].sessionFiles.length >= 3,
      "selection, craft writing and independent review require distinct pinned sessions");
  } else {
    // A semantic rejection is a valid evaluation outcome; it must not be
    // laundered into a verified canonical realization or completed generation.
    assert.notEqual(result.status, "completed");
    assert.ok(result.reason, "a rejected or interrupted Pi placement needs actionable evidence");
    assert.ok(result.ideaHistory.length > 0 ||
      existsSync(join(dirname(f.job.worktreeRoot), "generation-idea-dispatch.json")),
      "the parent must record attempted Pi selection for inspection");
  }
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.initial);
  console.error(JSON.stringify({ status: result.status, reason: result.reason,
    ideas: result.ideaHistory, escalation: result.escalation }));
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
  const studioEntry = process.env.NT_GENERATION_TEST_SOURCE_CLI === "1"
    ? ["--import", "tsx", resolve("src/studio-input.ts")] : [resolve("dist/studio-input.js")];
  const prepared = spawnSync(process.execPath, [...studioEntry,
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
