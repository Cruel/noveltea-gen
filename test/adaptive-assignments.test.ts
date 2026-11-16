import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../src/architecture.js";
import type { ExecutionItem, GenerationInventory } from "../src/generation-plan.js";
import { invalidateChangedVerifiedPrerequisites } from "../src/generation-plan.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments, revalidateAdaptiveAmendment,
  removeAdaptiveOverlays,
  type AdaptiveProposal } from "../src/adaptive-assignments.js";

const head = "a".repeat(40), turn = "b".repeat(64);
function work(id: string, stage: ExecutionItem["stage"], dependencies: string[], status: ExecutionItem["status"] = "pending"): ExecutionItem {
  const milestone = id.includes(":") ? id.split(":")[1] : undefined;
  return { id, stage, ...(milestone ? { milestone } : {}), kind: stage === "composition" ? "composition" : "realization",
    targetIds: milestone ? [milestone] : [], dependencies, plannedItems: [], skills: [], checks: [],
    authorization: { source: "trusted-controller", planVersion: 1, paths: [] },
    planVersion: 1, status, ...(status === "verified" ? { verifiedSha: head } : {}) };
}
const plan = (): Plan => ({ version: 1, contract: { scope: { kind: "full-story", depth: "composition",
  targets: [], branches: [] }, constraints: [], envelope: { presentation: "visual novel",
  hardLimits: [], preferences: [] } }, items: [{
    ...work("global-architecture", "architecture", [], "verified"), kind: "architecture",
    targetIds: ["milestone.discovery", "milestone.choice"],
  }] });
