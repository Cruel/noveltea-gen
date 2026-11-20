import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { hostname as requireHostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { validateStoryJob } from "../src/validator.js";
import { changedPaths, eventPrerequisiteReportDigest, hasDeferredChoiceBinding,
  currentMilestoneChoiceBinding } from "../src/event-work.js";
import { milestoneBodyOnlyDrift, milestoneBaselineBody,
  assertMilestoneFulfillmentOnly } from "../src/milestone-field-scope.js";
import { parseMilestoneBlueprint, parseMilestoneBlueprintReview,
  readReviewedMilestoneBlueprint } from "../src/milestone-blueprint.js";
import { reviewedMilestoneHandoff, assertMilestoneInteractiveDisposition,
  assertMilestoneCanonicalClosure } from "../src/milestone-obligation-handoff.js";
import {
  canonicalFrontmatterStructureError, parseEventManifest, scopedEventEvidenceConflict,
  eventEvidenceRepairFeedback, eventEvidenceRetryAllowed, eventSpecialistPrompt,
  scopedNondecisionChoiceDeferral, eventNondecisionChoiceCorrection,
  scopedDecisionSetupConflict, eventDecisionSetupCorrection,
  observedNondecisionMilestone, eventMilestoneBodyRestoreFeedback,
} from "../src/event-specialist.js";

test("Event handoff recognizes Luna's explicit Choice-owner binding without accepting a vague choice mention", () => {
  for (const instruction of [
    "The later Choice owner must bind protect-or-confront outcomes and effects.",
    "Formal Choice binding remains for the separately reviewed interactive unit.",
    "A formal Choice must be added by the subsequent specialist.",
    "Choice Point binding is required for both outcomes.",
    "The Choice specialist must author the selected outcome.",
    "Choice author: implement the formal player decision, bind its real outcome routes, " +
      "and carry consequences into different endings. The milestone remains partial until enacted.",
  ]) {
    assert.equal(hasDeferredChoiceBinding([instruction]), true, instruction);
  }
  assert.equal(hasDeferredChoiceBinding([
    "A player choice may become relevant in final prose.",
    "Puzzle owner will add new clues.",
  ]), false);
});

test("live Luna decision-setup manifest preserves partial Milestone and original Choice author handoff", () => {
  const actual = [
    "Choice author: implement the formal player decision, bind its real outcome routes, and " +
      "carry their consequences into meaningfully different endings. The milestone remains " +
      "partial until that decision is enacted.",
    "Later Event/Choice authors: establish any missing confrontation and decision-dependent " +
      "outcome effects before claiming the milestone’s full narrative promise is met.",
    "Composition author: create linked authored content for the Events; this Event’s body " +
      "is not an engine-playability guarantee.",
  ];
  const actualChange =
    "The player moves from evaluating an evidence-bounded account to enacting a " +
    "consequential response to the incident and the train's predicament. That response " +
    "changes what happens to people aboard and opens meaningfully different ending outcomes.";
  assert.equal(hasDeferredChoiceBinding(actual), true,
    "Explicit Choice author is an authorized future handoff, not a no-write blocker.");
  assert.equal(currentMilestoneChoiceBinding(actual, "milestone.choice-enacted", actualChange),
    true, "This source Milestone really requires later Choice enactment.");
  assert.equal(hasDeferredChoiceBinding([
    "The Choice author may provide flavor text, but this Milestone has no pending binding.",
  ]), false, "A role name alone does not establish a binding obligation.");
});

test("later Story Choice obligations do not block the source-supported opening nondecision Milestone", () => {
  const opening = "The disappearance is recognized as the immediate unresolved problem: " +
    "the player knows whom travelers mean by the missing passenger and has a usable starting point " +
    "for inquiry, but does not yet know what happened.";
  const later = [
    "The later consequential player choice, its outcomes, and supported outcome effects remain " +
      "to be authored and bound; no Choice Point ID is established.",
    "The next formal Choice will belong to milestone.explanation-and-choice.",
  ];
  assert.equal(hasDeferredChoiceBinding(later), true, "The unscoped text mentions Choice work");
  assert.equal(currentMilestoneChoiceBinding(
    later, "milestone.disappearance-established", opening), false,
  "Unrelated future Choice must not block a distinct nondecision milestone.");
  assert.equal(currentMilestoneChoiceBinding([
    "A formal Choice owner must bind this milestone.disappearance-established's outcomes.",
  ], "milestone.disappearance-established", opening), true,
  "A source-specific binding for the current Milestone remains mandatory.");
  assert.equal(currentMilestoneChoiceBinding(later, "milestone.explanation-and-choice",
    "The player chooses whether to expose or conceal the evidence, with different consequences."), true,
  "An authored Milestone that explicitly promises Choice remains incomplete until enacted.");
  assert.equal(currentMilestoneChoiceBinding([
    "Choice Point binding is required for both outcomes",
  ], "milestone.disappearance-established", opening), true,
  "An unqualified outstanding Choice binding must still fail closed.");
});

test("an authored Event's missing in-scope access evidence receives a bounded correction, not a new authority", () => {
  const milestone = "milestone.disappearance-established";
  const assignment = { milestoneId: milestone,
    milestonePath: "milestones/train-milestones.md",
    characterIds: ["character.ines-vale", "character.soren-ward"] } as any;
  const exact = "The validator requires a deterministically reachable fulfillment route for " +
    milestone + ", but the Event does not establish the Milestone’s access-related support: " +
    "which spaces and people were accessible during the relevant interval. " +
    "Binding this Event alone would claim a fulfilled route without establishing that material clause.";
  assert.equal(scopedEventEvidenceConflict(assignment, [exact]), true);
  const correction = eventEvidenceRepairFeedback(assignment, [exact], [
    "event.incident-inquiry",
  ]);
  assert.match(correction, /same|CURRENT/i);
  assert.match(correction, /source|witness|testimony/i);
  assert.match(correction, /current.*Event|Event.*current/i);
  assert.match(correction, /access|interval/);
  assert.match(correction, /not.*(?:proof|objective|omniscient|truth)/i);
  assert.match(correction, /fulfillment/);
  assert.match(correction, /milestones\/train-milestones.md/);
  assert.match(correction, /event\.incident-inquiry/);
  assert.match(correction, /complete and fulfillment\.any_of/);
  assert.match(correction, /NOT a later specialist|not a later specialist/i);
  assert.match(correction, /review happens AFTER/i);
  assert.match(correction, /story_validate/);
  assert.doesNotMatch(correction, /(?:grant|authorize) (?:new|additional)/i);
  for (const invalid of [
    "The architecture requires a new upstream Character for " + milestone,
    "A protected author decision must be retconned to establish " + milestone,
    "Out of scope: add a new Fact before " + milestone,
    "The Event's absence is impossible: no existing witness can observe it.",
    "The validator requires a route for milestone.some-other-scope, not " + milestone,
  ]) assert.equal(scopedEventEvidenceConflict(assignment, [invalid]), false, invalid);
  assert.equal(scopedEventEvidenceConflict(assignment, []), false);
  assert.equal(scopedEventEvidenceConflict(assignment, [exact, "New Character required"]), false);
});

test("saved Luna Event evidence gap uses the assigned Milestone without repeating its ID", () => {
  const assignment = {
    milestoneId: "milestone.accounts-and-traces-compared",
    milestonePath: "milestones/accounts-and-traces-compared.md",
  };
  // Exact conflict from a preserved Luna certification. Native validation passed,
  // but Luna accurately reported an insufficient comparison in its own Event.
  const conflict = "The Event supplies an independent present-day physical observation, " +
    "but does not establish the Milestone’s required comparison of materially conflicting accounts. " +
    "Ines’s remembered sighting and an unauthenticated, undated note do not materially conflict; " +
    "the trace cannot establish timing. The Milestone therefore remains partial and unbound.";
  assert.equal(scopedEventEvidenceConflict(assignment, [conflict]), true,
    "The controller owns the target identity; Luna need not repeat its canonical ID.");
  const feedback = eventEvidenceRepairFeedback(assignment, [conflict],
    ["event.accounts-and-traces-compared"]);
  assert.match(feedback, /EVENT_LOCAL_EVIDENCE/);
  assert.match(feedback, /SAME authorized Event/);
  assert.match(feedback, /milestone\.accounts-and-traces-compared/);
  assert.match(feedback, /event\.accounts-and-traces-compared/);
  assert.match(feedback, /do not invent.*(?:time record|Character)/i);
  assert.match(feedback, /review happens AFTER/i);

  for (const invalid of [
    conflict + " Actually fulfill milestone.arrival-and-resolution instead.",
    conflict + " Modify milestone.arrival-and-resolution, not this one.",
    conflict + " A protected author decision must change first.",
    conflict + " A new Character is required to supply the other account.",
    "A different Milestone has no testable evidence.",
    "The Event lacks a basis for writing to unrelated records.",
    "The Event needs a new upstream Fact before this Milestone can be completed.",
  ]) assert.equal(scopedEventEvidenceConflict(assignment, [invalid]), false, invalid);
  assert.equal(scopedEventEvidenceConflict(assignment, [
    "The physical observation does not establish timing, without any identified Milestone.",
  ]), false, "Unanchored prose must not be treated as current-Milestone authority");
});

test("Event-local ledger discrepancy can be repaired through player-visible evidence, never a retconned Fact", () => {
  const assignment = { milestoneId: "milestone.ledger-compared",
    milestonePath: "milestones/ledger-compared.md" };
  const conflict = "The selected Milestone lacks material evidence: this Event alleges " +
    "concealed alteration of a record, but the player cannot inspect the claimed " +
    "discrepancy. A reachable inference cannot be established by the current clue.";
  assert.equal(scopedEventEvidenceConflict(assignment, [conflict]), true);
  const feedback = eventEvidenceRepairFeedback(assignment, [conflict]);
  assert.match(feedback, /show the PLAYER the actual inspectable discrepancy/);
  assert.match(feedback, /unsupported assertion that a record was changed/i);
  assert.match(feedback, /not.*independent observation/i);
  for (const suffix of [
    " A new Fact must be created by another owner.",
    " An earlier Event is necessary.",
    " The protected Arc decision must be retconned.",
  ]) assert.equal(scopedEventEvidenceConflict(assignment, [conflict + suffix]), false);
});

test("only a source-exact Milestone body drift is repairable without expanding Event authority", () => {
  const baseline = [
    "---", "schema: '0.1'", "type: milestone",
    "id: milestone.absence-recognized", "title: The Absence Becomes a Case", "status: draft",
    "completeness: partial", "decisions:", "  - id: baseline",
    "    statement: A protected observation", "    authority: user-protected",
    "fulfillment:", "  any_of: []", "---",
    "", "This is the original narrative promise, not the eventual Event proof.",
  ].join("\n");
  const binding = baseline.replace("completeness: partial", "completeness: complete")
    .replace("  any_of: []", "  any_of:\n    - - event.absence-recognized");
  const polluted = binding.replace(
    "This is the original narrative promise, not the eventual Event proof.",
    "The Event is now finished and the Milestone body should explain why.");
  assert.equal(milestoneBodyOnlyDrift(baseline, binding), false);
  assert.equal(milestoneBodyOnlyDrift(baseline, polluted), true);
  assert.throws(() => assertMilestoneFulfillmentOnly(baseline, polluted, true),
    /unrelated Milestone metadata\/body/);
  const body = milestoneBaselineBody(baseline);
  assert.match(body, /original narrative promise/);
  const feedback = eventMilestoneBodyRestoreFeedback("milestones/absence-recognized.md", body);
  assert.match(feedback, /ORIGINAL NARRATIVE BODY/);
  assert.match(feedback, /SAME Pi session/);
  assert.match(feedback, /fulfillment\.any_of/);
  assert.doesNotThrow(() => assertMilestoneFulfillmentOnly(baseline, binding, true));
  for (const tampered of [
    polluted.replace("A protected observation", "A fake author override"),
    polluted.replace("title: The Absence Becomes a Case", "title: A New Scope"),
    polluted.replace("id: milestone.absence-recognized", "id: milestone.other-scope"),
  ]) assert.equal(milestoneBodyOnlyDrift(baseline, tampered), false,
    "Protected/other metadata must never be corrected by the body-only path.");
  assert.throws(() => eventMilestoneBodyRestoreFeedback("../escape.md", body), /noncanonical/);
  assert.throws(() => eventMilestoneBodyRestoreFeedback(
    "milestones/absence-recognized.md", "x".repeat(16_001)), /unbounded/);
});

test("non-Choice Event-only preflight recognizes observation, inference, and unconditional rescue wording", () => {
  const valid = [
    "Alex immediately releases Mara, tests the operative restraint and brings her to safety without conditioning rescue on testimony.",
    "Alex learns of the apparent boarding allegation and identifies an unproven link between separate signals.",
    "Independent audit and camera comparisons establish the staged crossing and defeat the signals as proof.",
    "Alex locates the missing witness alive and links her confinement to the physical restraint.",
  ];
  for (const change of valid) assert.equal(observedNondecisionMilestone(change), true, change);
  const invalid = [
    "Alex chooses whether to expose the identifying record or conceal the evidence.",
    "Alex learns about the situation, then decides which witness to protect.",
    "Alex chooses a branch after observing the signals.",
    "Alex acquires supplier details and commits to protecting the copy or revealing it to the culprit.",
  ];
  for (const change of invalid) assert.equal(observedNondecisionMilestone(change), false, change);
});

test("only one additional evidence-only correction fits the bounded Event retry budget", () => {
  const local = "EVENT_LOCAL_EVIDENCE: Missing player-observed access during the interval.";
  assert.equal(eventEvidenceRetryAllowed(0, ["ordinary native diagnostic"]), true);
  assert.equal(eventEvidenceRetryAllowed(1, ["ordinary native diagnostic"]), true);
  assert.equal(eventEvidenceRetryAllowed(2, [local]), true);
  assert.equal(eventEvidenceRetryAllowed(2, [
    "EVENT_MILESTONE_BODY_RESTORE: Restore the exact original Milestone body.",
  ]), true);
  assert.equal(eventEvidenceRetryAllowed(2, [local, local]), true);
  assert.equal(eventEvidenceRetryAllowed(2, ["Selected Milestone lacks a route"]), false);
  assert.equal(eventEvidenceRetryAllowed(2, [local, "Unauthorized protected author change"]), false);
  assert.equal(eventEvidenceRetryAllowed(2, []), false);
  assert.equal(eventEvidenceRetryAllowed(3, [local]), false);
  assert.equal(eventEvidenceRetryAllowed(4, [local]), false);
  assert.equal(eventEvidenceRetryAllowed(-1, [local]), false);
});

test("nondecision Milestone authority metadata does not require a formal Choice Point", () => {
  const conflict = "The opening Event is reachable and provides the investigation setup, but " +
    "the independent validator reports that an unbound Choice obligation cannot certify a completed " +
    "Milestone or its fulfillment IDs. The Milestone is therefore left partial with empty " +
    "fulfillment.any_of; this does not certify fulfillment of the nondecision Milestone.";
  const observed = "The player has encountered an observable basis for treating a passenger " +
    "as missing, and inquiry into the absence has become the shared immediate problem aboard " +
    "the stranded train; the passenger's fate and cause remain unresolved.";
  assert.equal(observedNondecisionMilestone(observed), true);
  assert.equal(scopedNondecisionChoiceDeferral([conflict], observed), true);
  const realConflict = "The validator rejected binding event.disappearance-established to " +
    "the selected Milestone because an unbound Choice obligation cannot certify a " +
    "completed Milestone or authored fulfillment IDs. The Milestone is therefore " +
    "left partial with fulfillment.any_of empty; the Event remains complete and reachable as a setup.";
  assert.equal(scopedNondecisionChoiceDeferral([realConflict], observed), true,
    "Exact real Luna failure must not depend on the model saying 'nondecision'.");
  assert.equal(currentMilestoneChoiceBinding([
    "After the Choice obligation is resolved, reassess and bind the reachable Event route to milestone.disappearance-established.",
    "Author the later formal Choice, its enacted consequences, and different endings.",
  ], "milestone.disappearance-established", observed), false,
  "A false Choice prerequisite and future Choice do not become source requirements.");
  const assignment = {
    milestoneId: "milestone.disappearance-established",
    milestonePath: "milestones/disappearance-established.md",
  };
  const feedback = eventNondecisionChoiceCorrection(
    assignment, [conflict], observed, ["event.disappearance-established"]);
  assert.match(feedback, /decisions: as AUTHOR authority metadata/);
  assert.match(feedback, /NOT executable Choice Point/);
  assert.match(feedback, /event\.disappearance-established/);
  assert.match(feedback, /fulfillment\.any_of/);
  assert.match(feedback, /completeness: complete\nfulfillment:\n  any_of:\n    - - event\.disappearance-established/);
  assert.match(feedback, /SAME Pi session/);
  assert.match(feedback, /source-supported|genuine/i);
  assert.doesNotMatch(feedback, /new writing grant|ignore protection/i);
  for (const source of [
    conflict + " A protected author decision must change.",
    "A formal Choice Point is required by the protected author.",
    "The Milestone is nondecision, but a new Character is needed.",
    "An unbound Choice still prevents a separate unrelated Milestone.",
  ]) assert.equal(scopedNondecisionChoiceDeferral([source], observed), false, source);
  assert.equal(scopedNondecisionChoiceDeferral([], observed), false);
  assert.equal(scopedNondecisionChoiceDeferral([conflict],
    "The player chooses which suspect to confront and must enact two different outcomes."), false,
  "A true Choice-dependent source cannot be downgraded by a model report.");
  assert.equal(scopedNondecisionChoiceDeferral([conflict], ""), false);
  assert.throws(() => eventNondecisionChoiceCorrection(assignment,
    ["The author expressly requires a formal Choice Point"], observed), /cannot be downgraded/);
});

test("a real Choice Milestone can commit an Event setup without falsely claiming enacted outcomes", () => {
  const assigned = {
    milestoneId: "milestone.choice-enacted",
    milestonePath: "milestones/choice-enacted.md",
  };
  const source = "The player enacts a consequential decision with outcomes that change " +
    "what happens aboard the stranded train and which evidence remains available.";
  const exact = "The selected Milestone is explicitly decision-dependent: it requires " +
    "an enacted consequential response and outcomes that change what happens aboard. " +
    "The current Event is a setup only, so binding it as fulfillment or marking the " +
    "Milestone complete would falsely claim the decision occurred. " +
    "milestones/choice-enacted.md remains partial with empty fulfillment.any_of.";
  assert.equal(scopedDecisionSetupConflict(assigned, source, [exact]), true);
  const correction = eventDecisionSetupCorrection(assigned, source, [exact]);
  assert.match(correction, /PRE-DECISION setup/);
  assert.match(correction, /MUST remain partial/);
  assert.match(correction, /laterObligations/);
  assert.match(correction, /SAME Pi session/);
  assert.doesNotMatch(correction, /mark .*complete.*now/i);
  assert.equal(eventEvidenceRetryAllowed(2, [correction]), true);
  assert.equal(eventEvidenceRetryAllowed(3, [correction]), false);
  assert.equal(scopedDecisionSetupConflict(assigned,
    "The player observes clues and identifies a missing passenger.", [exact]), false);
  for (const bad of [
    exact + " A protected author decision must change.",
    exact + " A new Character is required to enact the outcome.",
    exact + " An earlier Event requires revision.",
    "Another Milestone has missing evidence and a Choice is required.",
  ]) assert.equal(scopedDecisionSetupConflict(assigned, source, [bad]), false, bad);
  assert.equal(scopedDecisionSetupConflict(assigned, source, []), false);
  assert.throws(() => eventDecisionSetupCorrection(assigned, source,
    ["We need an unrelated new World Fact"]), /cannot be reclassified/);
});

test("Event prompt distinguishes material nondecision evidence from later Choice binding", () => {
  const assignment = {
    milestoneId: "milestone.disappearance-established",
    milestonePath: "milestones/train-milestones.md",
    sourcePaths: ["milestones/train-milestones.md", "facts/absence.md"],
    arcIds: ["arc.mystery"], characterIds: ["character.one", "character.two"],
    workItemId: "event-disappearance-established", contract: {
      scope: { kind: "full-story" }, envelope: { presentation: "Visual novel" },
      constraints: [],
    }, authority: { existingProtectedChoices: "no-retcon", delegatedChoices: "draft",
      signingRequiredForProtectedChanges: true },
  } as any;
  const snapshot = { id: "f".repeat(64), path: "/pinned/skills", commit: "a".repeat(40) } as any;
  const prompt = eventSpecialistPrompt(snapshot, assignment, true);
  assert.match(prompt, /nondecision Milestone/i);
  const planned = eventSpecialistPrompt(snapshot, { ...assignment,
    milestoneBlueprint: { digest: "b".repeat(64), design: {
      schema: "noveltea-milestone-blueprint/v1", milestoneId: assignment.milestoneId,
      events: [{ id: "discovery", purpose: "Reachable proof", dependsOn: [],
        evidence: [{ anchorPath: assignment.milestonePath, source: "Witness",
          observation: "A visible trace", access: "Investigator can inspect",
          establishes: "Limited discrepancy", limits: "No timing certainty" }],
        participants: ["character.one"], knowledge: "Witnessed evidence only", routes: [] }],
      downstream: [{ owner: "composition", obligation: "Present proof" }],
    } },
  }, true);
  assert.match(planned, /REVIEWED LOCAL PLAN/);
  assert.match(planned, /not canonical evidence/);
  assert.match(planned, /visible trace/);
  assert.match(planned, /additional writable paths|new writable paths/i);
  assert.match(prompt, /fulfillment\.any_of/);
  assert.match(prompt, /Independent review occurs AFTER/);
  assert.match(prompt, /Do not confuse the selected Milestone's YAML decisions:/);
  assert.match(prompt, /NOT require a future Choice/);
  assert.match(prompt, /in this Event/i);
  assert.match(prompt, /witness|testimony/i);
  assert.match(prompt, /partial.*Choice/i);
  assert.match(prompt, /optional witness testimony/i);
  assert.match(prompt, /conditional Event routing/i);
  assert.match(prompt, /Do not claim testimony, consent, trust or forgiveness/i);
  assert.match(prompt, /do not.*(?:invent|assert)/i);
});

test("no-write Event reports are explicit, bounded and never confused with a successful author manifest", () => {
  const input = '{"modifiedRecords":[],"architecturalConflicts":["Needs a Choice specialist"],"laterObligations":["Interactive route outcomes"]}';
  assert.deepEqual(parseEventManifest(input), { modifiedRecords: [],
    architecturalConflicts: ["Needs a Choice specialist"],
    laterObligations: ["Interactive route outcomes"] });
  assert.throws(() => parseEventManifest('{"modifiedRecords":[],"architecturalConflicts":[],"laterObligations":[]}'),
    /manifest/);
  assert.throws(() => parseEventManifest('{"modifiedRecords":[],"architecturalConflicts":"needs work","laterObligations":[]}'),
    /manifest/);
  const claim = { jobId: "job", workItemId: "event-disclosure", expectedHead: "a".repeat(40),
    planDigest: "b".repeat(64), sessionSha256: "c".repeat(64), sessionId: "session",
    assignmentDigest: "d".repeat(64), snapshotId: "e".repeat(64),
    sessionFile: "/state/original-session.jsonl", worker: "pi" as const,
    conflicts: ["Requires a Choice"], obligations: ["Build distinct endings"] };
  const digest = eventPrerequisiteReportDigest(claim);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, eventPrerequisiteReportDigest({ ...claim, conflicts: ["Requires another owner"] }));
  for (const invalid of [{ ...claim, conflicts: [], obligations: [] },
    { ...claim, sessionSha256: "bad" },
    { ...claim, obligations: ["x".repeat(1501)] },
    { ...claim, workItemId: "../untrusted" }])
    assert.throws(() => eventPrerequisiteReportDigest(invalid), /no-write prerequisite report/);
});

test("early Event draft preflight identifies truncated YAML instead of mistaking it for a validator defect", () => {
  assert.equal(canonicalFrontmatterStructureError("---\nschema: '0.1'\ntype: event\nid: event.clue\n"),
    "The file is missing its closing --- delimiter after YAML frontmatter.");
  assert.equal(canonicalFrontmatterStructureError("---\nschema: '0.1'\n---\n"),
    "The file has no narrative Markdown body after the closing --- delimiter.");
  assert.equal(canonicalFrontmatterStructureError("schema: '0.1'\n---\nStory\n"),
    "The first line must be exactly --- (YAML frontmatter opening).");
  assert.equal(canonicalFrontmatterStructureError("---\nschema: '0.1'\n---\nA clue is discovered.\n"), null);
  assert.equal(canonicalFrontmatterStructureError("---\r\nschema: '0.1'\r\n---\r\nText\r\n"), null);
});

const root = mkdtempSync(join(tmpdir(), "nt-event-work-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));
function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
function setup(name: string) {
  const repo = join(root, name);
  const story = join(repo, "story");
  mkdirSync(join(story, "creative-direction"), { recursive: true });
  writeFileSync(join(story, "creative-direction/foundation.md"), `---
schema: '0.1'
type: creative-direction
id: creative-direction.foundation
title: "A missing witness"
status: draft
decisions:
  - id: loyalty
    statement: "The player may protect the friend or seek accountability"
    origin: user
    authority: user-protected
premise: "A vanished witness unsettles a small archive"
central_conflict: "Expose evidence or preserve loyalty"
genre: "Mystery"
tone: "Intimate"
player_experience: "Investigative dialogue choices"
scope: "Two key Characters and one reusable location"
---

A missing witness leaves a ledger and suspicion between two former collaborators.
`);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Author");
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Author's creative direction");
  const baseline = git(repo, "rev-parse", "HEAD");
  const env = { ...process.env, NT_STATE_DIR: join(root, name + "-state"),
    NT_SKILL_CACHE_DIR: join(root, "skills"),

    NT_CONFIG_FILE: join(root, "absent-config.json") };
  function cli(args: string[], variant?: string) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "job", ...args,
      "--story", story, "--job", "draft"], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
      env: { ...env, NT_EVENT_FIXTURE_CASE: variant ?? "" },
    });
  }
  const initialized = cli(["start"]); assert.equal(initialized.status, 0, initialized.stderr);
  const job = JSON.parse(initialized.stdout);
  const contractFile = join(root, name + "-contract.json");
  writeFileSync(contractFile, JSON.stringify({ scope: {
    kind: "partial", depth: "interactive",
    targets: ["arc.truth", "milestone.disclosure"], branches: ["trust-route", "confrontation-route"],
  }, constraints: ["Preserve loyalty and ensure disclosure can come through choice"],
  envelope: { presentation: "Dialogue-driven visual novel", hardLimits: ["Reuse archive background"],
    preferences: ["Two central Characters"] } }));
  function prepare() {
    const arch = cli(["architecture", "run", "--fixture", "--contract", contractFile, "--skills-source", source]);
    assert.equal(arch.status, 0, arch.stderr);
    const foundations = cli(["foundations", "run", "--fixture", "--skills-source", source]);
    assert.equal(foundations.status, 0, foundations.stderr);
    const head = JSON.parse(foundations.stdout).headSha;
    return head as string;
  }
  function event(variant?: string, milestone = "milestone.disclosure") {
    return cli(["event", "run", "--fixture", "--milestone", milestone, "--skills-source", source], variant);
  }
  return { repo, story, job, baseline, cli, prepare, event };
}

