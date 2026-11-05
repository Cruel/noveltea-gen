import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { authorApproval } from "./approval-controller.js";
import { createGenerationGraph } from "../src/generation.js";
import { reconcileInventory, nextExecutionItem } from "../src/generation-plan.js";
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
function setup(name: string, seed?: (story: string) => void) {
  const repo = join(root, name), story = join(repo, "story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, ".gitkeep"), "");
  seed?.(story);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial Story");
  const initial = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(root, "config.json"), JSON.stringify({ novelteaSkills: source, skillDiscovery: "explicit-only" }));
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "config.json"), NT_SKILL_CACHE_DIR: join(root, "skills") };
  function cli(args: string[], success = true) {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
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
  const validated = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"),
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
