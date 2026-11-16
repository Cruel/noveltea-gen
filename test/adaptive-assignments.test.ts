import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan } from "../src/architecture.js";
import type { ExecutionItem, GenerationInventory } from "../src/generation-plan.js";
import { invalidateChangedVerifiedPrerequisites, adaptiveDispatchTask, authorizedInventoryComplete } from "../src/generation-plan.js";
import { admitAdaptiveAssignments, applyAdaptiveAssignments, revalidateAdaptiveAmendment,
  removeAdaptiveOverlays, evaluateAdaptiveProposal,
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
  records, sourceHashes: hashes, milestoneSourceHashes: hashes, protectedPaths: [] as string[],
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
test("whole-Story completion never bypasses an admitted pending or blocked specialist", () => {
  const original = inventory();
  assert.equal(authorizedInventoryComplete(null), false);
  assert.equal(authorizedInventoryComplete(original), false);
  const finished = structuredClone(original);
  for (const item of finished.items) {
    item.status = "verified"; item.verifiedSha = head;
  }
  assert.equal(authorizedInventoryComplete(finished), true);
  const newEvent = work("event:milestone.choice", "event", ["foundations"]);
  finished.items.splice(-1, 0, newEvent);
  assert.equal(authorizedInventoryComplete(finished), false,
    "a previously passed final review cannot conceal a newly admitted specialist");
  newEvent.status = "blocked";
  assert.equal(authorizedInventoryComplete(finished), false);
});

test("architecture-only objectives cannot gain Event writing through an adaptive amendment", () => {
  const p = proposal([{ kind: "add", stage: "event", milestone: "milestone.choice", dependsOn: ["foundations"] }],
    ["interactive:milestone.discovery", "composition:milestone.discovery", "event:milestone.choice", "review"]);
  const src = base(p);
  src.plan.contract.scope.depth = "architecture";
  assert.throws(() => admitAdaptiveAssignments(src), /scope/);
});

test("unchanged adaptive proposals still authenticate exact source, objective and schema", () => {
  const p = proposal([], ["interactive:milestone.discovery", "composition:milestone.discovery", "review"]);
  const src = base(p);
  assert.equal(evaluateAdaptiveProposal(src), null);
  for (const replacement of [
    { sourceSha: "0".repeat(40) }, { turnDigest: "0".repeat(64) },
    { beforeVersion: 2 }, { reason: "" }, { authority: "author-approved" },
  ]) assert.throws(() => evaluateAdaptiveProposal({ ...src,
    proposal: { ...p, ...replacement } }), /source|objective|version/);
  assert.throws(() => evaluateAdaptiveProposal({ ...src, verifiedSource: false }), /verified/);
  assert.throws(() => evaluateAdaptiveProposal({ ...src, carried: [] }), /verified/);
});

test("source-grounded pending assignment narrowing changes the actual dispatch objective and can be reversed", () => {
  const p = proposal([{ kind: "narrow", item: "interactive:milestone.discovery",
    sourcePath: "milestones/discovery.md", sourceHash: hashes["milestones/discovery.md"]!,
    outcome: "Provide a consequential clue Choice that fits the approved discovery Milestone." }],
    ["interactive:milestone.discovery", "composition:milestone.discovery", "review"]);
  const src = base(p);
  const amendment = admitAdaptiveAssignments(src);
  const changed = applyAdaptiveAssignments(src.inventory, amendment);
  const interactive = changed.items.find(i => i.id === "interactive:milestone.discovery")!;
  assert.deepEqual(interactive.adaptiveTask, {
    sourcePath: "milestones/discovery.md", sourceHash: hashes["milestones/discovery.md"],
    outcome: "Provide a consequential clue Choice that fits the approved discovery Milestone.",
  });
  assert.equal(src.inventory.items.find(i => i.id === interactive.id)?.adaptiveTask, undefined);
  const protectedBaseline = { ...src, protectedPaths: ["milestones/discovery.md"] };
  assert.equal(admitAdaptiveAssignments(protectedBaseline).digest, amendment.digest,
    "reading a protected Milestone as source must not prohibit bounded downstream work");
  assert.match(adaptiveDispatchTask("Original author goal", interactive),
    /CONTROLLER-ADMITTED ASSIGNMENT REFINEMENT.*interactive:milestone.discovery/);
  assert.match(adaptiveDispatchTask("Original author goal", interactive), /consequential clue Choice/);
  assert.match(adaptiveDispatchTask("Original author goal", interactive), /NOT a grant/);
  assert.equal(adaptiveDispatchTask("Original author goal", src.inventory.items[4]!), "Original author goal");
  assert.deepEqual(revalidateAdaptiveAmendment(amendment, src).inventory.items, changed.items);
  const canonical = removeAdaptiveOverlays(changed, [amendment]);
  assert.deepEqual(canonical.items, src.inventory.items);
  const completed = structuredClone(src);
  const narrowed = completed.inventory.items.find(i => i.id === interactive.id)!;
  narrowed.status = "verified"; narrowed.verifiedSha = head;
  completed.carried.push({ id: narrowed.id, sha: head });
  const inherited = revalidateAdaptiveAmendment(amendment, completed).inventory;
  assert.equal(inherited.items.find(i => i.id === interactive.id)?.status, "verified");
  assert.equal(inherited.items.find(i => i.id === interactive.id)?.adaptiveTask, undefined,
    "later source changes must not replay or renarrow an already reviewed writer");
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ ...p.actions[0], sourceHash: "0".repeat(64) }] } }),
  /source|hash/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ ...p.actions[0], item: "event:milestone.discovery" }] } }),
  /pending/i);
  assert.throws(() => admitAdaptiveAssignments({ ...src,
    proposal: { ...p, actions: [{ ...p.actions[0], sourcePath: "creative-direction/foundation.md",
      sourceHash: hashes["creative-direction/foundation.md"] }] } }),
  /scope|milestone|protected/i);
});

