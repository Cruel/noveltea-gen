/** Domain checks on actual native-validated author input. The test does not
 * create or infer any specialist, Turn, Review or recovery receipts. */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startStoryJob } from "../src/job.js";
import { nativeExecutable, validateStoryJob } from "../src/validator.js";
import { auditPaths, checkOutput as checkFoundations } from "../src/character-world.js";
import { auditInteractivePaths, checkOutput as checkInteractive, selectAssignment } from "../src/interactive-work.js";
import { changedPaths, selectedAssignment } from "../src/event-work.js";
import { auditCompositionPaths, verifyCompositionProse } from "../src/composition-work.js";
import type { Plan } from "../src/architecture.js";
import type { FoundationAssignment } from "../src/character-world-specialist.js";
import type { CompositionAssignment } from "../src/composition-specialist.js";
import { removeTestTree } from "./helpers.js";

let available = false;
try { available = existsSync(nativeExecutable()); } catch {}
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const contract = { scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
  constraints: [], envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] } };
const plan = { version: 1, contract, items: [{ id: "global-architecture", status: "verified", targetIds: ["arc.truth", "milestone.disclosure"] }] } as Plan;
async function story(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nt-cutover-domain-"));
  const previous = process.env.NT_STATE_DIR;
  process.env.NT_STATE_DIR = join(root, "state");
  t.after(() => { if (previous === undefined) delete process.env.NT_STATE_DIR; else process.env.NT_STATE_DIR = previous; removeTestTree(root); });
  const repo = join(root, "repo"), source = join(repo, "story");
  mkdirSync(repo);
  cpSync(resolve("test/fixtures/archive-witness"), source, { recursive: true });
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author"); git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Authored input");
  const job = await startStoryJob({ story: source, job: "validation" });
  const checked = await validateStoryJob(job);
  assert.equal(checked.status, "passed", JSON.stringify(checked.report?.diagnostics));
  const report = checked.report as any;
  const edit = (path: string, update: (text: string) => string) => {
    const file = join(job.worktreeStoryRoot, path); writeFileSync(file, update(readFileSync(file, "utf8")));
  };
  const restore = () => git(job.worktreeRoot, "restore", "--staged", "--worktree", ".");
  return { job, report, edit, restore };
}

test("Character/World native evidence allows unchanged scoped sources but rejects unrelated retcons and staging", { skip: !available }, async t => {
  const { job, report, edit, restore } = await story(t);
  const sourcePaths = report.records.map((r: any) => r.path);
  const assignment: FoundationAssignment = { domain: "character", arcIds: ["arc.truth"], milestoneIds: ["milestone.disclosure"],
    sourcePaths, scope: contract, decisionAuthority: { existingAuthorChoices: "protected-no-retcon", newSpecialistChoices: "agent-delegated", editorialApproval: "not-granted" } };
  const unit = { id: "character-foundations", domain: "character", paths: ["characters/ada.md"] } as any;
  await checkFoundations(job, report, unit, assignment);
  await assert.rejects(checkFoundations(job, { ...report, records: report.records.filter((r: any) => r.metadata.type !== "relationship") }, unit, assignment), /Fact and a Relationship/);
  await checkFoundations(job, report, { ...unit, domain: "world", paths: ["facts/evidence-concealed.md"] }, { ...assignment, domain: "world" });
  edit("arcs/truth.md", s => s.replace("characters: [character.ada, character.neri]", "characters:\n  - character.ada\n  - character.neri"));
  assert.deepEqual(await auditPaths(job, unit, assignment, ["arcs/truth.md"]), ["arcs/truth.md"]);
  edit("arcs/truth.md", s => s + "\nUnauthorized new dramatic claim.\n");
  await assert.rejects(auditPaths(job, unit, assignment, ["arcs/truth.md"]), /more than its characters array/);
  restore();
  edit("characters/ada.md", s => s + "\nAdditional motivation.\n");
  git(job.worktreeRoot, "add", ".");
  await assert.rejects(auditPaths(job, unit, assignment, ["characters/ada.md"]), /staged/i);
  restore();
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
});

