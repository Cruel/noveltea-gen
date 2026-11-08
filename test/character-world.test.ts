import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { deriveFoundationAssignment, auditPaths, checkOutput } from "../src/character-world.js";

const root = mkdtempSync(join(tmpdir(), "nt-character-world-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("character assignment includes existing canonical Character paths instead of inventing duplicate IDs", () => {
  const record = (path: string, type: string, id: string, characters?: string[]) =>
    ({ path, metadata: { type, id, status: "draft", ...(characters ? { characters } : {}) } });
  const report = {
    records: [
      record("creative-direction/foundation.md", "creative-direction", "creative-direction.foundation"),
      record("arcs/missing-page.md", "arc", "arc.missing-page", ["character.nia"]),
      record("milestones/map-recovered.md", "milestone", "milestone.map-recovered"),
      record("characters/nia.md", "character", "character.nia"),
      record("characters/unrelated.md", "character", "character.unrelated"),
    ], diagnostics: [], outstanding: [],
    protection: { status: "checked", changes: [], warnings: [] },
    readiness: { design: { stages: {} } },
  };
  const plan = { version: 1, contract: { scope: { kind: "full-story" } },
    items: [{ id: "global-architecture", status: "verified",
      verifiedSha: "a".repeat(40), targetIds: ["arc.missing-page", "milestone.map-recovered"] },
    { id: "compose-scope", targetIds: ["character.nia"] }] };
  const character = deriveFoundationAssignment("character", plan as any, report as any, []);
  assert.ok(character.sourcePaths.includes("characters/nia.md"));
  assert.ok(!character.sourcePaths.includes("characters/unrelated.md"));
  const world = deriveFoundationAssignment("world", plan as any, report as any, []);
  assert.ok(!world.sourcePaths.includes("characters/nia.md"));
});