test("pending Event assignments can acquire a native causal prerequisite without replaying verified work", () => {
  const p = proposal([
    { kind: "depend", item: "event:milestone.choice", needs: "event:milestone.discovery" },
  ], ["event:milestone.choice", "interactive:milestone.discovery", "composition:milestone.discovery", "review"]);
  const src = base(p);
  src.inventory.items.splice(4, 0, work("event:milestone.choice", "event", ["foundations"]));
  src.inventory.items.at(-1)!.dependencies.push("event:milestone.choice");
  assert.throws(() => admitAdaptiveAssignments(src), /typed causal/);
  src.typedEdges.push({ item: "event:milestone.choice", needs: "event:milestone.discovery" });
  const receipt = admitAdaptiveAssignments(src);
  const updated = applyAdaptiveAssignments(src.inventory, receipt);
  assert.deepEqual(updated.items.find(i => i.id === "event:milestone.choice")!.dependencies,
    ["foundations", "event:milestone.discovery"]);
  assert.deepEqual(updated.items.filter(i => i.status === "verified"),
    src.inventory.items.filter(i => i.status === "verified"));
  const finished = structuredClone(updated);
  const finishedEvent = finished.items.find(i => i.id === "event:milestone.choice")!;
  finishedEvent.status = "verified"; finishedEvent.verifiedSha = head;
  const reconciled = structuredClone(finished);
  invalidateChangedVerifiedPrerequisites(reconciled.items, removeAdaptiveOverlays(finished, [receipt]));
  assert.equal(reconciled.items.find(i => i.id === finishedEvent.id)!.status, "verified",
    "a native-backed prerequisite is not a transient alias to erase before canonical reconciliation");
  assert.deepEqual(revalidateAdaptiveAmendment(receipt, src).inventory.items, updated.items);
  const nativeCaughtUp = { ...src, inventory: updated };
  assert.deepEqual(revalidateAdaptiveAmendment(receipt, nativeCaughtUp).inventory.items, updated.items);
  assert.throws(() => revalidateAdaptiveAmendment(receipt, { ...nativeCaughtUp, typedEdges: [] }), /typed causal/);
  const cyclic = structuredClone(src);
  cyclic.proposal.actions.push({ kind: "depend", item: "event:milestone.choice", needs: "event:milestone.choice" });
  cyclic.typedEdges.push({ item: "event:milestone.choice", needs: "event:milestone.choice" });
  assert.throws(() => admitAdaptiveAssignments(cyclic), /cycle/);
  const completed = structuredClone(src);
  completed.inventory.items.find(i => i.id === "event:milestone.choice")!.status = "verified";
  completed.inventory.items.find(i => i.id === "event:milestone.choice")!.verifiedSha = head;
  completed.carried.push({ id: "event:milestone.choice", sha: head });
  assert.throws(() => admitAdaptiveAssignments(completed), /pending/);
});

