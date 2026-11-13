import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeTestTree } from "./helpers.js";
import type { JobStartResult } from "../src/job.js";
import type { CanonicalScopeRecord } from "../src/focused-scope.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";
import type { GenerationInventory } from "../src/generation-plan.js";
import type { SteeringInput } from "../src/steering-boundary.js";
import { proposeSteeringAmendment, readSteeringPlan,
  saveSteeringAmendment, steeringForAssignment } from "../src/steering-amendments.js";

const head = "a".repeat(40);
const digest = "b".repeat(64);
const jobId = "job-1", authorThreadId = "thread-1";

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "steering-plans-"));
  const job = { jobId, threadId: "internal-story-job-1", stateDir } as JobStartResult;
  const records = [
    { path: "characters/mara.md", metadata: { id: "character.mara", type: "character",
      status: "approved", decisions: [] } },
    { path: "characters/ivan.md", metadata: { id: "character.ivan", type: "character",
      status: "approved", decisions: [] } },
    { path: "events/alibi.md", metadata: { id: "event.alibi", type: "event",
      status: "approved", decisions: [] } },
  ] as CanonicalScopeRecord[];
  const turn = { digest, goal: "Create a playable mystery with a trustworthy alibi",
    contract: { scope: { kind: "partial", depth: "composition", targets: ["character.mara", "character.ivan", "event.alibi"] } },
    objective: { breadth: "focused" },
    assignments: [
      { id: "focus:character.mara", authority: { existingPaths: ["characters/mara.md"] } },
      { id: "focus:character.ivan", authority: { existingPaths: ["characters/ivan.md"] } },
      { id: "focus:event.alibi", authority: { existingPaths: ["events/alibi.md"] } },
    ],
  } as unknown as TurnEvidence;
  const inventory = { headSha: head, items: [
    { id: "focus:character.mara", stage: "focus", status: "pending", targetIds: ["character.mara"] },
    { id: "focus:character.ivan", stage: "focus", status: "verified",
      targetIds: ["character.ivan"], verifiedSha: head },
    { id: "focus:event.alibi", stage: "focus", status: "pending", targetIds: ["event.alibi"] },
  ] } as GenerationInventory;
  const steering = { messageId: randomUUID(), jobId, threadId: authorThreadId,
    content: "Make character.mara the murderer", state: "delivered",
    submittedHead: head, targetWorkItem: "focus:character.mara",
    disposition: "within-scope" } as SteeringInput;
  const make = (message: SteeringInput = steering, current = inventory,
    catalog = records, prior: Awaited<ReturnType<typeof readSteeringPlan>> = null,
    changed: string[] = []) =>
    proposeSteeringAmendment({ steering: message, jobId, threadId: authorThreadId,
      headSha: head, inventory: current, turn, catalog,
      changedSinceSubmission: changed, prior });
  return { job, stateDir, records, turn, inventory, steering, make,
    cleanup: () => removeTestTree(stateDir) };
}

test("source-bound author steering retargets only pending specialist work and survives restart", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.make();
  assert.equal(result.decision.kind, "applied");
  assert.equal(result.amendment?.sourceSha, head);
  assert.deepEqual(result.amendment?.affectedAssignments, ["focus:character.mara"]);
  assert.deepEqual(result.amendment?.carried, [{ id: "focus:character.ivan", sha: head }]);
  assert.equal(result.amendment?.originalObjective, f.turn.goal);
  await saveSteeringAmendment(f.job, f.turn, result.amendment!);
  const restarted = await readSteeringPlan(f.job, digest);
  assert.equal(restarted?.authorThreadId, authorThreadId);
  assert.equal(restarted?.entries[0]?.digest, result.amendment?.digest);
  assert.equal(f.make(f.steering, f.inventory, f.records, restarted).amendment, null);
  const replay = f.make(f.steering, f.inventory, f.records, restarted).decision;
  assert.equal(replay.sourceSha, head);
  assert.equal(replay.amendmentDigest, result.amendment?.digest);
  await saveSteeringAmendment(f.job, f.turn, result.amendment!);
  assert.equal((await readSteeringPlan(f.job))?.entries.length, 1);
  const instruction = await steeringForAssignment(f.job, digest, "focus:character.mara", head);
  assert.match(instruction, /Make character\.mara the murderer/);
  assert.match(instruction, /not a new write grant/);
  assert.equal(await steeringForAssignment(f.job, digest, "focus:character.ivan", head), "");
});

test("a second distinct steer is a versioned append, not an overwrite of original context", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const first = f.make().amendment!;
  await saveSteeringAmendment(f.job, f.turn, first);
  const secondSteer: SteeringInput = { ...f.steering, messageId: randomUUID(),
    content: "Give event.alibi a false lead" };
  const second = f.make(secondSteer, f.inventory, f.records,
    await readSteeringPlan(f.job)).amendment!;
  assert.equal(second.version, 2);
  assert.equal(second.previousDigest, first.digest);
  assert.deepEqual(second.affectedAssignments, ["focus:event.alibi"]);
  await saveSteeringAmendment(f.job, f.turn, second);
  assert.equal((await readSteeringPlan(f.job))?.entries.length, 2);
  assert.match(await steeringForAssignment(f.job, digest, "focus:event.alibi", head),
    /false lead/);
});

