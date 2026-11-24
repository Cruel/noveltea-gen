import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { JobStartResult } from "../src/job.js";
import type { CanonicalScopeRecord } from "../src/focused-scope.js";
import type { GenerationInventory, ExecutionItem } from "../src/generation-plan.js";
import { nextExecutionItem, invalidateChangedVerifiedPrerequisites } from "../src/generation-plan.js";
import { pendingTopologicalOrder } from "../src/pending-work.js";
import { authorizePendingAmendment, applyPendingAmendment, pendingDigest,
  type PendingProposal, type PendingOmissionProof } from "../src/pending-work-amendments.js";
import { emptyPendingState, readPendingState, savePendingState, applyPendingHistory,
  beginPendingReview, settlePendingReview, assertPendingReviewSettled,
  verifyPinnedPendingWork } from "../src/pending-work-state.js";

const head = "a".repeat(40), nextHead = "b".repeat(40);
const turnDigest = "c".repeat(64), niaHash = "d".repeat(64), solHash = "e".repeat(64);
const reviewer = "f".repeat(64);
const item = (id: string, dependencies: string[], status: ExecutionItem["status"],
  sha?: string): ExecutionItem => ({
    id, stage: id.startsWith("focus:") ? "focus" : id as ExecutionItem["stage"],
    ...(id.startsWith("focus:") ? { milestone: id.slice(6) } : {}),
    kind: "realization", targetIds: id.startsWith("focus:") ? [id.slice(6)] : [],
    dependencies, plannedItems: [], skills: [], checks: [],
    authorization: { source: "trusted-controller", planVersion: 1, paths: [] },
    planVersion: 1, status, ...(sha ? { verifiedSha: sha } : {}),
  });
const inventory = (): GenerationInventory => ({
  version: 1, planVersion: 1, headSha: head, invalidationVersion: 1, rationale: "Native verified input",
  items: [
    item("foundation", [], "verified", head),
    item("architecture", ["foundation"], "verified", head),
    item("focus:character.nia", ["architecture"], "pending"),
    item("focus:character.sol", ["architecture"], "pending"),
    item("review", ["focus:character.nia", "focus:character.sol"], "pending"),
  ],
});
const proof: PendingOmissionProof = {
  assignmentId: "focus:character.nia", sourceSha: head, path: "characters/nia.md",
  sourceHash: niaHash, context: [{ path: "relationships/nia-sol.md", sha256: solHash }],
  evidence: "characters/nia.md:15 independently reviewed the requested outcome",
  reviewerSession: "/private/review-sessions/verified.jsonl",
  reviewerSnapshot: reviewer, verdict: "pass",
};
const proposal = (): PendingProposal => ({
  sourceSha: head, turnDigest, beforeVersion: 1,
  order: ["focus:character.sol", "review"], prune: [proof.assignmentId],
  prerequisites: [], reason: "Pinned independent review finds the canon already fulfills Nia.",
});
const input = () => ({
  proposal: proposal(), inventory: inventory(), turnDigest, version: 1,
  omissionProofs: [proof], sourceHashes: { [proof.path]: niaHash, "relationships/nia-sol.md": solHash },
  authorizedPaths: { [proof.assignmentId]: [proof.path] },
  protectedPaths: [] as string[], canonicalEdges: [] as Array<{ item: string; needs: string }>,
  reviewed: [{ id: "foundation", sha: head }, { id: "architecture", sha: head }],
});

test("independent source-bound omission prunes one pending assignment, not the remaining delivery review", () => {
  const source = input();
  const amendment = authorizePendingAmendment(source);
  assert.equal(amendment.beforeVersion, 1);
  assert.equal(amendment.afterVersion, 2);
  assert.deepEqual(amendment.carried, [
    { id: "foundation", sha: head }, { id: "architecture", sha: head },
  ]);
  const effective = applyPendingAmendment(source.inventory, amendment);
  assert.equal(effective.items.find(i => i.id === "focus:character.nia")?.status, "verified");
  assert.equal(effective.items.find(i => i.id === "focus:character.nia")?.omission?.reviewerSession, proof.reviewerSession);
  assert.equal(nextExecutionItem(effective, amendment.order)?.id, "focus:character.sol");
  assert.equal(effective.items.find(i => i.id === "review")?.status, "pending");
  assert.deepEqual(source.inventory, inventory(), "the original architecture/Turn plan remains unchanged");
});