test("#207 Milestone plan validates local causality and rejects invented source/participant authority", () => {
  const assignment = { milestoneId: "milestone.disclosure", milestonePath: "milestones/disclosure.md",
    sourcePaths: ["milestones/disclosure.md", "arcs/truth.md"],
    characterIds: ["character.ada", "character.ben"] };
  const local = { schema: "noveltea-milestone-blueprint/v1", milestoneId: assignment.milestoneId,
    events: [{ id: "observe-proof", purpose: "Find inspectable evidence", dependsOn: [],
      evidence: [{ anchorPath: assignment.milestonePath, source: "A witness and recorded trace",
        observation: "Inspect an in-scene trace", access: "Player can reach witness",
        establishes: "A limited discrepancy", limits: "Timing remains unverified" }],
      participants: ["character.ada"], knowledge: "Only Ada sees the trace",
      routes: [{ condition: "Witness cooperates", consequence: "Later trust becomes possible" }] }],
    downstream: [{ owner: "composition", obligation: "Make evidence visible in player prose" }] };
  assert.deepEqual(parseMilestoneBlueprint(JSON.stringify(local), assignment), local);
  assert.throws(() => parseMilestoneBlueprint(JSON.stringify({ ...local,
    events: [{ ...local.events[0], participants: ["character.not-authorized"] }] }), assignment),
  /Character knowledge/);
  assert.throws(() => parseMilestoneBlueprint(JSON.stringify({ ...local,
    events: [{ ...local.events[0], evidence: [{ ...local.events[0].evidence[0],
      anchorPath: "events/imaginary.md" }] }] }), assignment), /canonical anchor/);
  assert.throws(() => parseMilestoneBlueprint(JSON.stringify({ ...local,
    downstream: [{ owner: "none", obligation: "Someone handles the future" }] }), assignment),
  /downstream obligation/);
  const pass = { schema: "noveltea-milestone-blueprint-review/v1", status: "pass", findings: [] };
  assert.deepEqual(parseMilestoneBlueprintReview(JSON.stringify(pass), local as any, assignment), pass);
  assert.throws(() => parseMilestoneBlueprintReview(JSON.stringify({ ...pass,
    findings: [{ eventId: "observe-proof", anchorPath: "events/unwritten.md",
      requirement: "Evidence", reason: "Not plausible", correction: "Clarify" }] }), local as any, assignment),
  /source-bound verdict|current Event\/source/);
});