function setup(name: string, protectedFoundation = false) {
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "The missing witness"
status: draft
${protectedFoundation ? 'decisions:\n  - id: loyalty\n    statement: "Ada must be allowed to defend Neri"\n    origin: user\n    authority: user-protected' : "decisions: []"}
premise: "A witness disappears before an inquiry"
central_conflict: "Expose the truth or preserve a friendship"
genre: "Mystery"
tone: "Intimate"
player_experience: "Consequential conversations"
scope: "A compact dialogue-led story"
---

Ada investigates a missing witness and Neri's concealed evidence.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author's foundation");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_CONFIG_FILE: join(root, "missing-config.json"), NT_SKILL_CACHE_DIR: join(root, "skills"),
     };
  const cli = (args: string[], caseName?: string) => spawnSync(process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), "job", ...args, "--story", story, "--job", "draft"],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...env, NT_FOUNDATIONS_FIXTURE_CASE: caseName ?? "" } });
  const started = cli(["start"]);
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  function architecture() {
    const contract = join(root, name + "-contract.json");
    writeFileSync(contract, JSON.stringify({ scope: { kind: "partial", depth: "architecture",
      targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route"] },
      constraints: ["Ada may confront Neri or ask for trust; revelation depends on the actual route"],
      envelope: { presentation: "Dialogue-led visual novel", hardLimits: ["Reuse the archive backdrop"],
        preferences: ["Two speaking Characters"] } }));
    const result = cli(["architecture", "run", "--fixture", "--contract", contract, "--skills-source", source]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { repo, story, baseline, job, cli, architecture };
}

test("existing foundation categories may remain unchanged during a scoped revision", { skip: !available }, async () => {
  const { job, cli, architecture } = setup("existing-foundation-revisions");
  const arch = architecture();
  const result = cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(result.status, 0, result.stderr);
  const checked = cli(["validate"]);
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout).report;
  const records = report.records.filter((r: any) => r.metadata.status !== "superseded");
  const record = (type: string) => records.find((r: any) => r.metadata.type === type);
  const fact = record("fact")?.path as string;
  const entity = record("world-entity")?.path as string;
  const relationship = record("relationship")?.path as string;
  assert.ok(fact && entity && relationship);
  const world = deriveFoundationAssignment("world", arch.plan, report, []);
  assert.ok(world.sourcePaths.includes(fact) && world.sourcePaths.includes(entity));
  const originalFact = readFileSync(join(job.worktreeStoryRoot, fact), "utf8");
  writeFileSync(join(job.worktreeStoryRoot, fact), originalFact + "\nAn additional fact explanation.\n");
  const worldUnit = { domain: "world", phase: "writing", paths: [fact] } as any;
  assert.deepEqual(await auditPaths(job, worldUnit, world, [fact]), [fact]);
  await checkOutput(job, report, worldUnit, world);
  writeFileSync(join(job.worktreeStoryRoot, fact), originalFact);

  const character = deriveFoundationAssignment("character", arch.plan, report, [fact, entity]);
  assert.ok(character.sourcePaths.includes(relationship));
  const originalRelationship = readFileSync(join(job.worktreeStoryRoot, relationship), "utf8");
  writeFileSync(join(job.worktreeStoryRoot, relationship), originalRelationship + "\nRelationship scene context.\n");
  const characterUnit = { domain: "character", phase: "writing", paths: [relationship] } as any;
  assert.deepEqual(await auditPaths(job, characterUnit, character, [relationship]), [relationship]);
  await checkOutput(job, report, characterUnit, character);
  writeFileSync(join(job.worktreeStoryRoot, relationship), originalRelationship);
});

test("real public CLI creates two separately validated canonical specialist commits with branch-safe knowledge and relationships", { skip: !available }, () => {
  const { repo, baseline, job, cli, architecture } = setup("complete");
  const arch = architecture();
  const result = cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "foundations-committed");
  assert.equal(data.architectureHead, arch.headSha);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items.map((item: any) => item.phase), ["committed", "committed"]);
  assert.deepEqual(data.items.map((item: any) => item.specialist), ["nt-worldbuilding", "nt-character-development"]);
  const head = git(job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(data.headSha, head);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD~2"), arch.headSha);
  assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: character-foundations/);
  assert.match(git(job.worktreeRoot, "log", "-2", "--format=%B"), /NovelTea-Work-Item: world-foundations/);
  const story = job.worktreeStoryRoot;
  const fact = readFileSync(join(story, "facts/evidence-concealed.md"), "utf8");
  assert.match(fact, /initial: true/);
  const ada = readFileSync(join(story, "characters/ada.md"), "utf8");
  const neri = readFileSync(join(story, "characters/neri.md"), "utf8");
  assert.match(ada, /fact: fact.evidence-concealed\n    value: disbelieves/);
  assert.match(neri, /fact: fact.evidence-concealed\n    value: knows/);
  assert.match(readFileSync(join(story, "relationships/ada-neri.md"), "utf8"), /initial: wary/);
  assert.match(readFileSync(join(story, "arcs/truth.md"), "utf8"),
    /characters: \[character.ada, character.neri\]/);
  assert.ok(existsSync(join(story, "world-entities/archive.md")));
  assert.ok(!existsSync(join(story, "events")));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(data.completionEvidence.branchKnowledgeTransitions, "deferred-to-event-design");
  const validated = cli(["validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.status, "passed");
  assert.ok(report.report.outstanding.some((entry: any) => entry.field === "fulfillment.any_of"));
  const inspect = cli(["foundations", "inspect"]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout).items, data.items);
  const replay = cli(["foundations", "run", "--fixture"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, head, "replay must not commit twice");
});

test("deferred capture between architecture and Character/World handoff remains a separate verified commit", { skip: !available }, () => {
  const { cli, job, architecture, baseline } = setup("ideas-handoff");
  const arch = architecture();
  const payload = join(root, "ideas-handoff.json");
  writeFileSync(payload, JSON.stringify({
    kind: "event-concept",
    source: { kind: "author-continuation", reference: "late planning note" },
    original: "The witness changes their mind after the discovery.",
    requirements: { meaning: [{ text: "Consequential reversal", binding: true }],
      wording: [], participants: [] },
    identities: { known: [], unresolved: ["the witness"] },
    prerequisites: ["milestone.disclosure"],
    placement: { scopeIds: ["arc.truth"], flexible: true, earliest: "event" },
    upstreamConstraints: [],
  }));
  const capture = cli(["ideas", "capture", "--file", payload]);
  assert.equal(capture.status, 0, capture.stderr);
  const idea = JSON.parse(capture.stdout);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), arch.headSha);
  const world = cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(world.status, 0, world.stderr);
  const result = JSON.parse(world.stdout);
  assert.equal(result.status, "foundations-committed");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD~2"), idea.commitSha);
  assert.equal(git(job.worktreeRoot, "rev-list", "--count", baseline + "..HEAD"), "4");
  const replay = cli(["foundations", "run", "--fixture"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, result.headSha);
  writeFileSync(payload, JSON.stringify({ ...JSON.parse(readFileSync(payload, "utf8")),
    source: { kind: "author-continuation", reference: "after character foundations" } }));
  const following = cli(["ideas", "capture", "--file", payload]);
  assert.equal(following.status, 0, following.stderr);
  const postCapture = git(job.worktreeRoot, "rev-parse", "HEAD");
  assert.equal(git(job.worktreeRoot, "rev-list", "--count", baseline + "..HEAD"), "5");
  const after = cli(["foundations", "run", "--fixture"]);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), postCapture,
    "completed specialists are not replayed after another verified inbox capture");
});