test("trusted canonical prerequisites reorder runnable pending work while preserving causal ordering", () => {
  const src = input();
  src.proposal = { ...src.proposal, prune: [], order: [
    "focus:character.sol", "focus:character.nia", "review" ],
    prerequisites: [{ item: "focus:character.nia", needs: "focus:character.sol" }] };
  src.canonicalEdges = [...src.proposal.prerequisites];
  const amendment = authorizePendingAmendment(src);
  const effective = applyPendingAmendment(src.inventory, amendment);
  assert.equal(effective.items.find(i => i.id === "focus:character.nia")?.dependencies.at(-1),
    "focus:character.sol");
  assert.equal(nextExecutionItem(effective, amendment.order)?.id, "focus:character.sol");
  assert.deepEqual(pendingTopologicalOrder(effective, [
    "focus:character.nia", "focus:character.sol" ]).slice(-3),
    ["focus:character.sol", "focus:character.nia", "review"]);

  assert.throws(() => authorizePendingAmendment({ ...src,
    proposal: { ...src.proposal, order: [
      "focus:character.nia", "focus:character.sol", "review" ] } }), /causal prerequisite/);
  assert.throws(() => authorizePendingAmendment({ ...src, canonicalEdges: [] }),
    /source-grounded typed causal link/);
  assert.throws(() => authorizePendingAmendment({ ...src,
    proposal: { ...src.proposal, prerequisites: [
      { item: "focus:character.nia", needs: "focus:character.nia" }] } }),
    /typed causal link/);
});

test("unsafe omitted work, scope changes, stale sources, protected choices and forged reviews fail closed", () => {
  const baseline = input();
  const mutate = [
    { ...baseline, proposal: { ...baseline.proposal, sourceSha: nextHead } },
    { ...baseline, proposal: { ...baseline.proposal, turnDigest: "0".repeat(64) } },
    { ...baseline, proposal: { ...baseline.proposal, beforeVersion: 2 } },
    { ...baseline, proposal: { ...baseline.proposal, order: ["review"] } },
    { ...baseline, proposal: { ...baseline.proposal, prune: ["focus:character.invented"] } },
    { ...baseline, proposal: { ...baseline.proposal, prune: ["review"] } },
    { ...baseline, omissionProofs: [] },
    { ...baseline, omissionProofs: [{ ...proof, sourceHash: "0".repeat(64) }] },
    { ...baseline, omissionProofs: [{ ...proof, context: [
      { path: "characters/sol.md", sha256: "0".repeat(64) }] }] },
    { ...baseline, omissionProofs: [{ ...proof, reviewerSession: "" }] },
    { ...baseline, omissionProofs: [{ ...proof, reviewerSnapshot: "0" }] },
    { ...baseline, omissionProofs: [{ ...proof, evidence: "I read it, trust me" }] },
    { ...baseline, omissionProofs: [{ ...proof, verdict: "block" as never }] },
    { ...baseline, authorizedPaths: { [proof.assignmentId]: ["characters/else.md"] } },
    { ...baseline, protectedPaths: ["characters/nia.md"] },
    { ...baseline, reviewed: [{ id: "foundation", sha: head }] },
    { ...baseline, reviewed: [{ id: "foundation", sha: head },
      { id: "architecture", sha: nextHead }] },
  ];
  for (const [i, candidate] of mutate.entries())
    assert.throws(() => authorizePendingAmendment(candidate), undefined, "negative case " + i);
  const authorized = authorizePendingAmendment(baseline);
  assert.throws(() => applyPendingAmendment({ ...baseline.inventory, headSha: nextHead },
    authorized), /no longer matches/);
  assert.throws(() => applyPendingAmendment({ ...baseline.inventory,
    items: baseline.inventory.items.slice(1) }, authorized), /no longer matches/);
});