test("#207 plans just the reached Milestone, binds Event handoff and rejects stale private proof", { skip: !available }, async () => {
  const f = setup("local-milestone-gate");
  assert.notEqual(f.event().status, 0, "Planning before canonical Architecture/World/Character must fail");
  const sourceHead = f.prepare();
  const folder = join(f.job.stateDir, "milestone-blueprints");
  assert.equal(existsSync(folder), false, "Architecture and foundations cannot preplan future Milestones");
  const first = f.event();
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, "event-cluster-committed");
  const blueprintFile = join(folder, "disclosure.json");
  assert.equal(existsSync(blueprintFile), true);
  const files = spawnSync("find", [folder, "-type", "f", "-name", "*.json"], { encoding: "utf8" });
  assert.deepEqual(files.stdout.trim().split("\n"), [blueprintFile],
    "Other Milestones must not receive private plans early");
  const local = JSON.parse(readFileSync(blueprintFile, "utf8"));
  assert.equal(local.phase, "approved");
  assert.equal(local.lineage.executionHead, sourceHead);
  assert.equal(local.rounds.length, 1);
  assert.equal(local.rounds[0].review.status, "pass");
  assert.equal(local.draft.milestoneId, "milestone.disclosure");
  const eventReceipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  assert.equal(eventReceipt.blueprintPin.digest, local.approvedDigest);
  assert.equal(eventReceipt.assignment.milestoneBlueprint.digest, local.approvedDigest);
  assert.match(git(f.job.worktreeRoot, "log", "-1", "--format=%B"),
    new RegExp("NovelTea-Milestone-Blueprint: " + local.approvedDigest));
  assert.deepEqual(await readReviewedMilestoneBlueprint(f.job, eventReceipt.blueprintPin,
    eventReceipt.assignment), local.draft);
  const inspect = f.cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).localPlanning.phase, "approved");
  const second = f.event();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).milestoneBlueprint.digest, local.approvedDigest);
  assert.equal(readFileSync(blueprintFile, "utf8"), JSON.stringify(local, null, 2) + "\n",
    "Inspect/restart must not regenerate or rewrite the approved plan");
  await assert.rejects(readReviewedMilestoneBlueprint(f.job, { ...eventReceipt.blueprintPin,
    sourceSha: "a".repeat(40) }, eventReceipt.assignment), /another job, Thread or source/);
  writeFileSync(blueprintFile, JSON.stringify({ ...local, approvedDigest: "b".repeat(64) }));
  assert.notEqual(f.cli(["event", "inspect", "--milestone", "milestone.disclosure"]).status, 0,
    "Read-only inspection must reject tampered approval, not display it as verified");
  await assert.rejects(readReviewedMilestoneBlueprint(f.job, eventReceipt.blueprintPin,
    eventReceipt.assignment), /no approved independent/);
  writeFileSync(blueprintFile, JSON.stringify({ ...local, lineage: {
    ...local.lineage, model: "forged-model" } }));
  await assert.rejects(readReviewedMilestoneBlueprint(f.job, eventReceipt.blueprintPin,
    eventReceipt.assignment), /another job, Thread or source/,
  "Even unchanged plan bytes cannot inherit a different model's review identity");
});

