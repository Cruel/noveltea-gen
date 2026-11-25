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
  eventEvidenceRepairFeedback, eventSpecialistPrompt,
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

test("#212: typed causal no-write evidence cannot masquerade as writer authority", () => {
  const causalDiscovery = { sourcePath: "milestones/disclosure.md",
    sourceQuote: "The ledger conclusively proves that the witness was there.",
    violatedObligation: "The ledger establishes the witness arrival",
    proposedCorrection: "Make the chronology uncertain until the access records agree." };
  const manifest = { modifiedRecords: [], architecturalConflicts: ["Contradictory chronology"],
    laterObligations: ["Check source"], causalDiscovery };
  assert.deepEqual(parseEventManifest(JSON.stringify(manifest)).causalDiscovery, causalDiscovery);
  for (const invalid of [
    { ...manifest, modifiedRecords: ["milestones/disclosure.md"] },
    { ...manifest, architecturalConflicts: [] },
    { ...manifest, causalDiscovery: { ...causalDiscovery, sourceQuote: "" } },
    { ...manifest, causalDiscovery: { ...causalDiscovery, unapprovedPaths: ["arcs/truth.md"] } },
  ]) assert.throws(() => parseEventManifest(JSON.stringify(invalid)), /Causal discovery/);
  const receipt = { jobId: "single", workItemId: "event-disclosure", expectedHead: "a".repeat(40),
    planDigest: "b".repeat(64), sessionSha256: "c".repeat(64), sessionId: "session",
    assignmentDigest: "d".repeat(64), snapshotId: "e".repeat(64),
    sessionFile: "/state/settled-session.jsonl", worker: "pi" as const,
    conflicts: ["Contradictory chronology"], obligations: ["Check source"], causalDiscovery };
  const sealed = eventPrerequisiteReportDigest(receipt);
  assert.notEqual(sealed, eventPrerequisiteReportDigest({ ...receipt, causalDiscovery: {
    ...causalDiscovery, proposedCorrection: "Rewrite every world fact and protected choice." } }));
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
