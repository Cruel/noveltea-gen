/** Controller-owned, source-bound amendments to the *remaining* execution plan.
 * This never changes the author objective, signed architecture scope or writer
 * grants. A proposed omission needs separate positive independent review. */
import { createHash } from "node:crypto";
import type { GenerationInventory, ExecutionItem } from "./generation-plan.js";

export const pendingDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface PendingOmissionProof {
  assignmentId: string;
  sourceSha: string;
  path: string;
  sourceHash: string;
  /** Every canonical context source on which the omission verdict relies. */
  context: Array<{ path: string; sha256: string }>;
  /** The independently reviewed, actual Story source line. */
  evidence: string;
  reviewerSession: string;
  reviewerSnapshot: string;
  verdict: "pass";
}
export interface PendingProposal {
  sourceSha: string;
  turnDigest: string;
  beforeVersion: number;
  order: string[];
  /** Only pending work; no reassignment of protected or completed records. */
  prune: string[];
  /** New causal edges; the controller rechecks each against canonical references. */
  prerequisites: Array<{ item: string; needs: string }>;
  reason: string;
}
export interface PendingAmendment {
  beforeVersion: number;
  afterVersion: number;
  sourceSha: string;
  turnDigest: string;
  inventoryDigest: string;
  reason: string;
  order: string[];
  prune: PendingOmissionProof[];
  prerequisites: Array<{ item: string; needs: string }>;
  /** Explicitly preserves independently verified, unchanged results. */
  carried: Array<{ id: string; sha: string }>;
}
export interface PendingState {
  schema: "noveltea-pending-work/v1";
  jobId: string;
  threadId: string;
  turnDigest: string;
  version: number;
  entries: PendingAmendment[];
  /** Candidate failures and repeated identical inputs are bounded. */
  attempts: Array<{ sourceSha: string; signature: string; outcome: "reviewing" | "rejected" | "unchanged" }>;
  digest: string;
}

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const canonical = /^[a-z][a-z-]*\/[a-z][a-z0-9-]*\.md$/;
const nonempty = (value: unknown, max = 2000) =>
  typeof value === "string" && !!value.trim() && value.length <= max;

function checkOrder(items: ExecutionItem[], order: string[], edges: Map<string, string[]>) {
  if (!Array.isArray(order) || new Set(order).size !== order.length ||
      order.length !== items.length || items.some(item => !order.includes(item.id)))
    throw Error("Pending amendment omitted, duplicated or invented active work.");
  const index = new Map(order.map((id, i) => [id, i]));
  for (const item of items) for (const prerequisite of edges.get(item.id) ?? []) {
    if (index.has(prerequisite) && index.get(prerequisite)! > index.get(item.id)!)
      throw Error("Pending amendment reverses a verified causal prerequisite.");
  }
}

/** Authorization is pure: the canonical relation and source bytes, review
 * proof, checkpoint eligibility and original plan are all controller inputs.
 * A model's evidence or permission assertion is not among them. */
