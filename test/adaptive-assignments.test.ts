import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../src/architecture.js";
import type { ExecutionItem, GenerationInventory } from "../src/generation-plan.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments, type AdaptiveProposal } from "../src/adaptive-assignments.js";

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
  src.planning.puzzle_emphasis = "hybrid";
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
      domains: ["choice", "puzzle"] }] } }), /Puzzle|no-Puzzle/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ kind: "omit", item: "interactive:milestone.discovery" }],
      order: ["composition:milestone.discovery", "review"] } }), /independent|omission/i);
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