test("#208 carries only the source-verified reached Milestone into downstream review", { skip: !available }, async () => {
  const f = setup("reviewed-milestone-handoff");
  f.prepare();
  const written = f.event();
  assert.equal(written.status, 0, written.stderr);
  const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  const reviewed = await reviewedMilestoneHandoff(f.job, receipt);
  assert.ok(reviewed);
  assert.equal(reviewed!.pin.digest, receipt.blueprintPin.digest);
  assert.equal(reviewed!.eventHead, receipt.commitSha);
  assert.equal(reviewed!.design.milestoneId, "milestone.disclosure");
  assert.equal(reviewed!.design.downstream[0].owner, "composition");
  assert.doesNotThrow(() => assertMilestoneInteractiveDisposition(reviewed, true),
    "The reviewed Event-only plan does not create an arbitrary Choice quota.");
  assert.throws(() => assertMilestoneInteractiveDisposition({
    ...reviewed!, design: { ...reviewed!.design, downstream: [
      { owner: "interactive", obligation: "Bind this Milestone's real decision and lasting consequences" },
    ] },
  }, true), /interactive Milestone obligations/);
  assert.throws(() => assertMilestoneCanonicalClosure(reviewed,
    "milestone.disclosure", [
      { metadata: { id: "milestone.disclosure", type: "milestone", status: "active",
        completeness: "partial", fulfillment: { any_of: [] } } },
    ], [{ id: "milestone.disclosure", routes: [] }]), /unresolved canonical fulfillment/);
  const validated = await validateStoryJob(f.job);
  assert.equal(validated.status, "passed");
  const catalog = validated.report as { records: Array<{ metadata: Record<string, any> }>;
    coverage: { milestoneRoutes: Array<{ id: string; routes: Array<{ status: string }> }> } };
  assert.doesNotThrow(() => assertMilestoneCanonicalClosure(reviewed,
    "milestone.disclosure", catalog.records, catalog.coverage.milestoneRoutes),
  "A genuinely completed, native-verified Event Milestone can close.");
  assert.doesNotThrow(() => assertMilestoneCanonicalClosure(reviewed,
    "milestone.disclosure", [
      { metadata: { id: "milestone.disclosure", type: "milestone", status: "active",
        completeness: "complete", fulfillment: { any_of: [["event.disclose-ledger"]] } } },
    ], [{ id: "milestone.disclosure", routes: [{ status: "reachable" }] }]));
  await assert.rejects(reviewedMilestoneHandoff(f.job, { ...receipt,
    validation: { ...receipt.validation, milestoneState: "partial-choice-pending" } }),
  /original committed completion/, "A forged deferred Choice cannot alter an Event's sealed obligations.");
  await assert.rejects(reviewedMilestoneHandoff(f.job, { ...receipt,
    blueprintRequired: false, blueprintPin: undefined }),
  /Required Milestone Blueprint/, "Removing the pin and flag cannot downgrade a committed Event to legacy.");
  await assert.rejects(reviewedMilestoneHandoff(f.job, { ...receipt,
    blueprintPin: { ...receipt.blueprintPin, digest: "f".repeat(64) } }),
  /not linked/, "Changing the private approval digest cannot survive the Event commit trailer.");
  await assert.rejects(reviewedMilestoneHandoff(f.job, { ...receipt,
    assignment: { ...receipt.assignment, sourcePaths: ["milestones/other.md"] } }),
  /source record digest|bounded canonical|does not exist/, "An altered original source inventory cannot launder a plan.");
});