test("a new downstream dependency invalidates only the affected verified checkpoint, not separate commits", () => {
  const before = inventory();
  for (const item of before.items) if (item.id === "focus:character.nia" ||
      item.id === "focus:character.sol") {
    item.status = "verified";
    item.verifiedSha = head;
  }
  const reviewed = before.items.find(item => item.id === "review")!;
  reviewed.status = "verified";
  reviewed.verifiedSha = head;
  const after = structuredClone(before);
  const nia = after.items.find(item => item.id === "focus:character.nia")!;
  nia.dependencies.push("focus:character.sol");
  invalidateChangedVerifiedPrerequisites(after.items, before);
  assert.equal(nia.status, "blocked");
  assert.match(nia.blockingReason ?? "", /Verified checkpoint has a new causal prerequisite/);
  assert.equal(nia.verifiedSha, undefined, "the historical commit remains on Git, not treated as proof of the new edge");
  assert.equal(after.items.find(item => item.id === "focus:character.sol")?.status, "verified");
  assert.equal(after.items.find(item => item.id === "architecture")?.status, "verified");
  assert.equal(after.items.find(item => item.id === "review")?.status, "blocked",
    "downstream semantic review cannot remain verified against a changed prerequisite");
  const repeated = structuredClone(before);
  repeated.items.find(item => item.id === nia.id)!.dependencies = [...nia.dependencies];
  invalidateChangedVerifiedPrerequisites(repeated.items, after);
  assert.equal(repeated.items.find(item => item.id === nia.id)?.status, "blocked",
    "a repeat reconciliation cannot silently restore stale checkpoint assurance");
  assert.equal(repeated.items.find(item => item.id === "review")?.status, "blocked");
});

test("C08 persisted causal invalidation is typed; changed display wording cannot clear or forge a blocked checkpoint", () => {
  const prior = inventory();
  for (const item of prior.items)
    if (["focus:character.nia", "focus:character.sol", "review"].includes(item.id)) {
      item.status = "verified";
      item.verifiedSha = head;
    }
  const altered = structuredClone(prior);
  const nia = altered.items.find(i => i.id === "focus:character.nia")!;
  nia.dependencies.push("focus:character.sol");
  invalidateChangedVerifiedPrerequisites(altered.items, prior);
  assert.equal(nia.invalidation, "causal-new-edge");
  assert.equal(altered.items.find(i => i.id === "review")?.invalidation, "dependent-revalidation");

  const replay = structuredClone(prior);
  replay.items.find(i => i.id === nia.id)!.dependencies = [...nia.dependencies];
  for (const item of altered.items) if (item.invalidation)
    item.blockingReason = "Diagnostic text changed or localized by a newer CLI.";
  invalidateChangedVerifiedPrerequisites(replay.items, altered);
  assert.equal(replay.items.find(i => i.id === nia.id)?.status, "blocked");
  assert.equal(replay.items.find(i => i.id === "review")?.status, "blocked");

  const forged = structuredClone(prior);
  forged.items.find(i => i.id === nia.id)!.blockingReason =
    "Verified checkpoint has a new causal prerequisite: an attacker-controlled message";
  const unchanged = structuredClone(prior);
  invalidateChangedVerifiedPrerequisites(unchanged.items, forged);
  assert.equal(unchanged.items.find(i => i.id === nia.id)?.status, "verified",
    "unauthenticated prose must never create a causal invalidation");

  const oldCheckpoint = structuredClone(prior);
  delete oldCheckpoint.invalidationVersion;
  const oldItem = oldCheckpoint.items.find(i => i.id === nia.id)!;
  oldItem.status = "blocked";
  oldItem.blockingReason = "Legacy checkpoint with unknown blocked reason";
  delete oldItem.invalidation;
  delete oldItem.verifiedSha;
  const sameHead = structuredClone(prior);
  const preserved = structuredClone(oldCheckpoint);
  assert.throws(() => invalidateChangedVerifiedPrerequisites(sameHead.items, oldCheckpoint),
    /obsolete.*inventory/i);
  assert.deepEqual(oldCheckpoint, preserved, "obsolete inventory remains available for inspection");

  const modern = structuredClone(prior);
  modern.invalidationVersion = 1;
  const priorAuthorBlock = modern.items.find(i => i.id === nia.id)!;
  priorAuthorBlock.status = "blocked";
  priorAuthorBlock.blockingReason = "Author control pending";
  delete priorAuthorBlock.verifiedSha;
  const independentlyVerified = structuredClone(prior);
  independentlyVerified.invalidationVersion = 1;
  invalidateChangedVerifiedPrerequisites(independentlyVerified.items, modern);
  assert.equal(independentlyVerified.items.find(i => i.id === nia.id)?.status, "verified",
    "current-format noncausal author blocks are not misclassified as legacy invalidation");
});

