import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync,
  readFileSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTestTree } from "./helpers.js";
import { loadSealedReviewContext } from "../src/sealed-review-context.js";
import type { JobStartResult } from "../src/job.js";
import { createHash } from "node:crypto";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { readIndependentReview } from "../src/checkpoint-assurance.js";
import { deriveReviewRepairAmendment } from "../src/review-repair-amendment.js";
import { prepareSemanticReview, reviewBoundedAssignments,
  normalizeOmittedSemanticEvidenceSha, validateSemanticVerdict, semanticUnitOutcome,
  type SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import { assertSemanticCorrectionPreserved } from "../src/narrative-review-specialist.js";

const makePacket = (group = false): SemanticReviewPacket => {
  const item = (id: string, path: string, sha: string) => ({
    reviewedWorkItem: id, unitOutcome: semanticUnitOutcome(id),
    assignment: { id, specialist: "nt-character-development", outcome: "Give Nia a reason to wait",
      targets: ["character.nia"], dependsOn: [], discovery: "canonical-story-read-only" as const,
      authority: { recordTypes: ["character"], existingPaths: [path], mayCreate: false } },
    assurance: { version: 1 as const, policyVersion: 1 as const, jobId: "j",
      baseSha: "a".repeat(40), parentSha: "a".repeat(40), commitSha: sha,
      workItem: id, validationProofDigest: "c".repeat(64), validatorVersion: "1",
      turnDigest: "d".repeat(64), assignmentId: id, assignmentDigest: "e".repeat(64),
      assignmentDependencies: [], changedPaths: [path], changedRecordTypes: ["character"],
      addedLines: 1, removedLines: 0, diffDigest: "f".repeat(64),
      reviewSelection: { status: "required-pending" as const, reasons: ["large-diff"] } },
    diff: "diff --git a/" + path + " b/" + path,
    canonicalContext: [{ path, content: "# Nia\nNia waits.", commitSha: sha, blobSha: "a".repeat(40) }],
    readOnlyPaths: [], repairTargets: [path],
  });
  return { policy: "assignment-fidelity/v1", sourceDigest: "source",
    items: [item("focus:character.nia", "characters/nia.md", "b".repeat(40)),
      ...(group ? [item("focus:character.eli", "characters/eli.md", "c".repeat(40))] : [])] };
};
const evidence = (id: string, path: string, commitSha = "b".repeat(40)) =>
  ({ commitSha, assignmentId: id, path, line: 2, explanation: "Source text supports the assigned change." });
const finding = (id: string, path: string, kind: "missing-requirement" |
  "unrequested-change" = "missing-requirement", commitSha = "b".repeat(40)) =>
  ({ commitSha, assignmentId: id, path, line: 2, kind,
    message: "Required motive is missing.",
    requiredCorrection: "Write Nia's established promise as the motive for waiting.",
    affectedPaths: [path] });

test("review context loads native-linked records only from the sealed Git source", async t => {
  const root = mkdtempSync(join(tmpdir(), "nt-sealed-review-"));
  t.after(() => removeTestTree(root));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  mkdirSync(join(root, "story/events"), { recursive: true });
  mkdirSync(join(root, "story/characters"));
  writeFileSync(join(root, "story/events/clue.md"), "Sealed Event.\n");
  writeFileSync(join(root, "story/characters/witness.md"), "Sealed witness.\n");
  mkdirSync(join(root, "story/.story-inbox/ideas"), { recursive: true });
  writeFileSync(join(root, "story/.story-inbox/ideas/secret.md"), "Private idea.\n".repeat(12_000));
  git("init", "-q"); git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test"); git("add", "."); git("commit", "-qm", "source");
  const sha = git("rev-parse", "HEAD");
  // Fixture native boundary; the private saved-response replay separately uses the real CLI.
  const cli = join(root, "native.cjs");
  writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const paths = ['events/clue.md', 'characters/witness.md'];
console.log(JSON.stringify(args.includes('validate') ? {
  success: true, catalog: { records: paths.map((path, i) => ({path, metadata: {id: i ? 'character.witness' : 'event.clue'}})) }
} : {success: true, manifest: {contractRevision: 'test', files: paths.map(path => ({path, id: path,
 sourceRevision: 'sealed', status: 'draft', priority: 'primary', inclusions: [{code: 'linked', sourceId: 'event.clue', targetId: 'character.witness'}]})),
 unresolved: [], bounded: {truncated: false}, coverageStatus: 'complete'}}));
`, { mode: 0o700 });
  const prior = process.env.NT_NATIVE_CLI;
  process.env.NT_NATIVE_CLI = cli;
  t.after(() => { if (prior === undefined) delete process.env.NT_NATIVE_CLI; else process.env.NT_NATIVE_CLI = prior; });
  const job = { worktreeRoot: root, storyRelativePath: "story", validatorVersion: "1.0.0" } as JobStartResult;
  writeFileSync(join(root, "story/characters/witness.md"), "Uncommitted unrelated replacement.\n");
  const context = await loadSealedReviewContext(job, sha, ["events/clue.md"]);
  assert.deepEqual(context.map(c => [c.path, c.content]), [
    ["characters/witness.md", "Sealed witness.\n"], ["events/clue.md", "Sealed Event.\n"],
  ]);
  assert.ok(context.every(c => c.commitSha === sha && /^[a-f0-9]{40}$/.test(c.blobSha)));
  assert.deepEqual(await loadSealedReviewContext(job, sha, ["events/clue.md"]), context);
  for (const path of ["../outside.md", "events/../../outside.md", ".story-inbox/ideas/secret.md",
    "events/.hidden.md", "unknown/clue.md", "events/missing.md"]) {
    await assert.rejects(loadSealedReviewContext(job, sha, [path]), /Unsafe|missing/);
  }
  await assert.rejects(loadSealedReviewContext(job, "HEAD", ["events/clue.md"]), /Unsafe/);
  await assert.rejects(loadSealedReviewContext(job, "f".repeat(40), ["events/clue.md"]));
  // Git stores symlinks as blobs too; a blob object alone is not safe provenance.
  symlinkSync("../characters/witness.md", join(root, "story/events/link.md"));
  git("add", "story"); git("commit", "-qm", "unsafe link");
  await assert.rejects(loadSealedReviewContext(job, git("rev-parse", "HEAD"), ["events/clue.md"]), /Unsafe/);
  unlinkSync(join(root, "story/events/link.md"));
  writeFileSync(join(root, "story/events/huge.md"), "x".repeat(128 * 1024 + 1));
  git("add", "story"); git("commit", "-qm", "oversized record");
  await assert.rejects(loadSealedReviewContext(job, git("rev-parse", "HEAD"), ["events/clue.md"]), /bounded/);
  unlinkSync(join(root, "story/events/huge.md"));
  writeFileSync(join(root, "story/events/clue.md"), "e".repeat(70 * 1024));
  writeFileSync(join(root, "story/characters/witness.md"), "c".repeat(70 * 1024));
  git("add", "story"); git("commit", "-qm", "oversized combined context");
  await assert.rejects(loadSealedReviewContext(job, git("rev-parse", "HEAD"), ["events/clue.md"]), /bounded/);
  writeFileSync(join(root, "story/events/clue.md"), "Event.\n");
  writeFileSync(join(root, "story/characters/witness.md"), "Witness.\n");
  const manyPaths = Array.from({ length: 33 }, (_, i) => `events/event-${i}.md`);
  for (const path of manyPaths) writeFileSync(join(root, "story", path), "Event.\n");
  git("add", "story"); git("commit", "-qm", "many related records");
  const nativeSource = readFileSync(cli, "utf8");
  writeFileSync(cli, nativeSource.replace("['events/clue.md', 'characters/witness.md']",
    JSON.stringify(manyPaths)));
  await assert.rejects(loadSealedReviewContext(job, git("rev-parse", "HEAD"), [manyPaths[0]!]), /bounded/);
  writeFileSync(cli, nativeSource.replace("truncated: false", "truncated: true"));
  await assert.rejects(loadSealedReviewContext(job, sha, ["events/clue.md"]), /truncated/);
  for (const invented of ["events/missing.md", "../outside.md", ".story-inbox/ideas/secret.md"]) {
    writeFileSync(cli, nativeSource.replace("['events/clue.md', 'characters/witness.md']",
      JSON.stringify(["events/clue.md", invented])));
    await assert.rejects(loadSealedReviewContext(job, sha, ["events/clue.md"]));
  }
  writeFileSync(cli, nativeSource);
  assert.deepEqual(await loadSealedReviewContext(job, sha, ["events/clue.md"]), context,
    "later commits and dirty files never change an earlier packet");
});

test("saved Collaborative responses seal failed receipts with bounded repair authority", {
  skip: !process.env.NT_TEST_SEMANTIC_REPLAY_STATE && "set NT_TEST_SEMANTIC_REPLAY_STATE to the private #161 job state directory",
}, async t => {
  const directory = process.env.NT_TEST_SEMANTIC_REPLAY_STATE!;
  const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as JobStartResult;
  const sourceSha = "191e9c2a0ad1b60745f57582d625600b912e5626";
  const sessionDir = join(directory, "review-sessions/review");
  const messages = readdirSync(sessionDir).flatMap(file => readFileSync(join(sessionDir, file), "utf8")
    .trim().split("\n").map(line => JSON.parse(line).message).filter(Boolean));
  const texts = (message: { content: Array<{ type: string; text?: string }> }) =>
    Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text!) : [];
  const prompt = messages.flatMap(texts).find(text => text.includes("\nREVIEW PACKET:\n") &&
    text.includes(sourceSha))!;
  const legacy = JSON.parse(prompt.split("\nREVIEW PACKET:\n")[1]!);
  assert.equal(createHash("sha256").update(JSON.stringify({ policy: legacy.policy,
    items: legacy.items })).digest("hex"), legacy.sourceDigest);
  const responses = messages.filter(m => m.role === "assistant").flatMap(texts)
    .filter(text => text.startsWith('{"sourceDigest"') && text.includes(sourceSha)).map(text => JSON.parse(text));
  assert.equal(responses.length, 2);
  for (const response of responses) {
    assert.equal(response.sourceDigest, legacy.sourceDigest);
    assert.throws(() => validateSemanticVerdict(legacy, response), /source-linked/);
    const root = mkdtempSync(join(tmpdir(), "nt-review-replay-"));
    t.after(() => removeTestTree(root));
    const stateDir = join(root, "state");
    cpSync(directory, stateDir, { recursive: true });
    const replayJob = { ...job, stateDir };
    const point = (await inspectRecoveryCheckpoints(replayJob)).find(p => p.commitSha === sourceSha)!;
    assert.ok(point.eligible);
    const packet = await prepareSemanticReview(replayJob, [point]);
    assert.throws(() => validateSemanticVerdict(packet, response), /stale/);
    // A new input packet necessarily has a new digest. Re-envelope only for
    // this recorded-model replay; production never migrates a stale response.
    const replay = { ...response, sourceDigest: packet.sourceDigest };
    for (let restart = 0; restart < 2; restart++) {
      const result = await reviewBoundedAssignments({ ...replayJob }, [point],
        async () => replay, "recorded-independent-pi-replay", true);
      assert.equal(result.verdict.verdict, "fail");
      assert.deepEqual(result.verdict.findings, response.findings);
    }
    const receipt = await readIndependentReview({ ...replayJob }, point.assurance!);
    assert.equal(receipt.status, "failed");
    assert.deepEqual(JSON.parse(receipt.result!.evidence).evidence, response.evidence);
    const amendment = deriveReviewRepairAmendment({ assurance: point.assurance!,
      review: receipt.result!, original: packet.items[0]!.assignment,
      planVersion: point.planVersion ?? 1, originWorkItem: point.workItem });
    assert.deepEqual(amendment.assignment.authority.existingPaths, ["events/disappearance-explained.md"]);
    assert.equal(amendment.assignment.specialist, "nt-event-design");
    assert.equal(amendment.assignment.authority.mayCreate, false);
    assert.deepEqual(amendment.obligations[0]!.affectedPaths, response.findings[0].affectedPaths);
    assert.equal(amendment.obligations[0]!.requiredCorrection, response.findings[0].requiredCorrection);
    assert.ok(amendment.readOnlyDependencies.includes("world-entities/stranded-overnight-train.md"));
    assert.ok(amendment.readOnlyDependencies.includes("milestones/disappearance-explained.md"));
    assert.deepEqual(packet.items[0]!.repairTargets, amendment.assignment.authority.existingPaths);
    for (const change of [{ jobId: "other-job" }, { assignmentId: "other-assignment" },
      { turnDigest: "0".repeat(64) }]) {
      await assert.rejects(readIndependentReview(replayJob, { ...point.assurance!, ...change }), /stale/);
    }
    t.diagnostic(`source=${sourceSha} packet=${packet.sourceDigest} status=${receipt.status}`);
  }
});

test("multi-unit review requires only the exact current specialist unit, not its successor", () => {
  const world = semanticUnitOutcome("world-foundations");
  const characters = semanticUnitOutcome("character-foundations");
  const choice = semanticUnitOutcome("interactive-choice-disclosure");
  const puzzle = semanticUnitOutcome("interactive-puzzle-disclosure");
  const event = semanticUnitOutcome("event-milestone.disappearance-established");
  assert.match(world, /NEXT separately committed character-foundations/);
  assert.match(world, /Do not fail World Foundations solely for not writing Characters/);
  assert.match(characters, /missing central Characters are a failure/);
  assert.match(characters, /extend ONLY the existing, planned Arc's characters array/);
  assert.match(characters, /Reject any Arc body, decision, plot, or other-field edit/);
  assert.match(choice, /separate later interactive-puzzle/);
  assert.match(puzzle, /Assess real solvability/);
  assert.match(event, /selected authored Milestone/);
  assert.match(event, /No pre-existing canonical Fact is required/);
  assert.match(event, /expected presence or unconfirmed report alone does not establish actual last-known presence/);
  assert.match(event, /fixed number of witnesses/);
  assert.match(event, /BEFORE relying on it/);
  assert.doesNotMatch(event, /train|berth|passenger list|assigned seat/);
  const correctedEvent = semanticUnitOutcome("repair-" + "a".repeat(40), "nt-event-design");
  assert.match(correctedEvent, /BEFORE relying on it/);
  assert.match(correctedEvent, /no new paths/i);
  assert.doesNotMatch(correctedEvent, /may author Events and necessary connected new Facts/);
  const packet = makePacket();
  assert.equal(packet.items[0]!.reviewedWorkItem, "focus:character.nia");
  assert.match(packet.items[0]!.unitOutcome, /exact committed work item/);
});

test("source correction preserves the original negative finding despite model paraphrasing", () => {
  const original = { verdict: "fail", findings: [{
    kind: "continuity", message: "The Event makes the wary Characters trusting too early.",
    requiredCorrection: "Remove the unsupported trusting relationship effect.",
    commitSha: "wrong", assignmentId: "event", path: "story/events/clue.md",
    affectedPaths: ["events/clue.md", "relationships/wary.md"], line: 20,
  }] };
  const corrected = { verdict: "fail", findings: [{ ...original.findings[0],
    commitSha: "a".repeat(40), path: "events/clue.md", line: 21,
    message: "The people gain trust too quickly.", requiredCorrection: "Revise their bond." }],
    evidence: [{ commitSha: "a".repeat(40), assignmentId: "event", path: "events/clue.md",
      line: 21, explanation: "The Event applies the trusting state." }] };
  const preserved = assertSemanticCorrectionPreserved(original, corrected) as typeof corrected;
  assert.equal(preserved.verdict, "fail");
  assert.equal(preserved.findings[0]!.path, "events/clue.md");
  assert.equal(preserved.findings[0]!.commitSha, "a".repeat(40));
  assert.equal(preserved.findings[0]!.message, original.findings[0]!.message);
  assert.equal(preserved.findings[0]!.requiredCorrection, original.findings[0]!.requiredCorrection);
  assert.deepEqual(preserved.findings[0]!.affectedPaths, original.findings[0]!.affectedPaths);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { verdict: "pass", findings: [] }),
    /cannot erase/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { verdict: "fail", findings: [] }),
    /cannot erase/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { ...corrected,
    findings: [{ ...corrected.findings[0]!, kind: "other" }] }), /cannot change/);
  assert.throws(() => assertSemanticCorrectionPreserved(original, { ...corrected,
    findings: [{ ...corrected.findings[0]!, path: "events/another.md" }] }), /cannot change/);
});

test("saved #158 reviewer SHA-omission can be corrected without generating evidence", () => {
  const packet = makePacket();
  // The live Character review's fourth citation omitted two hex characters.
  const trusted = "a52b9edf58b61e677bd51c829e310121f3f3b661";
  const omitted = "a52b9edf58b61e677bd51c829e310121f3b661";
  packet.items[0]!.assurance.commitSha = trusted;
  const input = { sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md", omitted)] };
  assert.throws(() => validateSemanticVerdict(packet, input), /source-linked/);
  const repaired = normalizeOmittedSemanticEvidenceSha(packet, input) as typeof input;
  assert.equal(repaired.evidence[0]!.commitSha, trusted);
  assert.equal(repaired.evidence[0]!.explanation, input.evidence[0]!.explanation);
  assert.equal(validateSemanticVerdict(packet, repaired).verdict, "pass");
  for (const invalid of [
    { ...input, evidence: [] },
    { ...input, sourceDigest: "stale" },
    { ...input, evidence: [evidence("focus:character.nia", "characters/nia.md", "f".repeat(40))] },
    { ...input, evidence: [evidence("focus:character.nia", "characters/nia.md", "f".repeat(38))] },
    { ...input, evidence: [evidence("foreign-assignment", "characters/nia.md", omitted)] },
    { ...input, evidence: [evidence("focus:character.nia", "characters/foreign.md", omitted)] },
    { ...input, evidence: [{ ...input.evidence[0]!, line: 900 }] },
  ]) {
    assert.throws(() => validateSemanticVerdict(packet,
      normalizeOmittedSemanticEvidenceSha(packet, invalid)), /source-linked|stale/);
  }
  const longOmission = "85d8c8f273e6df67ac0c8eff54d609cab";
  const fullSha = "85d8c8f273e6df67ac0df71ac0c8eff54d609cab";
  packet.items[0]!.assurance.commitSha = fullSha;
  const copied = { ...input, evidence: [evidence("focus:character.nia", "characters/nia.md", longOmission)] };
  assert.equal(validateSemanticVerdict(packet,
    normalizeOmittedSemanticEvidenceSha(packet, copied)).verdict, "pass",
  "Seven omitted hex characters in the real live review are unambiguously bound to the verified commit");
  const tooShort = { ...input, evidence: [evidence("focus:character.nia", "characters/nia.md", longOmission.slice(0, 31))] };
  assert.throws(() => validateSemanticVerdict(packet,
    normalizeOmittedSemanticEvidenceSha(packet, tooShort)), /source-linked/);
  const negative = { ...input, verdict: "fail", findings: [
    finding("focus:character.nia", "characters/nia.md", "missing-requirement", trusted)] };
  assert.strictEqual(normalizeOmittedSemanticEvidenceSha(packet, negative), negative,
    "Negative reviews and their source links must never be rewritten");
});

test("faithful single assignment passes with exact source-linked evidence", () => {
  const packet = makePacket();
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).verdict, "pass");
});
test("irrelevant creative addition and missing assignment requirement are actionable failures", () => {
  const packet = makePacket();
  for (const kind of ["missing-requirement", "unrequested-change"] as const) {
    const result = validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
      verdict: "fail", findings: [finding("focus:character.nia", "characters/nia.md", kind)],
      evidence: [] });
    assert.equal(result.findings[0]!.kind, kind);
  }
});
test("group review attributes failure to its exact assignment and record", () => {
  const packet = makePacket(true);
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md", "missing-requirement", "c".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).findings[0]!.assignmentId,
    "focus:character.eli");
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md",
      "missing-requirement", "c".repeat(40))], evidence: [] }), /source-linked/,
    "a grouped failure cannot silently approve an unchecked sibling");
  assert.throws(() => validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.eli", "characters/eli.md",
      "missing-requirement", "b".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }), /source-linked/,
    "the wrong checkpoint cannot receive another checkpoint's finding");
});
test("repeated assignment IDs remain distinct across group checkpoint commits", () => {
  const packet = makePacket(true);
  packet.items[1]!.assignment.id = packet.items[0]!.assignment.id;
  packet.items[1]!.assurance.assignmentId = packet.items[0]!.assurance.assignmentId;
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [finding("focus:character.nia", "characters/eli.md",
      "unrequested-change", "c".repeat(40))],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] }).findings[0]!.commitSha,
    "c".repeat(40));
});
function makeEventPacket(text: string): SemanticReviewPacket {
  const packet = makePacket();
  const item = packet.items[0]!;
  item.assignment = { id: "event", specialist: "nt-event-design", outcome: "Establish a credible absence without settling its cause",
    targets: ["milestone.absence"], dependsOn: [], discovery: "canonical-story-read-only",
    authority: { recordTypes: ["event"], existingPaths: ["events/absence.md"], mayCreate: false } };
  item.assurance = { ...item.assurance, assignmentId: "event",
    assignmentDigest: createHash("sha256").update(JSON.stringify(item.assignment)).digest("hex"),
    changedPaths: ["events/absence.md"], changedRecordTypes: ["event"] };
  item.reviewedWorkItem = "event-absence";
  item.unitOutcome = semanticUnitOutcome(item.reviewedWorkItem);
  item.repairTargets = ["events/absence.md"];
  item.canonicalContext = [{ path: "events/absence.md", content: "# Absence\n" + text,
    commitSha: item.assurance.commitSha, blobSha: "a".repeat(40) }];
  return packet;
}

// Human-labelled minimal semantic cases, not a natural-language validator or
// claims of live model convergence. Exercise the existing reviewer/repair seam:
// each negative assessment must survive intact as a bounded correction.
for (const [name, text, defect, correction] of [
  ["expected presence", "The assigned room is empty, proving a disappearance.",
    "An assignment proves expectation, not presence.", "Present a sourced last-known-presence witness account before inferring absence."],
  ["unshown clue", "Compare the available traces to resolve the accounts.",
    "The player never encounters the traces.", "Show the concrete observations within this Event before comparison."],
  ["unreachable clue", "The optional search revealed the clue; every route now knows it.",
    "The shared route can bypass the evidence Event.", "Gate this inference on the evidence route or deliver the evidence here first."],
  ["unconfirmed testimony", "A witness guesses the visitor left; therefore departure is objective truth.",
    "An uncertain claim becomes canonical truth without support.", "Attribute the claim and preserve uncertainty instead of asserting a truth effect."],
  ["missing prerequisite", "The player uses the key without any route to acquire it.",
    "A required enabling condition is absent.", "Deliver the authorized enabling action here before relying on it or report the missing prerequisite."],
  ["invented timestamp", "The earlier inspection recorded presence at exactly midnight.",
    "No source establishes the past inspection or timestamp.", "Remove the invented record and deliver a named witness report with explicit limits in this Event."],
  ["premature state", "Trust and knowledge change before the witness speaks.",
    "Typed knowledge and relationship consequences precede their causal trigger.", "Move those effects after the player-visible disclosure on the appropriate branch."],
  ["contradiction", "Nobody saw the visitor. The visitor's witnessed exit proves departure.",
    "The inference contradicts the Event's own stated observations.", "Reconcile the observation and inference without inventing protected history."],
]) {
  test(`Event causal finding remains actionable and source-bound: ${name}`, () => {
    const packet = makeEventPacket(text);
    const item = packet.items[0]!;
    const result = validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest, verdict: "fail",
      findings: [{ commitSha: item.assurance.commitSha, assignmentId: "event", path: "events/absence.md",
        line: 2, kind: "continuity", message: defect, requiredCorrection: correction,
        affectedPaths: ["events/absence.md"] }], evidence: [] });
    const { jobId, commitSha, turnDigest, assignmentId, assignmentDigest, diffDigest, validationProofDigest } = item.assurance;
    const amendment = deriveReviewRepairAmendment({ assurance: item.assurance, original: item.assignment,
      planVersion: 1, originWorkItem: "event-absence", review: { version: 1, status: "failed",
        reviewer: "recorded-semantic-assessment", source: { jobId, commitSha, turnDigest, assignmentId,
          assignmentDigest, diffDigest, validationProofDigest }, evidence: "Human-labelled minimal case",
        findings: result.findings } });
    assert.equal(amendment.obligations[0]!.defect, defect);
    assert.equal(amendment.obligations[0]!.requiredCorrection, correction);
    assert.deepEqual(amendment.assignment.authority.existingPaths, ["events/absence.md"]);
    assert.equal(amendment.assignment.authority.mayCreate, false);
    assert.equal(amendment.assignment.specialist, "nt-event-design");
  });
}

test("ambiguous player-visible witness evidence can pass without proving harm or culprit", () => {
  const packet = makeEventPacket("The caretaker tells the player: I spoke to the visitor here before supper; I did not see where they went.\nThe player checks the now-empty room, then treats absence as credible, not evidence of harm or a culprit.");
  const item = packet.items[0]!;
  const result = validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "pass", findings: [], evidence: [{ ...evidence(item.assignment.id, "events/absence.md"),
      explanation: "The sourced testimony and current observation precede the provisional inference; uncertainty remains." }] });
  assert.equal(result.verdict, "pass");
});

test("cross-domain causal defect names real linked context but cannot invent a writable record", () => {
  const packet = makePacket();
  packet.items[0]!.canonicalContext.push({ path: "facts/promise.md",
    content: "# Fact\nNia knows the witness made a promise.", commitSha: "b".repeat(40), blobSha: "a".repeat(40) });
  const actual = { ...finding("focus:character.nia", "characters/nia.md"),
    kind: "continuity" as const, affectedPaths: ["characters/nia.md", "facts/promise.md"],
    message: "Nia behaves as if she never learned the Fact referenced by her dialogue.",
    requiredCorrection: "Correct Nia's dialogue so it acknowledges the learned Fact without rewriting it." };
  assert.equal(validateSemanticVerdict(packet, { sourceDigest: packet.sourceDigest,
    verdict: "fail", findings: [actual], evidence: [] }).findings[0]!.affectedPaths[1],
    "facts/promise.md");
  for (const invalid of [
    { ...actual, affectedPaths: ["characters/nia.md", "facts/invented.md"] },
    { ...actual, affectedPaths: ["facts/promise.md"] },
    { ...actual, requiredCorrection: "retry" },
    { ...actual, requiredCorrection: "" },
    { ...actual, affectedPaths: ["characters/nia.md", "characters/nia.md"] },
  ]) {
    assert.throws(() => validateSemanticVerdict(packet, {
      sourceDigest: packet.sourceDigest, verdict: "fail", findings: [invalid], evidence: [],
    }), /source-linked/);
  }
});

test("stale source and unauthorized reviewer actions cannot become approvals", () => {
  const packet = makePacket();
  const valid = { sourceDigest: packet.sourceDigest, verdict: "pass", findings: [],
    evidence: [evidence("focus:character.nia", "characters/nia.md")] };
  assert.throws(() => validateSemanticVerdict(packet, { ...valid, sourceDigest: "changed" }),
    /stale/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid, findings: [
    finding("focus:character.nia", "events/unapproved.md")] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid,
    evidence: [evidence("focus:character.nia", "characters/nia.md"),
      { ...evidence("focus:character.nia", "characters/nia.md"), line: 900 }] }), /source-linked/);
  assert.throws(() => validateSemanticVerdict(packet, { ...valid,
    verdict: "approve-author-protected-canon" }), /malformed/);
});
