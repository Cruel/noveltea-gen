/** Source-bound admission of adaptive *executable* Story specialist assignments.
 *
 * This is a controller gate, not a model write grant. Its only new executable
 * targets are Milestones already in verified Architecture and in the native
 * canonical catalog. The source Story, author objective, protected decisions
 * and final whole-Story review are immutable.
 */
import { createHash } from "node:crypto";
import type { Plan } from "./architecture.js";
import type { GenerationInventory, ExecutionItem, GenerationStage } from "./generation-plan.js";
import type { StoryPlanning } from "./story-planning.js";

const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9-]*$/;
const PATH = /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type WorkStage = "event" | "interactive" | "composition";
type Action =
  | { kind: "add"; stage: WorkStage; milestone: string; dependsOn: string[] }
  | { kind: "split"; item: string; domains: Array<"choice" | "puzzle"> }
  | { kind: "omit"; item: string };
export interface AdaptiveProposal {
  sourceSha: string; turnDigest: string; beforeVersion: number; reason: string;
  actions: Action[]; order: string[];
}
export interface AdaptiveOmissionProof {
  assignmentId: string; sourceSha: string; path: string; sourceHash: string;
  evidence: string; reviewerSession: string; reviewerSnapshot: string;
}
export interface AdaptiveAmendment {
  schema: "noveltea-adaptive-assignments/v1";
  sourceSha: string; turnDigest: string;
  beforeVersion: number; afterVersion: number;
  inventoryDigest: string; planVersion: number;
  reason: string; actions: Action[]; order: string[];
  /** Every independent completed unit is retained under its exact checkpoint. */
  carried: Array<{ id: string; sha: string }>;
  omissions: AdaptiveOmissionProof[];
  digest: string;
}
export interface AdaptiveAdmission {
  proposal: AdaptiveProposal; inventory: GenerationInventory; plan: Plan;
  turnDigest: string; version: number;
  /** Caller has independently checked a clean, trusted Git HEAD and strict
   * native validation/protection against that exact HEAD. Not model-supplied. */
  verifiedSource: boolean;
  records: Array<{ path: string; metadata: { id: string; type: string; status: string; decisions?: unknown[] } }>;
  sourceHashes: Record<string, string>;
  protectedPaths: string[];
  /** Native Architecture / controller typed edges, never model asserted. */
  typedEdges?: Array<{ item: string; needs: string }>;
  authorTargets: string[];
  planning: StoryPlanning;
  /** Independently verified original recovery checkpoints, never claimed by Pi. */
  carried: Array<{ id: string; sha: string }>;
  /** Reviewer receipts authenticated by the caller before admission. */
  omissionProofs: AdaptiveOmissionProof[];
}
const exactly = (value: unknown, fields: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
const nonempty = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function checkProposal(proposal: AdaptiveProposal, input: AdaptiveAdmission) {
  if (!exactly(proposal, ["sourceSha", "turnDigest", "beforeVersion", "reason", "actions", "order"]) ||
      !input.verifiedSource || !SHA.test(input.inventory.headSha) ||
      proposal.sourceSha !== input.inventory.headSha ||
      !HASH.test(input.turnDigest) || proposal.turnDigest !== input.turnDigest ||
      proposal.beforeVersion !== input.version || !Number.isSafeInteger(input.version) ||
      input.version < 1 || input.version > 32 ||
      input.inventory.planVersion !== input.plan.version ||
      input.plan.contract.scope.kind !== "full-story" ||
      input.plan.items[0]?.id !== "global-architecture" ||
      input.plan.items[0].status !== "verified" ||
      !nonempty(proposal.reason, 1500) ||
      !Array.isArray(proposal.actions) || proposal.actions.length > 64 ||
      !Array.isArray(proposal.order))
    throw Error("Adaptive source, objective, verified Architecture or version is invalid.");
}

function validateCausal(items: ExecutionItem[], order: string[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  if (byId.size !== items.length) throw Error("Adaptive assignment identity is duplicated.");
  const done = new Set(items.filter(i => i.status === "verified").map(i => i.id));
  const pending = items.filter(i => i.status === "pending");
  if (order.length !== pending.length || new Set(order).size !== order.length ||
      pending.some(item => !order.includes(item.id)))
    throw Error("Adaptive order must cover each remaining assignment exactly once.");
  const seen = new Set(done);
  for (const id of order) {
    const item = byId.get(id)!;
    if (item.dependencies.some(parent => !seen.has(parent)))
      throw Error("Adaptive causal cycle, missing prerequisite or inverted order: " + id);
    seen.add(id);
  }
  if (items.some(i => i.status === "blocked" && order.includes(i.id)))
    throw Error("Blocked work cannot be treated as authorized pending work.");
}

/** All operations are authorized independently of proposal prose. */
function project(input: AdaptiveAdmission, omissions: AdaptiveOmissionProof[]): GenerationInventory {
  const items = structuredClone(input.inventory.items);
  const byId = new Map(items.map(i => [i.id, i]));
  const allowed = new Set(input.plan.items[0]!.targetIds.filter(id => MILESTONE.test(id)));
  const current = new Map(input.records.filter(r => r.metadata.status !== "superseded")
    .map(record => [record.metadata.id, record]));
  const added = new Set<string>();
  for (const action of input.proposal.actions) {
    if (action.kind === "add") {
      if (!exactly(action, ["kind", "stage", "milestone", "dependsOn"]) ||
          !["event", "interactive", "composition"].includes(action.stage) ||
          !MILESTONE.test(action.milestone) || !allowed.has(action.milestone) ||
          current.get(action.milestone)?.metadata.type !== "milestone" ||
          !["approved", "draft"].includes(current.get(action.milestone)!.metadata.status) ||
          !input.sourceHashes[current.get(action.milestone)!.path] ||
          action.stage === "composition" && input.plan.contract.scope.depth !== "composition" ||
          action.stage === "interactive" && input.plan.contract.scope.depth === "architecture" ||
          !Array.isArray(action.dependsOn) || action.dependsOn.length > 32 ||
          new Set(action.dependsOn).size !== action.dependsOn.length)
        throw Error("Adaptive addition exceeds verified Architecture scope or native Story state.");
      // A topologically valid plan is not necessarily executable. The
      // native Event specialist always needs Character/World foundations,
      // Interactive needs its own reviewed Event cluster, and Composition
      // needs the exact Milestone's sealed interactive decision. Additional
      // typed causal predecessors are allowed only within the narrative
      // production pipeline; they do not confer another owner's write grant.
      const deps = action.dependsOn.map(id => byId.get(id));
      const predecessor = action.stage === "event"
        ? action.dependsOn.includes("foundations") && deps.every(item => item &&
            ["foundations", "event", "choice", "puzzle"].includes(item.stage))
        : action.stage === "interactive"
          ? action.dependsOn.includes("event:" + action.milestone) &&
            deps.every(item => item && ["event", "interactive", "choice", "puzzle"].includes(item.stage))
          : action.dependsOn.some(id => id === "interactive:" + action.milestone ||
              id === "puzzle:" + action.milestone) &&
            deps.every(item => item && ["interactive", "choice", "puzzle", "composition"].includes(item.stage));
      if (!predecessor)
        throw Error("Adaptive addition lacks a controller-supported typed causal prerequisite.");
      const id = action.stage + ":" + action.milestone;
      const intrinsic = (need: string) => action.stage === "event"
        ? need === "foundations" : action.stage === "interactive"
          ? need === "event:" + action.milestone
          : need === "interactive:" + action.milestone || need === "puzzle:" + action.milestone;
      if (action.dependsOn.some(need => !intrinsic(need) &&
          !input.typedEdges?.some(edge => edge.item === id && edge.needs === need)))
        throw Error("Adaptive cross-assignment prerequisite lacks a native source-grounded typed causal edge.");
      if (byId.has(id) || added.has(id)) throw Error("Adaptive addition duplicates an existing assignment.");
      const template = items.find(i => i.stage === action.stage) ??
        input.inventory.items.find(i => i.stage === action.stage);
      if (!template) throw Error("Adaptive addition has no controller-authorized executor for that stage.");
      const item: ExecutionItem = {
        ...template, id, milestone: action.milestone, kind: action.stage === "composition" ? "composition" : "realization",
        targetIds: [action.milestone], dependencies: [...action.dependsOn], plannedItems: [],
        authorization: { source: "trusted-controller", planVersion: input.plan.version, paths: [] },
        planVersion: input.plan.version, status: "pending",
      };
      delete item.verifiedSha; delete item.blockingReason; delete item.omission;
      items.push(item); byId.set(id, item); added.add(id);
    } else if (action.kind === "split") {
      if (!exactly(action, ["kind", "item", "domains"]) ||
          !Array.isArray(action.domains) ||
          JSON.stringify(action.domains) !== JSON.stringify(["choice", "puzzle"]))
        throw Error("Adaptive split has unsupported specialist domains.");
      const original = byId.get(action.item);
      if (!original || original.stage !== "interactive" || original.status !== "pending" ||
          !original.milestone || !allowed.has(original.milestone) ||
          input.planning.choice_frequency === "none")
        throw Error("Adaptive split exceeds approved Choice/Puzzle profile or pending scope.");
      const index = items.indexOf(original);
      const choice = { ...original, id: "choice:" + original.milestone,
        stage: "choice" as GenerationStage, dependencies: [...original.dependencies],
        skills: ["nt-interactive-narrative", "nt-catalog"] };
      const puzzle = { ...original, id: "puzzle:" + original.milestone,
        stage: "puzzle" as GenerationStage, dependencies: [choice.id],
        skills: ["nt-puzzle-design", "nt-catalog"] };
      const replacement = action.domains.includes("puzzle") ? puzzle.id : choice.id;
      if (byId.has(choice.id) || byId.has(puzzle.id)) throw Error("Adaptive split duplicates an existing unit.");
      items.splice(index, 1, choice, ...(action.domains.includes("puzzle") ? [puzzle] : []));
      byId.delete(original.id); byId.set(choice.id, choice);
      if (action.domains.includes("puzzle")) byId.set(puzzle.id, puzzle);
      for (const item of items) item.dependencies = item.dependencies.map(id => id === original.id ? replacement : id);
    } else if (action.kind === "omit") {
      if (!exactly(action, ["kind", "item"])) throw Error("Adaptive omission action is malformed.");
      const item = byId.get(action.item);
      if (!item || item.stage !== "interactive" || item.status !== "pending" ||
          !item.milestone || input.authorTargets.includes(item.milestone) ||
          input.authorTargets.some(target => target.startsWith("choice-point.") || target.startsWith("puzzle.")))
        throw Error("Adaptive omission cannot remove author-promised gameplay or a non-pending assignment.");
      const proof = omissions.find(p => p.assignmentId === action.item);
      if (!proof) throw Error("Adaptive omission requires positive independent source-bound review.");
      // No global interactive obligation may be erased simply because *one*
      // Milestone is observational. Other independently certified work or
      // remaining assignments must still satisfy the original Story baseline.
      const other = items.filter(i => i.id !== item.id && ["interactive", "choice", "puzzle"].includes(i.stage) &&
        i.status === "pending");
      const choiceCount = input.records.filter(r => r.metadata.type === "choice-point" &&
        r.metadata.status !== "superseded").length;
      const puzzleCount = input.records.filter(r => r.metadata.type === "puzzle" &&
        r.metadata.status !== "superseded").length;
      if (((input.planning.choice_points?.min ?? 0) > choiceCount ||
          ["frequent", "continuous"].includes(input.planning.choice_frequency ?? "")) &&
          !other.some(i => i.stage !== "puzzle") ||
          (input.planning.puzzle_count?.min ?? 0) > puzzleCount &&
          !other.some(i => i.stage !== "choice"))
        throw Error("Adaptive omission would erase the remaining whole-Story interaction obligation.");
      item.status = "verified";
      item.verifiedSha = input.inventory.headSha;
      item.omission = { reason: input.proposal.reason, evidence: proof.evidence,
        reviewerSession: proof.reviewerSession };
    } else throw Error("Adaptive operation kind is unknown.");
  }
  // Every new terminal Milestone must still feed the independent whole-Story
  // review; split replacements preserve the original descendant dependencies.
  const review = byId.get("review");
  if (!review || review.stage !== "review" || review.status !== "pending")
    throw Error("Adaptive assignments require an unchanged pending final goal review.");
  for (const id of added) {
    const item = byId.get(id)!;
    const hasDownstream = items.some(next => next.dependencies.includes(item.id));
    if (!hasDownstream) review.dependencies.push(item.id);
  }
  review.dependencies = [...new Set(review.dependencies)];
  validateCausal(items, input.proposal.order);
  return { ...input.inventory, items, rationale: input.proposal.reason };
}

export function admitAdaptiveAssignments(input: AdaptiveAdmission): AdaptiveAmendment {
  checkProposal(input.proposal, input);
  const { proposal, inventory } = input;
  const verified = inventory.items.filter(i => i.status === "verified");
  if (verified.some(item => !SHA.test(item.verifiedSha ?? "") ||
      !input.carried.some(c => c.id === item.id && c.sha === item.verifiedSha)) ||
      input.carried.length !== verified.length)
    throw Error("Adaptive amendment cannot replay unverified or unrelated saved specialist steps.");
  const omissions: AdaptiveOmissionProof[] = [];
  for (const action of proposal.actions) {
    if (action.kind !== "omit") continue;
    const proof = input.omissionProofs.find(p => p.assignmentId === action.item);
    const record = input.records.find(r => r.path === proof?.path);
    if (!proof || proof.sourceSha !== inventory.headSha ||
        !PATH.test(proof.path) || record?.metadata.status === "superseded" ||
        input.protectedPaths.includes(proof.path) ||
        (record?.metadata.decisions?.length ?? 0) > 0 ||
        !HASH.test(proof.sourceHash) || input.sourceHashes[proof.path] !== proof.sourceHash ||
        !HASH.test(proof.reviewerSnapshot) ||
        !nonempty(proof.reviewerSession, 4096) ||
        !nonempty(proof.evidence, 2000) ||
        !proof.evidence.includes(proof.path + ":"))
      throw Error("Adaptive omission requires authentic independent review of unprotected native sources.");
    omissions.push({ ...proof });
  }
  project(input, omissions);
  const body = {
    schema: "noveltea-adaptive-assignments/v1" as const,
    sourceSha: proposal.sourceSha, turnDigest: proposal.turnDigest,
    beforeVersion: input.version, afterVersion: input.version + 1,
    inventoryDigest: digest(inventory.items), planVersion: input.plan.version,
    reason: proposal.reason, actions: structuredClone(proposal.actions),
    order: [...proposal.order], carried: input.carried.map(c => ({ ...c })), omissions,
  };
  return { ...body, digest: digest(body) };
}

/** Recheck the saved seal before *every* dispatch. The native source and
 * actual writer/checkpoint proofs must be reauthenticated by the caller. */
/** Before the canonical inventory is rebuilt, undo only the private plan\'s
 * structural overlays on the *previous* graph snapshot. The canonical
 * reconciler compares newly discovered dependencies against its own prior
 * architecture shape, never against transient Choice/Puzzle aliases. A
 * failed, interrupted, or unknown specialist is not restored as pending. */
export function removeAdaptiveOverlays(
  previous: GenerationInventory, history: readonly AdaptiveAmendment[],
): GenerationInventory {
  const items = structuredClone(previous.items);
  const item = (id: string) => items.find(entry => entry.id === id);
  for (const amendment of [...history].reverse()) {
    const { digest: signature, ...body } = amendment;
    if (amendment.schema !== "noveltea-adaptive-assignments/v1" ||
        !HASH.test(signature) || digest(body) !== signature)
      throw Error("Canonical recovery cannot undo a tampered adaptive overlay.");
    for (const action of [...amendment.actions].reverse()) {
      if (action.kind === "add") {
        const id = action.stage + ":" + action.milestone;
        const found = item(id);
        if (!found || found.stage !== action.stage || found.milestone !== action.milestone ||
            found.status === "blocked")
          throw Error("Adaptive added specialist is missing or blocked; reconcile its original receipt.");
        items.splice(items.indexOf(found), 1);
        for (const other of items) other.dependencies = other.dependencies.filter(dep => dep !== id);
      } else if (action.kind === "split") {
        const milestone = action.item.slice("interactive:".length);
        const choice = item("choice:" + milestone);
        const puzzle = item("puzzle:" + milestone);
        if (!choice || !puzzle || choice.stage !== "choice" || puzzle.stage !== "puzzle" ||
            choice.status === "blocked" || puzzle.status === "blocked")
          throw Error("Adaptive Choice/Puzzle receipt is missing or blocked; no implicit writer replay.");
        const position = items.indexOf(choice);
        items.splice(items.indexOf(puzzle), 1);
        items.splice(items.indexOf(choice), 1);
        const restored: ExecutionItem = { ...choice, id: action.item, stage: "interactive",
          status: "pending", dependencies: [...choice.dependencies] };
        delete restored.verifiedSha; delete restored.blockingReason; delete restored.omission;
        items.splice(position, 0, restored);
        for (const other of items) other.dependencies = other.dependencies.map(dep =>
          dep === choice.id || dep === puzzle.id ? action.item : dep);
      } else if (action.kind === "omit") {
        const found = item(action.item);
        if (!found || found.stage !== "interactive" || found.status !== "verified" || !found.omission)
          throw Error("Adaptive omitted assignment lost its source-reviewed disposition.");
        found.status = "pending";
        delete found.verifiedSha; delete found.omission;
      } else throw Error("Unknown persisted adaptive action.");
    }
  }
  if (new Set(items.map(i => i.id)).size !== items.length)
    throw Error("Canonical recovery duplicated a work assignment.");
  return { ...previous, items };
}

/** A stored amendment is not a perpetual write grant. At every verified
 * descendant HEAD re-admit its EXACT action list against the new native
 * catalog and unchanged original author intent. Previously reviewed commits
 * cannot be silently replaced, and a newly discovered pending assignment
 * must trigger an explicit new plan instead of being lost from the order. */
export function revalidateAdaptiveAmendment(
  amendment: AdaptiveAmendment, current: AdaptiveAdmission,
): { inventory: GenerationInventory; order: string[] } {
  const { digest: signature, ...saved } = amendment;
  if (amendment.schema !== "noveltea-adaptive-assignments/v1" ||
      !HASH.test(signature) || digest(saved) !== signature ||
      amendment.turnDigest !== current.turnDigest ||
      amendment.planVersion !== current.plan.version ||
      amendment.beforeVersion < 1 || amendment.afterVersion !== amendment.beforeVersion + 1)
    throw Error("Persisted adaptive amendment digest, source objective or plan version was tampered.");
  const prior = new Map(current.inventory.items.filter(i => i.status === "verified")
    .map(i => [i.id, i.verifiedSha]));
  if (amendment.carried.some(item => !SHA.test(item.sha) || prior.get(item.id) !== item.sha) ||
      new Set(amendment.carried.map(item => item.id)).size !== amendment.carried.length)
    throw Error("Adaptive amendment lost an independently verified carried checkpoint.");
  const pending = new Set(current.inventory.items.filter(i => i.status === "pending")
    .map(i => i.id));
  for (const action of amendment.actions) {
    if (action.kind === "add") {
      const id = action.stage + ":" + action.milestone;
      if (pending.has(id) || current.inventory.items.some(i => i.id === id))
        throw Error("Adaptive added work now collides with a new canonical assignment; replan its exact source.");
      pending.add(id);
    } else if (action.kind === "split") {
      if (!pending.delete(action.item))
        throw Error("Adaptive split no longer targets its original unstarted assignment.");
      const milestone = action.item.slice("interactive:".length);
      pending.add("choice:" + milestone);
      if (action.domains.includes("puzzle")) pending.add("puzzle:" + milestone);
    } else if (action.kind === "omit") {
      if (!pending.delete(action.item))
        throw Error("Previously omitted adaptive assignment already changed source state.");
    } else throw Error("Unknown persisted adaptive action.");
  }
  const order = amendment.order.filter(id => pending.delete(id));
  if (pending.size || order.length !== new Set(order).size)
    throw Error("New pending work is absent from the original authenticated adaptive order.");
  const proposal: AdaptiveProposal = {
    sourceSha: current.inventory.headSha, turnDigest: amendment.turnDigest,
    beforeVersion: amendment.beforeVersion, reason: amendment.reason,
    actions: structuredClone(amendment.actions), order,
  };
  const certified = admitAdaptiveAssignments({ ...current, proposal,
    version: amendment.beforeVersion, omissionProofs: amendment.omissions });
  return { inventory: applyAdaptiveAssignments(current.inventory, certified), order };
}

export function applyAdaptiveAssignments(inventory: GenerationInventory,
  amendment: AdaptiveAmendment): GenerationInventory {
  const { digest: seal, ...body } = amendment;
  if (amendment.schema !== "noveltea-adaptive-assignments/v1" ||
      seal !== digest(body) || !HASH.test(seal))
    throw Error("Adaptive assignment receipt digest is missing or tampered.");
  if (inventory.headSha !== amendment.sourceSha ||
      inventory.planVersion !== amendment.planVersion ||
      digest(inventory.items) !== amendment.inventoryDigest)
    throw Error("Adaptive assignment source or inventory changed since admission.");
  // Applying an already admitted exact inventory requires no additional model
  // or partial reauthorization. The private controller caller must supply the
  // verified source to re-admit at a later HEAD, never modify this seal.
  const items = structuredClone(inventory.items);
  const byId = new Map(items.map(i => [i.id, i]));
  for (const action of amendment.actions) {
    if (action.kind === "add") {
      const id = action.stage + ":" + action.milestone;
      const template = items.find(i => i.stage === action.stage) ??
        inventory.items.find(i => i.stage === action.stage);
      if (!template || byId.has(id)) throw Error("Adaptive receipt has a missing executor or duplicate assignment.");
      const item = { ...template, id, milestone: action.milestone,
        targetIds: [action.milestone], dependencies: [...action.dependsOn], plannedItems: [],
        authorization: { source: "trusted-controller" as const, planVersion: amendment.planVersion, paths: [] },
        planVersion: amendment.planVersion, status: "pending" as const };
      delete item.verifiedSha; delete item.blockingReason; delete item.omission;
      items.push(item); byId.set(id, item);
    } else if (action.kind === "split") {
      const old = byId.get(action.item);
      if (!old || old.stage !== "interactive" || !old.milestone) throw Error("Adaptive split no longer has its original pending unit.");
      const choice = { ...old, id: "choice:" + old.milestone,
        stage: "choice" as GenerationStage, skills: ["nt-interactive-narrative", "nt-catalog"] };
      const puzzle = { ...old, id: "puzzle:" + old.milestone,
        stage: "puzzle" as GenerationStage, dependencies: [choice.id],
        skills: ["nt-puzzle-design", "nt-catalog"] };
      const replacement = action.domains.includes("puzzle") ? puzzle.id : choice.id;
      items.splice(items.indexOf(old), 1, choice, ...(action.domains.includes("puzzle") ? [puzzle] : []));
      byId.delete(old.id); byId.set(choice.id, choice);
      if (action.domains.includes("puzzle")) byId.set(puzzle.id, puzzle);
      for (const item of items)
        item.dependencies = item.dependencies.map(dep => dep === old.id ? replacement : dep);
    } else if (action.kind === "omit") {
      const item = byId.get(action.item);
      const proof = amendment.omissions.find(p => p.assignmentId === action.item);
      if (!item || !proof) throw Error("Adaptive omission lost its sealed reviewer.");
      item.status = "verified"; item.verifiedSha = amendment.sourceSha;
      item.omission = { reason: amendment.reason, evidence: proof.evidence,
        reviewerSession: proof.reviewerSession };
    } else throw Error("Unknown adaptive action.");
  }
  const review = byId.get("review");
  if (!review || review.status !== "pending") throw Error("Adaptive receipt lost final review.");
  for (const action of amendment.actions) if (action.kind === "add") {
    const id = action.stage + ":" + action.milestone;
    if (!items.some(i => i.dependencies.includes(id))) review.dependencies.push(id);
  }
  review.dependencies = [...new Set(review.dependencies)];
  validateCausal(items, amendment.order);
  return { ...inventory, items, rationale: amendment.reason };
}