test("#208 final native closeout refuses the real unbound-decision partial Milestone", { skip: !available }, async () => {
  const f = setup("reviewed-partial-milestone");
  f.prepare();
  const result = f.event("decision-pending");
  assert.equal(result.status, 0, result.stderr);
  const event = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
  const handoff = await reviewedMilestoneHandoff(f.job, event);
  assert.equal(handoff?.milestoneState, "partial-choice-pending");
  const validated = await validateStoryJob(f.job);
  assert.equal(validated.status, "passed", "A stage-valid Event may keep its Milestone partial.");
  const report = validated.report as { records: Array<{ metadata: Record<string, any> }>;
    coverage: { milestoneRoutes: Array<{ id: string; routes: Array<{ status: string }> }> } };
  assert.throws(() => assertMilestoneCanonicalClosure(handoff,
    "milestone.disclosure", report.records, report.coverage.milestoneRoutes),
  /unresolved canonical fulfillment/,
  "The final goal cannot treat a deferred Choice as completed based only on an approved plan.");
});

test("revising an existing Event does not require rewriting an already fulfilled Milestone", { skip: !available }, async () => {
  const { job, prepare, event } = setup("existing-fulfilled-milestone");
  prepare();
  const first = event();
  assert.equal(first.status, 0, first.stderr);
  const milestone = join(job.worktreeStoryRoot, "milestones/disclosure.md");
  const original = readFileSync(milestone, "utf8");
  assert.match(original, /fulfillment: \{any_of: \[\[event\.disclose-ledger\]\]\}/);
  const target = join(job.worktreeStoryRoot, "events/disclose-ledger.md");
  writeFileSync(target, readFileSync(target, "utf8") + "\nA revised, grounded exchange follows the disclosure.\n");
  const assignment = {
    milestonePath: "milestones/disclosure.md",
    sourcePaths: ["events/disclose-ledger.md"],
  } as any;
  assert.deepEqual(await changedPaths(job, assignment, ["events/disclose-ledger.md"]),
    ["events/disclose-ledger.md"]);
  await assert.rejects(changedPaths(job, assignment, ["events/unrelated.md"]),
    /modifiedRecords differ.*authorized Git diff/);
  assert.equal(readFileSync(milestone, "utf8"), original,
    "The Milestone must not be touched just to pass a path audit.");
});