export function authorizePendingAmendment(input: {
  proposal: PendingProposal;
  inventory: GenerationInventory;
  turnDigest: string;
  version: number;
  /** Independent, controller-held omission verdicts, not model-supplied. */
  omissionProofs: PendingOmissionProof[];
  /** Native-validated current Story source hashes by canonical path. */
  sourceHashes: Record<string, string>;
  /** Exact controller-resolved writer paths, never a model grant. */
  authorizedPaths: Record<string, string[]>;
  /** Protected canon may not be silently declared fulfilled. */
  protectedPaths: string[];
  /** Controller-verified typed canonical prerequisites, by execution ID. */
  canonicalEdges: Array<{ item: string; needs: string }>;
  /** Checkpointed and independently reviewed commits, still on current HEAD. */
  reviewed: Array<{ id: string; sha: string }>;
}): PendingAmendment {
  const { proposal: p, inventory, reviewed } = input;
  if (!p || Object.keys(p).sort().join(",") !==
        "beforeVersion,order,prerequisites,prune,reason,sourceSha,turnDigest" ||
      !SHA.test(p.sourceSha) || p.sourceSha !== inventory.headSha ||
      p.turnDigest !== input.turnDigest || !HASH.test(input.turnDigest) ||
      p.beforeVersion !== input.version || input.version < 1 || input.version > 4 ||
      !nonempty(p.reason, 1000) || !Array.isArray(p.prune) ||
      p.prune.length > 8 || new Set(p.prune).size !== p.prune.length ||
      !Array.isArray(p.prerequisites) || p.prerequisites.length > 32)
    throw Error("Pending amendment source, plan version or objective differs.");
  const items = inventory.items;
  const byId = new Map(items.map(item => [item.id, item]));
  const carried = items.filter(item => item.status === "verified").map(item => {
    const proof = reviewed.find(r => r.id === item.id && r.sha === item.verifiedSha);
    // A synthetic baseline is reusable only with the exact observed verified
    // source; a post-commit result must be independently checked by the caller.
    if (!item.verifiedSha || !SHA.test(item.verifiedSha) ||
        !proof || !SHA.test(proof.sha))
      throw Error("Pending amendment cannot carry an unverified checkpoint.");
    return { id: item.id, sha: proof.sha };
  });
  const omit = p.prune.map(id => {
    const item = byId.get(id);
    if (!item || item.status !== "pending" || item.stage === "foundation" ||
        item.stage === "architecture" || item.stage === "review" ||
        item.plannedItems.some(x => !nonempty(x)))
      throw Error("Only a pending specialist assignment may be pruned.");
    const proof = input.omissionProofs.find(x => x.assignmentId === id);
    if (!proof || proof.verdict !== "pass" || proof.sourceSha !== p.sourceSha ||
        !canonical.test(proof.path) || !HASH.test(proof.sourceHash) ||
        input.sourceHashes[proof.path] !== proof.sourceHash ||
        !Array.isArray(proof.context) || proof.context.length > 64 ||
        proof.context.some(source => !canonical.test(source.path) ||
          !HASH.test(source.sha256) || input.sourceHashes[source.path] !== source.sha256) ||
        new Set(proof.context.map(source => source.path)).size !== proof.context.length ||
        !input.authorizedPaths[id]?.includes(proof.path) ||
        input.authorizedPaths[id].some(path => input.protectedPaths.includes(path)) ||
        !nonempty(proof.evidence) || !proof.evidence.includes(proof.path + ":") ||
        !nonempty(proof.reviewerSession) || !HASH.test(proof.reviewerSnapshot))
      throw Error("Pruning requires source-bound positive independent review of the exact assignment.");
    return { ...proof };
  });
  const edges = new Map(items.map(item => [item.id, [...item.dependencies]]));
  const extras = new Set<string>();
  for (const edge of p.prerequisites) {
    if (!edge || Object.keys(edge).sort().join(",") !== "item,needs" ||
        !byId.has(edge.item) || !byId.has(edge.needs) || edge.item === edge.needs ||
        byId.get(edge.item)!.status !== "pending" ||
        byId.get(edge.needs)!.status === "blocked" ||
        !input.canonicalEdges.some(actual =>
          actual.item === edge.item && actual.needs === edge.needs) ||
        extras.has(edge.item + ">" + edge.needs))
      throw Error("Pending dependency has no source-grounded typed causal link.");
    extras.add(edge.item + ">" + edge.needs);
    edges.get(edge.item)!.push(edge.needs);
  }
  // No implied approval to replace the owner of a pending assignment. The
  // optional new dependencies must be among the controller's actual scope.
  checkOrder(items.filter(item => item.status === "pending" && !p.prune.includes(item.id)),
    p.order, edges);
  // A pruned assignment remains a satisfied dependency for descendants;
  // it is never a grant to edit the pruned record in another assignment.
  return { beforeVersion: input.version, afterVersion: input.version + 1,
    sourceSha: p.sourceSha, turnDigest: p.turnDigest,
    inventoryDigest: pendingDigest(inventory.items),
    reason: p.reason, order: [...p.order], prune: omit,
    prerequisites: p.prerequisites.map(edge => ({ ...edge })), carried };
}

export function applyPendingAmendment(
  inventory: GenerationInventory, amendment: PendingAmendment,
): GenerationInventory {
  // A later verified HEAD changes the native inventory; a versioned amendment
  // must be explicitly revalidated at that new boundary, never blindly reused.
  if (inventory.headSha !== amendment.sourceSha ||
      pendingDigest(inventory.items) !== amendment.inventoryDigest)
    throw Error("Pending plan amendment no longer matches its verified source inventory.");
  const pruned = new Map(amendment.prune.map(proof => [proof.assignmentId, proof]));
  const edges = amendment.prerequisites;
  return { ...inventory,
    items: inventory.items.map(item => {
      const proof = pruned.get(item.id);
      const dependencies = [...new Set([...item.dependencies,
        ...edges.filter(edge => edge.item === item.id).map(edge => edge.needs)])];
      return { ...item, dependencies, ...(proof ? {
        status: "verified" as const, verifiedSha: amendment.sourceSha,
        omission: { reason: amendment.reason, evidence: proof.evidence,
          reviewerSession: proof.reviewerSession },
      } : {}) };
    }),
    rationale: amendment.reason,
  };
}