test("cannot start foundations before architecture and cannot convert a mismatched specialist manifest into a commit", { skip: !available }, () => {
  const { cli, job, architecture } = setup("mismatch");
  const before = cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.notEqual(before.status, 0);
  assert.match(before.stderr, /verified committed architecture/);
  const arch = architecture();
  const invalid = cli(["foundations", "run", "--fixture", "--skills-source", source], "mismatch");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /claimed modifiedRecords differ/);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), arch.headSha);
  const receipt = JSON.parse(readFileSync(join(job.worktreeRoot, "../character-world.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "writing");
  const attempted = cli(["foundations", "run", "--fixture"]);
  assert.notEqual(attempted.status, 0);
  assert.match(attempted.stderr, /Interrupted specialist writing/);
});

test("protects user decisions and rejects unscoped retcons without committing", { skip: !available }, () => {
  const { cli, job, architecture } = setup("protected", true);
  const arch = architecture();
  const invalid = cli(["foundations", "run", "--fixture", "--skills-source", source], "retcon");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unauthorized specialist path: creative-direction/);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), arch.headSha);
  const uncommitted = readFileSync(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8");
  assert.match(uncommitted, /authority: user-protected/);
  assert.match(uncommitted, /statement: "Ada must never defend Neri"/,
    "the deliberately unauthorized user-protected retcon remains visible for inspection");
  assert.notEqual(git(job.worktreeRoot, "status", "--porcelain"), "", "preserve interrupted edits");
});