test("Event and Interactive scope gates preserve original prerequisites and reject forged path inventories", { skip: !available }, async t => {
  const { job, report, edit, restore } = await story(t);
  const event = selectedAssignment(job, plan, report, "milestone.disclosure", "event-disclosure");
  assert.throws(() => selectedAssignment(job, plan, report, "milestone.unrelated", "event-unrelated"), /not authorized/);
  const assignment = selectAssignment(plan, report, "milestone.disclosure");
  const eventPath = "events/disclose-ledger.md";
  edit(eventPath, s => s.replace("value: knows", "value: disbelieves"));
  await assert.rejects(auditInteractivePaths(job, assignment, "choice", [eventPath]), /prerequisite/i);
  restore();
  edit("milestones/disclosure.md", s => s + "\nUnapproved milestone retcon.\n");
  await assert.rejects(auditInteractivePaths(job, assignment, "choice", ["milestones/disclosure.md"]), /read.only|scope|Unauthorized interactive specialist/i);
  await assert.rejects(changedPaths(job, event, ["milestones/disclosure.md"]), /Milestone|scope/i);
  restore();
  edit("events/disclose-ledger.md", s => s + "\nAdditional source-bound Event prose.\n");
  await assert.rejects(auditInteractivePaths(job, assignment, "choice", []), /manifest/i);
  restore();
  edit("puzzles/ledger-proof.md", s => s + "\nUnapproved Choice writer edit.\n");
  await assert.rejects(auditInteractivePaths(job, assignment, "choice", ["puzzles/ledger-proof.md"]), /another specialist/);
  restore();
  const choice = await checkInteractive(job, report, report, assignment,
    { domain: "choice", paths: ["choice-points/loyalty.md", eventPath, "events/aftermath.md"] } as any, []);
  assert.ok(choice.choices.some(c => c.id === "choice-point.loyalty"));
  const puzzle = await checkInteractive(job, report, report, assignment,
    { domain: "puzzle", paths: ["puzzles/ledger-proof.md", "events/decode-ledger.md", "events/request-testimony.md"] } as any, []);
  assert.ok(puzzle.puzzles.some(p => p.id === "puzzle.ledger-proof"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});

test("Composition native and Git gates retain branch, Revelation, clue and ending checks without a fixture writer", { skip: !available }, async t => {
  const { job, report, edit, restore } = await story(t);
  const paths = ["authored-content/disclosure-scene.md", "authored-content/aftermath-continuation.md",
    "authored-content/decode-ledger-ending.md", "authored-content/request-testimony-ending.md",
    "authored-content/watermark-clue.md", "authored-content/seal-clue.md"];
  const events = report.records.filter((r: any) => r.metadata.type === "event").map((r: any) => r.metadata.id);
  const assignment = { milestoneId: "milestone.disclosure", workItemId: "composition-disclosure", authorContract: contract,
    eventOnly: false, sourcePaths: report.records.map((r: any) => r.path), mandatoryReads: [], allowedExistingContent: paths,
    eventIds: events, composeTargets: events, choicePoints: [{ id: "choice-point.loyalty", events: ["event.disclose-ledger"], outcomes: ["protect", "challenge"] }],
    puzzleSolutions: [{ id: "puzzle.ledger-proof", eventIds: ["event.decode-ledger", "event.request-testimony"] }],
    branchWitnesses: [], requiredSources: events } as CompositionAssignment;
  const validate = () => verifyCompositionProse(job, report, assignment, paths);
  assert.deepEqual((await validate()).outcomes, ["challenge", "protect"]);
  const main = paths[0]!;
  for (const [update, failure] of [
    [(s: string) => s.replace("Ada studies the register.", "Ada knows the ledger-secret."), /Branch-exclusive Revelation/],
    [(s: string) => s.replace("Ada studies the register.", "Ada studies the watermark."), /Optional discovery clue/],
    [(s: string) => s.replace("## Challenge selected", "## Omitted"), /Missing shared\/choice\/branch prose/],
  ] as const) {
    edit(main, update); await assert.rejects(validate(), failure); restore();
  }
  edit(paths[1]!, s => s.replace("## Challenge selected", "## Omitted"));
  await assert.rejects(validate(), /distinct conditioned outcome sections/); restore();
  edit(paths[2]!, s => s.replace("## Solution consequence", "## Omitted"));
  await assert.rejects(validate(), /solution ending prose/); restore();
  edit(main, s => s + "\nAda pauses.\n");
  assert.deepEqual(await auditCompositionPaths(job, assignment, [main]), [main]);
  git(job.worktreeRoot, "add", ".");
  await assert.rejects(auditCompositionPaths(job, assignment, [main]), /staged/i); restore();
  edit("events/disclose-ledger.md", s => s + "\nOut of scope.\n");
  await assert.rejects(auditCompositionPaths(job, assignment, ["events/disclose-ledger.md"]), /read-only Event/);
  restore();
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), job.baseSha);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
});