const canonicalRecords: CanonicalScopeRecord[] = [
  { path: "characters/nia.md", metadata: { id: "character.nia", type: "character",
    status: "approved", decisions: [] } },
  { path: "characters/sol.md", metadata: { id: "character.sol", type: "character",
    status: "draft", decisions: [] } },
  { path: "relationships/nia-sol.md", metadata: { id: "relationship.nia-sol",
    type: "relationship", status: "draft", decisions: [],
    characters: ["character.nia", "character.sol"] } },
];

function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), "nt-pending-work-"));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(root, "seed"), "Story base");
  git("add", "seed"); git("commit", "-qm", "Story base");
  const sha = git("rev-parse", "HEAD");
  const job = { stateDir: root, worktreeRoot: root, jobId: "saved-job",
    threadId: "saved-thread" } as JobStartResult;
  return { job, root, git, sha };
}

test("private receipt survives restart; identical evidence never re-enters a reviewer and interruptions fail closed", async () => {
  const f = repoFixture();
  try {
    const state = emptyPendingState(f.job, turnDigest);
    assert.equal(await readPendingState(f.job, turnDigest), null);
    await assert.rejects(verifyPinnedPendingWork(f.job, turnDigest, 2), /history is missing/);
    await verifyPinnedPendingWork(f.job, turnDigest, null);
    await assert.rejects(verifyPinnedPendingWork(f.job, undefined, 2), /no original Turn authority/);
    const signature = pendingDigest({ source: f.sha, pending: "focus:character.nia" });
    assert.equal(await beginPendingReview(f.job, state, signature, f.sha), true);
    const interrupted = await readPendingState(f.job, turnDigest);
    assert.equal(interrupted?.attempts[0]?.outcome, "reviewing");
    assert.throws(() => assertPendingReviewSettled(interrupted!), /Interrupted pending-work reviewer/);
    await assert.rejects(verifyPinnedPendingWork(f.job, turnDigest, null),
      /Interrupted pending-work reviewer/);
    await assert.rejects(beginPendingReview(f.job, interrupted!, signature, f.sha),
      /Interrupted pending-work reviewer/);
    await settlePendingReview(f.job, state, signature, "rejected");
    assert.doesNotThrow(() => assertPendingReviewSettled(state));
    assert.equal(await beginPendingReview(f.job,
      (await readPendingState(f.job, turnDigest))!, signature, f.sha), false);
    assert.equal((await readPendingState(f.job, turnDigest))?.attempts.length, 1);
    await assert.rejects(readPendingState({ ...f.job, threadId: "another" }, turnDigest),
      /identity/);
    await assert.rejects(readPendingState(f.job, "9".repeat(64)), /identity/);
    const tampered = JSON.parse(readFileSync(join(f.root, "pending-work.json"), "utf8"));
    tampered.version = 3;
    writeFileSync(join(f.root, "pending-work.json"), JSON.stringify(tampered));
    await assert.rejects(readPendingState(f.job, turnDigest), /digest|identity/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("resuming amended pending work retains verified omissions only while sources and dependencies match", async () => {
  const f = repoFixture();
  try {
    const original = inventory();
    const amendment = authorizePendingAmendment(input());
    const state = emptyPendingState(f.job, turnDigest);
    // The authenticated source HEAD in the receipt is the real fixture commit.
    const base = { ...original, headSha: f.sha };
    const authorized = authorizePendingAmendment({ ...input(),
      inventory: base, proposal: { ...proposal(), sourceSha: f.sha },
      omissionProofs: [{ ...proof, sourceSha: f.sha }],
      reviewed: [{ id: "foundation", sha: head }, { id: "architecture", sha: head }] });
    state.entries.push(authorized);
    state.version = 2;
    await savePendingState(f.job, state);
    await verifyPinnedPendingWork(f.job, turnDigest, 2);
    await assert.rejects(verifyPinnedPendingWork(f.job, turnDigest, 3), /history is missing/);
    const stored = (await readPendingState(f.job, turnDigest))!;
    assert.equal(stored.entries[0]?.reason, authorized.reason);
    const live = await applyPendingHistory(f.job, stored, base, input().sourceHashes, [],
      canonicalRecords);
    assert.equal(live.inventory.items.find(i => i.id === proof.assignmentId)?.status, "verified");
    assert.equal(live.inventory.items.find(i => i.id === proof.assignmentId)?.omission?.reviewerSession, proof.reviewerSession);
    const changed = await applyPendingHistory(f.job, stored, base, {
      ...input().sourceHashes, "relationships/nia-sol.md": "0".repeat(64) }, [],
      canonicalRecords);
    assert.deepEqual(changed.invalidated, [proof.assignmentId]);
    assert.equal(changed.inventory.items.find(i => i.id === proof.assignmentId)?.status, "pending");
    assert.equal(changed.inventory.items.find(i => i.id === "architecture")?.status, "verified");
    assert.equal(nextExecutionItem(changed.inventory)?.id, proof.assignmentId);
    // An entirely new inbound canonical relationship revokes the omission,
    // even when the original Character and original context have not changed.
    const newRelation: CanonicalScopeRecord = {
      path: "relationships/nia-sibling.md",
      metadata: { id: "relationship.nia-sibling", type: "relationship", status: "draft",
        decisions: [], characters: ["character.nia", "character.new"] },
    };
    const expanded = await applyPendingHistory(f.job, stored, base,
      { ...input().sourceHashes, [newRelation.path]: "4".repeat(64) }, [],
      [...canonicalRecords, newRelation]);
    assert.deepEqual(expanded.invalidated, [proof.assignmentId]);
    assert.equal(expanded.inventory.items.find(i => i.id === proof.assignmentId)?.status, "pending");
    const dependent = structuredClone(base);
    const sol = dependent.items.find(i => i.id === "focus:character.sol")!;
    sol.dependencies.push(proof.assignmentId);
    sol.status = "verified";
    sol.verifiedSha = f.sha;
    const affected = await applyPendingHistory(f.job, stored, dependent,
      { ...input().sourceHashes, [newRelation.path]: "4".repeat(64) }, [],
      [...canonicalRecords, newRelation]);
    assert.equal(affected.inventory.items.find(i => i.id === "focus:character.sol")?.status,
      "blocked", "a committed downstream result loses assurance without its prerequisite");
    assert.match(affected.inventory.items.find(i => i.id === "focus:character.sol")?.blockingReason ?? "",
      /invalidated omission/);
    assert.equal(affected.inventory.items.find(i => i.id === "architecture")?.status, "verified");
    assert.notEqual(amendment.sourceSha, f.sha);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