test("an overreported but unchanged selected Milestone cannot exhaust the Event writer", { skip: !available }, () => {
  const f = setup("phantom-milestone");
  const head = f.prepare();
  const milestone = join(f.job.worktreeStoryRoot, "milestones/disclosure.md");
  const original = readFileSync(milestone, "utf8");
  const run = f.event("phantom-milestone");
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "event-cluster-committed");
  assert.deepEqual(result.paths, ["events/disclose-ledger.md"]);
  assert.equal(readFileSync(milestone, "utf8"), original);
  assert.notEqual(result.headSha, head);
  const receiptFile = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.deepEqual(receipt.claimedPaths, [
    "events/disclose-ledger.md", "milestones/disclosure.md",
  ], "Retain the original model inventory for source-bound recovery");
  assert.deepEqual(receipt.paths, ["events/disclose-ledger.md"],
    "Only the actual Git diff may become a committed file");
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(f.event("phantom-milestone").status, 0);
  assert.equal(readFileSync(receiptFile, "utf8"), JSON.stringify(receipt, null, 2) + "\n");
});

test("clean no-write prerequisite report stays source-bound without a replay or fabricated Event commit", { skip: !available }, () => {
  const f = setup("no-write-prerequisite");
  const head = f.prepare();
  const first = f.event("no-write-prerequisite");
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, "event-prerequisite-reported");
  assert.equal(result.headSha, head);
  assert.deepEqual(result.paths, undefined);
  assert.match(result.conflicts.join(";"), /Choice/);
  assert.match(result.prerequisite.reportDigest, /^[a-f0-9]{64}$/);
  const receiptFile = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = readFileSync(receiptFile, "utf8");
  const repeat = f.event("no-write-prerequisite");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).prerequisite.reportDigest, result.prerequisite.reportDigest);
  assert.equal(readFileSync(receiptFile, "utf8"), receipt, "No fresh specialist turn or grant on repeated run");
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  const changed = JSON.parse(receipt);
  changed.conflicts = ["Report tampered after original turn"];
  writeFileSync(receiptFile, JSON.stringify(changed));
  const tampered = f.event("no-write-prerequisite");
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /report changed/);
});