test("an explicit canonical ID does not silently target a second record with a matching title", t => {
  const f = fixture();
  t.after(f.cleanup);
  const catalog = f.records.map(record => record.metadata.id === "event.alibi"
    ? { ...record, metadata: { ...record.metadata, title: "Mara" } }
    : record) as CanonicalScopeRecord[];
  const exact = f.make(f.steering, f.inventory, catalog);
  assert.equal(exact.decision.kind, "applied");
  assert.deepEqual(exact.amendment?.affectedAssignments, ["focus:character.mara"]);
  const multiple = f.make({ ...f.steering, content:
    "Make character.mara the murderer and give the Mara event a false lead" }, f.inventory, catalog);
  assert.equal(multiple.decision.kind, "applied");
  assert.deepEqual(multiple.amendment?.affectedAssignments,
    ["focus:character.mara", "focus:event.alibi"]);
  const forbidden = f.make({ ...f.steering, content:
    "Make character.mara the murderer and revise event.alibi" },
    { ...f.inventory, items: f.inventory.items.filter(item => item.id !== "focus:event.alibi") }, catalog);
  assert.equal(forbidden.decision.kind, "review-required",
    "A genuinely additional out-of-scope target remains blocked");
});

test("source drift, unrelated targets, protected canon and unbound instructions fail closed", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const rejection = (message: SteeringInput, changed?: string[],
    catalog = f.records) => f.make(message, f.inventory, catalog, null, changed).decision;
  assert.equal(rejection({ ...f.steering, jobId: "another-job" }).kind, "review-required");
  assert.equal(rejection({ ...f.steering, threadId: "another-thread" }).kind, "review-required");
  assert.equal(rejection({ ...f.steering, submittedHead: null }).kind, "review-required");
  assert.match(rejection(f.steering, ["characters/mara.md"]).reason, /changed since/);
  assert.equal(rejection({ ...f.steering, content: "Edit character.nobody" }).kind, "review-required");
  assert.equal(rejection({ ...f.steering, content: "Make the protagonist the murderer" }).kind,
    "review-required", "an ungrounded role cannot grant speculative scope");
  const grounded = f.records.map(record => record.metadata.id === "character.mara"
    ? { ...record, metadata: { ...record.metadata, title: "Mara", narrative_role: "protagonist" } }
    : record) as CanonicalScopeRecord[];
  assert.deepEqual(f.make({ ...f.steering, content: "Make the protagonist the murderer" },
    f.inventory, grounded).amendment?.affectedAssignments, ["focus:character.mara"]);
  assert.deepEqual(f.make({ ...f.steering, content: "Make Mara the murderer" },
    f.inventory, grounded).amendment?.affectedAssignments, ["focus:character.mara"]);
  assert.deepEqual(f.make({ ...f.steering, content: "Make Mara the murderer, then revise event.alibi" },
    f.inventory, grounded).amendment?.affectedAssignments,
    ["focus:character.mara", "focus:event.alibi"],
    "named and canonical targets both remain visible to the scope guard");
  const ambiguous = grounded.map(record => record.metadata.id === "character.ivan"
    ? { ...record, metadata: { ...record.metadata, title: "Ivan", narrative_role: "protagonist" } }
    : record) as CanonicalScopeRecord[];
  assert.equal(rejection({ ...f.steering, content: "Make the protagonist the murderer" },
    [], ambiguous).kind, "review-required", "ambiguous protagonist role needs explicit scope review");
  assert.equal(rejection({ ...f.steering, content: "Edit character.mara and character.ivan" }).kind, "review-required");
  assert.equal(rejection({ ...f.steering, content: "Retcon protected creative direction" }).kind, "review-required");
  assert.equal(rejection({ ...f.steering, content: "Cancel job" }).kind, "review-required");
  const protectedCatalog = f.records.map(record => record.metadata.id === "character.mara"
    ? { ...record, metadata: { ...record.metadata, decisions: ["keep this"] } }
    : record) as CanonicalScopeRecord[];
  assert.equal(rejection(f.steering, [], protectedCatalog).kind, "review-required");
  await saveSteeringAmendment(f.job, f.turn, f.make().amendment!);
  const prior = await readSteeringPlan(f.job);
  const tamper = f.make({ ...f.steering, content: "Replace the entire Story" },
    f.inventory, f.records, prior);
  assert.equal(tamper.decision.kind, "review-required");
  writeFileSync(join(f.stateDir, "steering-plan.json"),
    JSON.stringify({ ...prior, entries: [{ ...prior!.entries[0], direction: "tampered" }] }));
  await assert.rejects(readSteeringPlan(f.job), /corrupt/);
});