test("Character specialist may add Arc links as a canonical YAML block array", { skip: !available }, () => {
  const { cli, job, architecture } = setup("block-links");
  architecture();
  const run = cli(["foundations", "run", "--fixture", "--skills-source", source], "block-links");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "foundations-committed");
  const arc = readFileSync(join(job.worktreeStoryRoot, "arcs/truth.md"), "utf8");
  assert.match(arc, /characters:\n  - character\.ada\n  - character\.neri\n/);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

test("Arc links may not conceal changed Arc narrative content", { skip: !available }, () => {
  const { cli, job, architecture } = setup("arc-retcon");
  architecture();
  const run = cli(["foundations", "run", "--fixture", "--skills-source", source], "arc-retcon");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Arc cross-domain edit changed more than its characters array/);
  const receipt = JSON.parse(readFileSync(join(job.worktreeRoot, "../character-world.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.equal(receipt.units[1].phase, "writing");
});

test("rejects dangling Character Fact references after canonical validation", { skip: !available }, () => {
  const { cli, job, architecture } = setup("dangling");
  const arch = architecture();
  const invalid = cli(["foundations", "run", "--fixture", "--skills-source", source], "dangling");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /canonical|validation|diagnostic/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD~1"), arch.headSha, "world unit alone was committed");
  assert.equal(git(job.worktreeRoot, "status", "--porcelain") !== "", true);
  const receipt = JSON.parse(readFileSync(join(job.worktreeRoot, "../character-world.json"), "utf8"));
  assert.equal(receipt.units[0].phase, "committed");
  assert.equal(receipt.units[1].phase, "authored");
});

test("interrupted World specialist can be reviewed and resumed without rewriting it", { skip: !available }, () => {
  const { cli, job, architecture } = setup("world-reconciled");
  const arch = architecture();
  const invalid = cli(["foundations", "run", "--fixture", "--skills-source", source], "mismatch");
  assert.notEqual(invalid.status, 0);
  const inspected = cli(["foundations", "inspect"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  const recovery = JSON.parse(inspected.stdout).recovery;
  assert.equal(recovery.status, "blocked");
  assert.equal(recovery.candidate.unit, "world-foundations");
  assert.deepEqual(recovery.candidate.paths, ["facts/evidence-concealed.md", "world-entities/archive.md"]);
  assert.notEqual(cli(["foundations", "reconcile", "--fixture", "--digest", "0".repeat(64)]).status, 0);
  const reviewed = cli(["foundations", "reconcile", "--fixture", "--digest", recovery.candidate.digest]);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).status, "authored");
  const resumed = cli(["foundations", "run", "--fixture"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "foundations-committed");
  assert.equal(git(job.worktreeRoot, "rev-list", "--count", arch.headSha + "..HEAD"), "2");
  assert.match(git(job.worktreeRoot, "log", "-2", "--format=%B"), /NovelTea-Reviewed-Recovery: [a-f0-9]{64}/);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

test("Character commit just before checkpoint is recovered without replaying a second commit", { skip: !available }, () => {
  const { cli, job, architecture } = setup("character-commit-recovery");
  const arch = architecture();
  const first = cli(["foundations", "run", "--fixture", "--skills-source", source]);
  assert.equal(first.status, 0, first.stderr);
  const head = git(job.worktreeRoot, "rev-parse", "HEAD");
  const receiptFile = join(job.worktreeRoot, "../character-world.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.units[1].phase, "committed");
  receipt.units[1].phase = "authored";
  delete receipt.units[1].commitSha;
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const inspected = cli(["foundations", "inspect"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).recovery.status, "recoverable-commit");
  const resumed = cli(["foundations", "run", "--fixture"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "foundations-committed");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(job.worktreeRoot, "rev-list", "--count", arch.headSha + "..HEAD"), "2");
});

test("World recovery fails closed for missing Pi transcript and staged changes", { skip: !available }, () => {
  const { cli, job, architecture } = setup("world-unsafe-recovery");
  architecture();
  assert.notEqual(cli(["foundations", "run", "--fixture", "--skills-source", source], "mismatch").status, 0);
  const receiptFile = join(job.worktreeRoot, "../character-world.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  receipt.worker = "pi";
  receipt.units[0].piSessionId = "original-only";
  receipt.units[0].piSessionFile = join(job.worktreeRoot, "../character-world-sessions/world/missing.jsonl");
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const missing = cli(["foundations", "inspect"]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(JSON.parse(missing.stdout).recovery.reason, /Cannot recover Pi session/);
  assert.notEqual(cli(["foundations", "run"]).status, 0);
  receipt.worker = "fixture";
  writeFileSync(receiptFile, JSON.stringify(receipt));
  git(job.worktreeRoot, "add", "story/facts/evidence-concealed.md");
  const staged = cli(["foundations", "inspect"]);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(JSON.parse(staged.stdout).recovery.candidate, undefined);
  assert.notEqual(cli(["foundations", "reconcile", "--fixture", "--digest", "0".repeat(64)]).status, 0);
  assert.match(git(job.worktreeRoot, "status", "--porcelain"), /^A /m);
});