test("dirty and empty no-write claims cannot become plan receipts", { skip: !available }, () => {
  for (const variant of ["no-write-dirty", "no-write-empty"]) {
    const f = setup(variant);
    const head = f.prepare();
    const attempted = f.event(variant);
    assert.notEqual(attempted.status, 0, variant);
    assert.match(attempted.stderr, /prerequisite report is not at a clean|must change at least one Event/);
    const receipt = JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8"));
    assert.equal(receipt.phase, "writing", "A doubtful report cannot be promoted to a finished writer");
    assert.equal(receipt.prerequisite, undefined);
    assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), head);
    if (variant === "no-write-dirty")
      assert.match(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all"),
        /events\/uncertain-draft.md/);
  }
});

test("public CLI commits a reachable causal Event cluster with validated Milestone fulfillment", { skip: !available }, () => {
  const { repo, job, baseline, cli, prepare, event } = setup("fulfilled");
  const before = prepare();
  const run = event();
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.deepEqual(data.validation.eventIds, ["event.disclose-ledger"]);
  assert.deepEqual(data.validation.routes.map((route: any) => route.status), ["reachable"]);
  assert.equal(data.validation.eventProgress[0].status, "reachable");
  assert.equal(data.validation.protectionBase, before);
  assert.equal(data.consequenceProof.milestone.id, "milestone.disclosure");
  assert.ok(data.consequenceProof.milestone.claim.includes("investigator"));
  assert.ok(data.consequenceProof.events.some((item: any) => item.id === "event.disclose-ledger"));
  assert.ok(data.consequenceProof.events.flatMap((item: any) => item.outcomes)
    .flatMap((branch: any) => branch.effects).some((effect: any) =>
      effect.step === "admit" && effect.branch === "disclose" &&
      effect.slot.includes("knowledge:") && effect.line > 0));
  assert.deepEqual(data.consequenceProof.diagnostics, []);
  assert.match(data.consequenceProof.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(data.validation.validatorVersion, /^\d+\.\d+\.\d+/);
  assert.ok(data.outstanding.every((o: any) => o.id !== "milestone.disclosure" || o.field !== "fulfillment.any_of"));
  assert.equal(data.completionEvidence.unrelatedComposition, "not-required");
  const eventMarkdown = readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(eventMarkdown, /value: knows/);
  assert.match(eventMarkdown, /kind: relationship/);
  assert.match(eventMarkdown, /prerequisites:\n  any_of:/);
  const milestoneMarkdown = readFileSync(join(job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");
  assert.match(milestoneMarkdown, /fulfillment: \{any_of: \[\[event.disclose-ledger\]\]\}/);
  const validated = cli(["validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.report.coverage.milestoneRoutes.find((x: any) => x.id === "milestone.disclosure").routes[0].status, "reachable");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline);
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), before);
  assert.match(git(job.worktreeRoot, "log", "-1", "--format=%B"), /NovelTea-Work-Item: event-disclosure/);
  const inspected = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).headSha, data.headSha);
  const replay = event();
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).headSha, data.headSha);
});

test("an Event's source-bound consequence proof cannot be altered after its verified commit", {
  skip: !available,
}, () => {
  const f = setup("sealed-event-consequence");
  f.prepare();
  const run = f.event();
  assert.equal(run.status, 0, run.stderr);
  const event = JSON.parse(run.stdout);
  const footer = git(f.job.worktreeRoot, "log", "-1", "--format=%B");
  assert.match(footer, /NovelTea-Event-Consequence: [a-f0-9]{64}/);
  const file = join(f.job.stateDir, "event-items/disclosure.json");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(receipt.consequenceProof.events[0].id, "event.disclose-ledger");
  receipt.consequenceProof.events[0].observation = "Fabricated source evidence";
  writeFileSync(file, JSON.stringify(receipt));
  const repeat = f.event();
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /typed consequence proof differs from its sealed source/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), event.headSha);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
});

test("an unbound decision Event commits as a reviewed-ready partial Milestone without a synthetic Choice ID", { skip: !available }, () => {
  const f = setup("staged-decision");
  const prior = f.prepare();
  const run = f.event("decision-pending");
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.equal(data.validation.milestoneState, "partial-choice-pending");
  assert.equal(data.completionEvidence.milestoneState, "partial-choice-pending");
  assert.equal(data.validation.routes.length, 0);
  assert.deepEqual(data.validation.eventIds, ["event.disclose-ledger"]);
  assert.match(data.obligations[0], /Choice Point binding/);
  const milestone = readFileSync(join(f.job.worktreeStoryRoot, "milestones/disclosure.md"), "utf8");
  assert.match(milestone, /completeness: partial/);
  assert.match(milestone, /fulfillment: \{any_of: \[\]\}/);
  const eventSource = readFileSync(join(f.job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(eventSource, /effects: \[\]/);
  assert.doesNotMatch(eventSource.split("steps:")[1]!, /kind: outcome|kind: relationship|kind: knowledge/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD^"), prior);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain"), "");
  const repeat = f.event("decision-pending");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).headSha, data.headSha);
});

test("unbound decision claims cannot falsely complete a Milestone or bind made-up fulfillment", { skip: !available }, () => {
  const f = setup("false-decision-complete");
  const prior = f.prepare();
  const bad = f.event("false-decision-complete");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unbound Choice obligation cannot certify a completed Milestone/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  assert.equal(JSON.parse(readFileSync(join(f.job.stateDir, "event-items/disclosure.json"), "utf8")).phase, "authored");
});