test("late supporting work cannot invalidate completed dependent gameplay or prose", () => {
  const p = proposal([{ kind: "add", stage: "event", milestone: "milestone.choice",
    dependsOn: ["foundations"] }], ["event:milestone.choice", "review"]);
  const src = base(p);
  src.inventory.items = src.inventory.items.filter(i =>
    !["interactive:milestone.discovery", "composition:milestone.discovery"].includes(i.id));
  src.inventory.items.splice(-1, 0,
    work("interactive:milestone.choice", "interactive", ["foundations"], "verified"));
  src.carried.push({ id: "interactive:milestone.choice", sha: head });
  assert.throws(() => admitAdaptiveAssignments(src), /completed|reconciliation|verified/i);
});

test("split assignment can narrow an actual pending Choice with exact review context", () => {
  const p = proposal([
    { kind: "split", item: "interactive:milestone.discovery", domains: ["choice", "puzzle"] },
    { kind: "narrow", item: "choice:milestone.discovery",
      sourcePath: "milestones/discovery.md", sourceHash: hashes["milestones/discovery.md"]!,
      outcome: "Confront the player with a meaningful, evidence-backed choice." },
  ], ["choice:milestone.discovery", "puzzle:milestone.discovery",
    "composition:milestone.discovery", "review"]);
  const src = base(p);
  const entry = admitAdaptiveAssignments(src);
  const after = applyAdaptiveAssignments(src.inventory, entry);
  assert.match(after.items.find(i => i.id === "choice:milestone.discovery")!.adaptiveTask!.outcome,
    /meaningful/);
  assert.deepEqual(revalidateAdaptiveAmendment(entry, src).inventory.items, after.items);
  assert.deepEqual(removeAdaptiveOverlays(after, [entry]).items, src.inventory.items);
  const misordered = proposal([p.actions[1]!, p.actions[0]!],
    ["choice:milestone.discovery", "puzzle:milestone.discovery",
      "composition:milestone.discovery", "review"]);
  assert.throws(() => admitAdaptiveAssignments(base(misordered)), /pending|profile|scope/i,
    "splitting an already-narrowed parent would incorrectly give Puzzle a Choice-only goal");
});

test("controller derives a fresh executable Event grant when no stage template exists", () => {
  const p = proposal([{ kind: "add", stage: "event", milestone: "milestone.discovery",
    dependsOn: ["foundations"] }],
    ["event:milestone.discovery", "interactive:milestone.discovery",
      "composition:milestone.discovery", "review"]);
  const src = base(p);
  src.inventory.items = src.inventory.items.filter(item => item.id !== "event:milestone.discovery");
  src.inventory.items.find(item => item.id === "interactive:milestone.discovery")!.dependencies = [];
  src.carried = src.carried.filter(item => item.id !== "event:milestone.discovery");
  const amended = applyAdaptiveAssignments(src.inventory, admitAdaptiveAssignments(src));
  const added = amended.items.find(item => item.id === "event:milestone.discovery")!;
  assert.deepEqual(added.skills, ["nt-event-design", "nt-catalog"]);
  assert.deepEqual(added.targetIds, ["milestone.discovery"]);
  assert.deepEqual(added.authorization.paths, []);
  assert.deepEqual(amended.items.find(item => item.id === "interactive:milestone.discovery")?.dependencies,
    ["event:milestone.discovery"], "newly required Event must gate existing Interactive work");
  assert.ok(amended.items.find(item => item.id === "composition:milestone.discovery")?.dependencies
    .includes("event:milestone.discovery"),
  "newly required Event must also gate Composition even when Interactive is omitted");
  assert.equal(added.authorization.source, "trusted-controller");
  assert.equal(added.status, "pending");
  assert.deepEqual(removeAdaptiveOverlays(amended, [admitAdaptiveAssignments(src)]).items,
    src.inventory.items);
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