function inventory(): GenerationInventory {
  return { version: 1, planVersion: 1, headSha: head, rationale: "Native Story",
    items: [work("foundation", "foundation", [], "verified"),
      work("architecture", "architecture", ["foundation"], "verified"),
      work("foundations", "foundations", ["architecture"], "verified"),
      work("event:milestone.discovery", "event", ["foundations"], "verified"),
      work("interactive:milestone.discovery", "interactive", ["event:milestone.discovery"]),
      work("composition:milestone.discovery", "composition", ["interactive:milestone.discovery"]),
      work("review", "review", ["composition:milestone.discovery"])] };
}
const records = [
  { path: "creative-direction/foundation.md", metadata: { type: "creative-direction",
    id: "creative-direction.foundation", status: "approved", decisions: [] } },
  { path: "milestones/discovery.md", metadata: { type: "milestone",
    id: "milestone.discovery", status: "approved", decisions: [] } },
  { path: "milestones/choice.md", metadata: { type: "milestone",
    id: "milestone.choice", status: "approved", decisions: [] } },
];
const hashes = Object.fromEntries(records.map(r => [r.path, "d".repeat(64)]));
const base = (p: AdaptiveProposal) => ({
  proposal: p, inventory: inventory(), plan: plan(), turnDigest: turn, version: 1,
  records, sourceHashes: hashes, protectedPaths: [] as string[],
  typedEdges: [] as Array<{ item: string; needs: string }>,
  authorTargets: [] as string[], planning: { choice_frequency: "frequent" as const,
    puzzle_emphasis: "none" as const, choice_points: { min: 2, max: 10 } },
  verifiedSource: true, carried: [
    { id: "foundation", sha: head }, { id: "architecture", sha: head },
    { id: "foundations", sha: head }, { id: "event:milestone.discovery", sha: head }],
  omissionProofs: [] as Array<{ assignmentId: string; sourceSha: string; path: string;
    sourceHash: string; evidence: string; reviewerSession: string; reviewerSnapshot: string }>,
});
const proposal = (actions: AdaptiveProposal["actions"], order: string[]): AdaptiveProposal => ({
  sourceSha: head, turnDigest: turn, beforeVersion: 1, reason: "Source-backed causal coverage",
  actions, order,
});
test("choice-heavy Story splits only the selected Milestone, adds a verified-architecture Event, and retains whole-Story review", () => {
  const p = proposal([
    { kind: "split", item: "interactive:milestone.discovery", domains: ["choice", "puzzle"] },
    { kind: "add", stage: "event", milestone: "milestone.choice", dependsOn: ["foundations"] },
    { kind: "add", stage: "interactive", milestone: "milestone.choice", dependsOn: ["event:milestone.choice"] },
    { kind: "add", stage: "composition", milestone: "milestone.choice", dependsOn: ["interactive:milestone.choice"] },
  ], ["choice:milestone.discovery", "puzzle:milestone.discovery", "composition:milestone.discovery",
    "event:milestone.choice", "interactive:milestone.choice", "composition:milestone.choice", "review"]);
  const src = base(p);
  // Puzzle is an independently reviewed assessment, not a mandate to author
  // a formal Puzzle. Even a Choice-heavy no-Puzzle Story needs this gate.
  const seal = admitAdaptiveAssignments(src);
  const updated = applyAdaptiveAssignments(src.inventory, seal);
  assert.equal(updated.items.find(i => i.id === "interactive:milestone.discovery"), undefined);
  assert.equal(updated.items.find(i => i.id === "choice:milestone.discovery")?.stage, "choice");
  assert.deepEqual(updated.items.find(i => i.id === "composition:milestone.discovery")?.dependencies,
    ["puzzle:milestone.discovery"]);
  assert.deepEqual(updated.items.find(i => i.id === "review")?.dependencies,
    ["composition:milestone.discovery", "composition:milestone.choice"]);
  assert.deepEqual(seal.order, p.order);
  assert.equal(updated.items.find(i => i.id === "event:milestone.discovery")?.status, "verified");
  assert.deepEqual(src.inventory, inventory(), "the approved architecture inventory remains unchanged");
  const canonical = removeAdaptiveOverlays(updated, [seal]);
  assert.deepEqual(canonical.items.map(i => [i.id, i.stage, i.dependencies, i.status]),
    src.inventory.items.map(i => [i.id, i.stage, i.dependencies, i.status]),
    "added Event/Interactive/Composition and split aliases must all be reversible");
});
test("canonical parent reconciliation does not invalidate completed Composition when a Choice/Puzzle overlay is reapplied", () => {
  const p = proposal([{ kind: "split", item: "interactive:milestone.discovery", domains: ["choice", "puzzle"] }],
    ["choice:milestone.discovery", "puzzle:milestone.discovery", "composition:milestone.discovery", "review"]);
  const src = base(p);
  const seal = admitAdaptiveAssignments(src);
  const prior = applyAdaptiveAssignments(src.inventory, seal);
  for (const stage of ["choice", "puzzle", "composition"]) {
    const unit = prior.items.find(i => i.id === stage + ":milestone.discovery")!;
    unit.status = "verified"; unit.verifiedSha = head;
  }
  const next = inventory();
  const composition = next.items.find(i => i.id === "composition:milestone.discovery")!;
  composition.status = "verified"; composition.verifiedSha = head;
  const incorrectlyCompared = structuredClone(next);
  invalidateChangedVerifiedPrerequisites(incorrectlyCompared.items, prior);
  assert.equal(incorrectlyCompared.items.find(i => i.id === composition.id)?.status, "blocked",
    "this is the original false invalidation, not a real new source prerequisite");
  const canonicalPrior = removeAdaptiveOverlays(prior, [seal]);
  assert.equal(canonicalPrior.items.find(i => i.id === "choice:milestone.discovery"), undefined);
  assert.deepEqual(canonicalPrior.items.find(i => i.id === composition.id)?.dependencies,
    ["interactive:milestone.discovery"]);
  assert.equal(canonicalPrior.items.find(i => i.id === "interactive:milestone.discovery")?.status, "pending");
  invalidateChangedVerifiedPrerequisites(next.items, canonicalPrior);
  assert.equal(next.items.find(i => i.id === composition.id)?.status, "verified");
  const recovered = removeAdaptiveOverlays(applyAdaptiveAssignments(src.inventory, seal), [seal]);
  assert.deepEqual(recovered.items.map(i => [i.id, i.stage, i.dependencies, i.status]),
    src.inventory.items.map(i => [i.id, i.stage, i.dependencies, i.status]));
});
test("adaptive amendment revalidates exact persisted actions after unrelated verified commits", () => {
  const p = proposal([{ kind: "split", item: "interactive:milestone.discovery",
    domains: ["choice", "puzzle"] }],
  ["choice:milestone.discovery", "puzzle:milestone.discovery",
    "composition:milestone.discovery", "review"]);
  const initial = base(p);
  const seal = admitAdaptiveAssignments(initial);
  const continued = base(p);
  const changedHead = "f".repeat(40);
  continued.inventory = { ...continued.inventory, headSha: changedHead };
  continued.carried = [...initial.carried];
  const restored = revalidateAdaptiveAmendment(seal, continued);
  assert.deepEqual(restored.order, p.order);
  assert.equal(restored.inventory.items.find(i => i.id === "choice:milestone.discovery")?.status, "pending");
  assert.equal(restored.inventory.items.find(i => i.id === "interactive:milestone.discovery"), undefined);
  // A protected baseline, source or reviewed prior step cannot change silently
  // under the stored model proposal. It needs a separate approved revision.
  const altered = base(p);
  altered.inventory = { ...altered.inventory, headSha: changedHead };
  altered.carried = [...initial.carried];
  altered.carried[3] = { id: "event:milestone.discovery", sha: "f".repeat(40) };
  assert.throws(() => revalidateAdaptiveAmendment(seal, altered), /checkpoint|carried|verified/i);
  assert.throws(() => revalidateAdaptiveAmendment({ ...seal, actions: [] }, continued), /tampered|digest/i);
  assert.throws(() => revalidateAdaptiveAmendment(seal, { ...continued,
    plan: { ...continued.plan, version: 2 } }), /plan|version/i);
});
test("narrative-led no-Puzzle omission needs independent source-bound evidence; global review remains", () => {
  const p = proposal([{ kind: "omit", item: "interactive:milestone.discovery" }],
    ["composition:milestone.discovery", "review"]);
  const src = base(p);
  src.planning = { choice_frequency: "none", puzzle_emphasis: "none", choice_points: { max: 0 } };
  assert.throws(() => admitAdaptiveAssignments(src), /independent|omission/i);
  src.omissionProofs = [{
    assignmentId: "interactive:milestone.discovery", sourceSha: head,
    path: "milestones/discovery.md", sourceHash: hashes["milestones/discovery.md"]!,
    evidence: "milestones/discovery.md:12 review confirms Event-only fulfillment",
    reviewerSession: "/private/review.jsonl", reviewerSnapshot: "f".repeat(64),
  }];
  const updated = applyAdaptiveAssignments(src.inventory, admitAdaptiveAssignments(src));
  assert.equal(updated.items.find(i => i.id === "interactive:milestone.discovery")?.status, "verified");
  assert.equal(updated.items.find(i => i.id === "review")?.status, "pending");
  const undone = removeAdaptiveOverlays(updated, [admitAdaptiveAssignments(src)]);
  assert.equal(undone.items.find(i => i.id === "interactive:milestone.discovery")?.status,
    "pending", "the omission is not an authored commit and may need re-review on later source");
});
test("controller rejects stale, protected, tampered, unauthorized and cyclic amendments", () => {
  const p = proposal([{ kind: "add", stage: "event", milestone: "milestone.choice",
    dependsOn: ["foundations"] }], ["interactive:milestone.discovery", "composition:milestone.discovery",
    "event:milestone.choice", "review"]);
  const src = base(p);
  assert.doesNotThrow(() => admitAdaptiveAssignments(src));
  assert.throws(() => admitAdaptiveAssignments({ ...src, verifiedSource: false }), /native|verified/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, sourceSha: "0".repeat(40) } }), /source|identity/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, turnDigest: "0".repeat(64) } }), /source|identity/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ kind: "add", stage: "event",
      milestone: "milestone.unapproved", dependsOn: ["foundations"] }] } }), /architecture|scope/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ kind: "add", stage: "event",
      milestone: "milestone.choice", dependsOn: ["review"] }] } }), /cycle|causal/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ kind: "split", item: "interactive:milestone.discovery",
      domains: ["choice"] }] } }), /domains|specialist/i);
  // Native milestone and valid DAG alone are insufficient: a specialist
  // cannot run ahead of its real prerequisite authoring/review receipt.
  for (const [stage, dependsOn] of [
    ["event", ["composition:milestone.discovery"]],
    ["interactive", ["foundations"]],
    ["composition", ["event:milestone.discovery"]],
  ] as const) {
    const action = { kind: "add" as const, stage, milestone: "milestone.choice", dependsOn: [...dependsOn] };
    assert.throws(() => admitAdaptiveAssignments({ ...src,
      proposal: { ...p, actions: [action] } }), /prerequisite|causal|pipeline/i,
      "incorrect typed dependency: " + stage);
  }
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ kind: "omit", item: "interactive:milestone.discovery" }],
      order: ["composition:milestone.discovery", "review"] } }), /independent|omission/i);
  const cross = base(proposal([{ kind: "add", stage: "event",
    milestone: "milestone.choice", dependsOn: ["foundations", "event:milestone.discovery"] }],
    ["interactive:milestone.discovery", "composition:milestone.discovery", "event:milestone.choice", "review"]));
  assert.throws(() => admitAdaptiveAssignments(cross), /typed|source-grounded|canonical/i);
  cross.typedEdges.push({ item: "event:milestone.choice", needs: "event:milestone.discovery" });
  assert.doesNotThrow(() => admitAdaptiveAssignments(cross),
    "original verified architecture may explicitly justify cross-Milestone causal precedence");
  const omit = base(proposal([{ kind: "omit", item: "interactive:milestone.discovery" }],
    ["composition:milestone.discovery", "review"]));
  omit.omissionProofs = [{ assignmentId: "interactive:milestone.discovery", sourceSha: head,
    path: "milestones/discovery.md", sourceHash: hashes["milestones/discovery.md"]!,
    evidence: "milestones/discovery.md:12", reviewerSession: "/review.jsonl",
    reviewerSnapshot: "f".repeat(64) }];
  assert.throws(() => admitAdaptiveAssignments({ ...omit,
    protectedPaths: ["milestones/discovery.md"] }), /protected|omission/i);
  assert.throws(() => admitAdaptiveAssignments({ ...omit,
    authorTargets: ["milestone.discovery"] }), /author|omission/i);
  assert.throws(() => admitAdaptiveAssignments({ ...omit,
    sourceHashes: { ...hashes, "milestones/discovery.md": "0".repeat(64) } }), /independent|omission/i);
  const seal = admitAdaptiveAssignments(src);
  assert.throws(() => applyAdaptiveAssignments({ ...src.inventory, headSha: "0".repeat(40) },
    seal), /source|changed/i);
  assert.throws(() => applyAdaptiveAssignments(src.inventory, { ...seal, digest: "0".repeat(64) }),
    /tampered|digest/i);
});