test("unrelated typed effects cannot launder an unbound decision into a fulfilled Milestone", { skip: !available }, () => {
  const f = setup("unrelated-fake-effects");
  const prior = f.prepare();
  const bad = f.event("fake-unrelated-effects");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unbound Choice obligation cannot certify a completed Milestone/);
  assert.equal(git(f.job.worktreeRoot, "rev-parse", "HEAD"), prior);
  assert.equal(git(f.job.worktreeRoot, "status", "--porcelain", "--untracked-files=all")
    .includes("events/disclose-ledger.md"), true,
    "An unaccepted fake claim is preserved for source-bound correction, not committed");
});

test("descriptive Events may complete without artificial state transitions", { skip: !available }, () => {
  const f = setup("descriptive-event");
  f.prepare();
  const run = f.event("descriptive");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).validation.milestoneState, "complete");
  const source = readFileSync(join(f.job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(source, /steps: \[\]/);
  assert.doesNotMatch(source.split("steps:")[1]!, /kind: knowledge|kind: relationship|kind: outcome/);
});

test("Event obeys shared job lock and execution pause before writing", { skip: !available }, () => {
  const x = setup("shared-lock-and-pause");
  x.prepare();
  const lock = join(x.job.worktreeRoot, "../.story-job-running");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    version: 1, jobId: "draft", pid: process.pid, host: requireHostname(),
    nonce: "12345678-1234-1234-1234-123456789abc", workItem: "another-writer",
  }));
  const blocked = x.event();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already owned/);
  rmSync(lock, { recursive: true });
  const paused = x.cli(["author", "control", "--state", "paused"]);
  assert.equal(paused.status, 0, paused.stderr);
  const denied = x.event();
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /cannot advance|paused/);
  assert.equal(existsSync(join(x.job.worktreeRoot, "events/disclose-ledger.md")), false);
});

test("optional after chronology does not imply a completed prerequisite", { skip: !available }, () => {
  const { job, cli, prepare, event } = setup("optional");
  prepare();
  const run = event("optional");
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.deepEqual(data.validation.eventIds, ["event.disclose-ledger", "event.inspect-ledger"]);
  assert.ok(data.validation.eventProgress.every((p: any) => p.status === "reachable"));
  const doc = readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8");
  assert.match(doc, /after: \[event.inspect-ledger\]/);
  assert.match(doc, /completed: \[\]/);
  const progress = JSON.parse(cli(["validate"]).stdout).report.coverage;
  assert.equal(progress.milestoneRoutes.find((x: any) => x.id === "milestone.disclosure").routes[0].status, "reachable");
});

test("related Revelation may be authored and revealed by a typed Event effect", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("revelation");
  prepare();
  const result = event("revelation");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(cli(["validate"]).stdout).report;
  assert.ok(report.records.some((r: any) => r.metadata.id === "revelation.ledger-shared"));
  assert.ok(readFileSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md"), "utf8")
    .includes("revelation: revelation.ledger-shared"));
});

test("unrelated cross-domain records and Milestone prose retcons are rejected", { skip: !available }, () => {
  const unrelated = setup("unconnected");
  const baseline = unrelated.prepare();
  const failed = unrelated.event("unconnected");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unconnected cross-domain record/);
  assert.equal(git(unrelated.job.worktreeRoot, "rev-parse", "HEAD"), baseline);
  const retcon = setup("milestone-retcon");
  const before = retcon.prepare();
  const rejected = retcon.event("milestone-retcon");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unrelated Milestone metadata\/body/);
  assert.equal(git(retcon.job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("requires previous foundations and an authorized selected Milestone", { skip: !available }, () => {
  const { cli, prepare, event } = setup("authorization");
  const noFoundation = event();
  assert.notEqual(noFoundation.status, 0);
  assert.match(noFoundation.stderr, /requires committed architecture|foundations/i);
  prepare();
  const outOfScope = event(undefined, "milestone.unapproved");
  assert.notEqual(outOfScope.status, 0);
  assert.match(outOfScope.stderr, /not authorized/);
  const malformed = event(undefined, "truth");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /typed milestone/);
  const noMilestone = cli(["event", "run", "--fixture"]);
  assert.notEqual(noMilestone.status, 0);
  assert.match(noMilestone.stderr, /--milestone/);
});

test("impossible contradictory prerequisites are rejected and do not produce an Event commit", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("contradictory");
  const before = prepare();
  const invalid = event("contradiction");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Canonical Event validation|impossible|contradictory/i);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
  assert.notEqual(git(job.worktreeRoot, "status", "--porcelain"), "");
  const inspection = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspection.status, 0);
  assert.equal(JSON.parse(inspection.stdout).phase, "authored");
  const retry = event("contradiction");
  assert.notEqual(retry.status, 0);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
});

test("localized canonical feedback repairs a contradictory Event before commit", { skip: !available }, () => {
  const { job, prepare, event } = setup("repaired");
  const original = prepare();
  const result = event("repair");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.status, "event-cluster-committed");
  assert.equal(data.validation.protectionBase, original);
  assert.ok(data.validation.routes.some((r: any) => r.status === "reachable"));
  assert.equal(git(job.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD^"), original);
});

test("exhausted localized repair preserves contradictory draft without marking completion", { skip: !available }, () => {
  const { job, prepare, event, cli } = setup("failed-repair");
  const before = prepare();
  const result = event("failed-repair");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exhausted bounded repair attempts/);
  assert.equal(git(job.worktreeRoot, "rev-parse", "HEAD"), before);
  const inspected = cli(["event", "inspect", "--milestone", "milestone.disclosure"]);
  assert.equal(inspected.status, 0);
  const data = JSON.parse(inspected.stdout);
  assert.equal(data.status, "writing");
  assert.match(data.failure, /exhausted bounded repair/);
  assert.equal(data.validation, undefined);
  assert.equal(data.completionEvidence.eventReachability, false);
  assert.ok(existsSync(join(job.worktreeStoryRoot, "events/disclose-ledger.md")));
});

test("rejects unauthorized Creative Direction edits and mismatched manifests without committing", { skip: !available }, () => {
  const x = setup("out-of-scope");
  const before = x.prepare();
  const rejected = x.event("unauthorized");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unauthorized Event specialist path/);
  assert.equal(git(x.job.worktreeRoot, "rev-parse", "HEAD"), before);
  const y = setup("manifest");
  const old = y.prepare();
  const mismatch = y.event("mismatch");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /modifiedRecords differ/);
  assert.equal(git(y.job.worktreeRoot, "rev-parse", "HEAD"), old);
});
