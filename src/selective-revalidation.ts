/** #194: Source-bound downstream revalidation *planning*, not a second
 * scheduler or a review grant. Uses the existing GenerationInventory DAG plus
 * independently signed checkpoints' explicit read-source inventories.
 *
 * Historical Git commits/reviews stay immutable. The production controller
 * must independently authenticate the successor revision, each reviewer
 * source, and any carrying-forward verdict before applying this projection.
 */
import { createHash } from "node:crypto";
import type { GenerationInventory, ExecutionItem } from "./generation-plan.js";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const PATH = /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Exact persisted GenerationInventory identity, shared by the upstream writer
 * and downstream reviewer to avoid accidental double-serialization. */
export const originalInventorySnapshotDigest = (inventory: GenerationInventory) => digest(inventory);

export interface ReviewedUpstreamCorrection {
  version: 1;
  planVersion: number;
  /** Exact current HEAD before the upstream correction was committed. */
  baseSha: string;
  /** A new native-validated, independently reviewed successor to baseSha. */
  successorSha: string;
  /** Existing immutable checkpoint for an earlier reviewed work item. */
  upstreamItemId: string;
  predecessorCommitSha: string;
  reviewDigest: string;
  /** Stable original Turn; additional successors never reset finding identity. */
  turnDigest: string;
  /** Concrete changed paths, never a model's declaration of generic scope. */
  changedPaths: string[];
  /** Reconstructed original signed writer grant (not a new owner). */
  permittedPaths: string[];
}
export interface ReviewedConsumerEvidence {
  commitSha: string;
  reviewDigest: string;
  status: "passed" | "failed" | "required-pending" | "not-required";
  /** Verified historical commit predates the first corrected upstream output. */
  sourcePrecedesUpstream?: boolean;
  /** Controller-verified source reads from the original work/review receipts. */
  sourcePaths: string[];
}
export interface SelectiveRevalidationPlan {
  version: 1;
  sourceSha: string;
  successorSha: string;
  planVersion: number;
  upstreamItemId: string;
  /** Digest of the original controller inventory, not a new dependency graph. */
  inventoryDigest: string;
  turnDigest: string;
  rootUpstreamCommitSha: string;
  correctionReviewDigest: string;
  changedPaths: string[];
  affected: string[];
  /** Unknown source evidence cannot be mistaken for independence. */
  unknown: string[];
  unaffected: string[];
  digest: string;
}
const itemDigest = (inventory: GenerationInventory) => digest({
  headSha: inventory.headSha, planVersion: inventory.planVersion,
  items: inventory.items,
});
const uniq = (values: readonly string[]) => [...new Set(values)];

function assertSourcePaths(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || !PATH.test(path)) ||
      new Set(paths).size !== paths.length)
    throw Error("Selective revalidation has no safe, deduplicated source-path evidence.");
}
export function assertSelectiveRevalidationPlan(plan: SelectiveRevalidationPlan) {
  if (!plan || plan.version !== 1 || !SHA.test(plan.sourceSha) ||
      !SHA.test(plan.successorSha) || !HASH.test(plan.inventoryDigest) ||
      !HASH.test(plan.correctionReviewDigest) || !HASH.test(plan.turnDigest) ||
      !SHA.test(plan.rootUpstreamCommitSha) ||
      !Number.isSafeInteger(plan.planVersion) || plan.planVersion < 1 ||
      !Array.isArray(plan.affected) || !Array.isArray(plan.unaffected) ||
      !Array.isArray(plan.unknown) || !Array.isArray(plan.changedPaths) ||
      !plan.changedPaths.length || !HASH.test(plan.digest)) {
    throw Error("Revalidation plan has invalid source identity.");
  }
  const { digest: actual, ...body } = plan;
  if (actual !== digest(body)) throw Error("Revalidation plan digest differs from the reviewed source.");
}

export function planSelectiveRevalidation(input: {
  inventory: GenerationInventory;
  correction: ReviewedUpstreamCorrection;
  reviews: Record<string, ReviewedConsumerEvidence | undefined>;
}): SelectiveRevalidationPlan {
  const { inventory, correction, reviews } = input;
  if (correction.version !== 1 || inventory.headSha !== correction.baseSha ||
      !SHA.test(correction.baseSha) || !SHA.test(correction.successorSha) ||
      correction.baseSha === correction.successorSha ||
      !SHA.test(correction.predecessorCommitSha) || !HASH.test(correction.reviewDigest) ||
      !HASH.test(correction.turnDigest))
    throw Error("Upstream correction source HEAD or independently reviewed successor is stale.");
  if (!Number.isSafeInteger(correction.planVersion) || correction.planVersion < 1 ||
      inventory.planVersion !== correction.planVersion)
    throw Error("Upstream correction does not match the original authorized plan version.");
  assertSourcePaths(correction.changedPaths);
  assertSourcePaths(correction.permittedPaths);
  if (!correction.changedPaths.length ||
      correction.changedPaths.some(path => !correction.permittedPaths.includes(path)))
    throw Error("Upstream correction changed an out-of-scope canonical path.");
  if (!Array.isArray(inventory.items) || !inventory.items.length ||
      new Set(inventory.items.map(item => item.id)).size !== inventory.items.length)
    throw Error("Revalidation requires an intact original controller inventory.");
  const original = inventory.items.find(item => item.id === correction.upstreamItemId);
  if (!original || original.status !== "verified" ||
      original.verifiedSha !== correction.predecessorCommitSha)
    throw Error("Upstream correction does not belong to an already-reviewed item.");
  const originalProof = reviews[original.id];
  if (!originalProof || !["passed", "not-required"].includes(originalProof.status) ||
      (originalProof.status === "not-required" && originalProof.sourcePrecedesUpstream !== true) ||
      originalProof.commitSha !== original.verifiedSha ||
      !HASH.test(originalProof.reviewDigest))
    throw Error("Upstream source has no authenticated historical review disposition.");

  const byId = new Map(inventory.items.map(item => [item.id, item]));
  for (const item of inventory.items) {
    if (item.dependencies.some(parent => !byId.has(parent) || parent === item.id))
      throw Error("Revalidation inventory has a missing or self-referential dependency.");
  }
  const changed = new Set(correction.changedPaths);
  const affected = new Set<string>(), unknown = new Set<string>(),
    unaffected = new Set<string>();
  // An already accepted work item is only independently reusable if the
  // controller can prove its exact original source inventory. An absent
  // consumption proof is deliberately classified as UNKNOWN, not unaffected.
  for (const item of inventory.items) {
    if (item.id === original.id) continue;
    if (item.status !== "verified") continue;
    const source = reviews[item.id];
    if (source && ["passed", "not-required"].includes(source.status) &&
        source.commitSha === item.verifiedSha && HASH.test(source.reviewDigest) &&
        source.sourcePrecedesUpstream === true) {
      // An earlier immutable review cannot have consumed the yet-unwritten
      // upstream revision. Its historical success remains valid by design.
      unaffected.add(item.id);
      continue;
    }
    if (!source || source.status !== "passed" ||
        source.commitSha !== item.verifiedSha || !HASH.test(source.reviewDigest) ||
        !Array.isArray(source.sourcePaths) || !source.sourcePaths.length) {
      unknown.add(item.id);
      continue;
    }
    assertSourcePaths(source.sourcePaths);
    if (source.sourcePaths.some(path => changed.has(path)) ||
        item.dependencies.includes(original.id))
      affected.add(item.id);
    else unaffected.add(item.id);
  }
  // Use existing typed causal edges, not an alternative dependency DAG.
  // A descendant of an affected or unknown reviewed unit must be independently
  // rechecked before its old positive verdict can be carried forward.
  for (let n = 0; n < inventory.items.length; n++) {
    let progress = false;
    for (const item of inventory.items) {
      if (item.id === original.id || item.status !== "verified" ||
          affected.has(item.id)) continue;
      if (item.dependencies.some(parent => affected.has(parent) || unknown.has(parent))) {
        unknown.delete(item.id);
        unaffected.delete(item.id);
        affected.add(item.id);
        progress = true;
      }
    }
    if (!progress) break;
  }
  const sorted = (values: Set<string>) => [...values].sort();
  const body = {
    version: 1 as const, sourceSha: correction.baseSha,
    successorSha: correction.successorSha, planVersion: correction.planVersion,
    upstreamItemId: correction.upstreamItemId, inventoryDigest: itemDigest(inventory),
    turnDigest: correction.turnDigest,
    rootUpstreamCommitSha: correction.predecessorCommitSha,
    correctionReviewDigest: correction.reviewDigest,
    changedPaths: [...correction.changedPaths].sort(),
    affected: sorted(affected), unknown: sorted(unknown),
    unaffected: sorted(unaffected),
  };
  return { ...body, digest: digest(body) };
}

/** A read-only view of what must be reconsidered; blocked is not re-authoring
 * authority. A fresh reviewer may carry forward an unchanged unit; no writer
 * is scheduled merely because its historical dependency changed. */
export function applySelectiveRevalidation(
  inventory: GenerationInventory, plan: SelectiveRevalidationPlan,
): GenerationInventory {
  assertSelectiveRevalidationPlan(plan);
  if (plan.sourceSha !== inventory.headSha ||
      plan.planVersion !== inventory.planVersion ||
      plan.inventoryDigest !== itemDigest(inventory))
    throw Error("Selective revalidation cannot apply to a different original source/plan.");
  const impacted = new Set([...plan.affected, ...plan.unknown]);
  const ids = new Set(inventory.items.map(item => item.id));
  if ([...impacted, ...plan.unaffected].some(id => !ids.has(id)) ||
      impacted.has(plan.upstreamItemId) ||
      new Set([...plan.affected, ...plan.unknown, ...plan.unaffected]).size !==
        plan.affected.length + plan.unknown.length + plan.unaffected.length)
    throw Error("Selective revalidation contains duplicated or extraneous work-item identities.");
  return {
    ...inventory, version: inventory.version + 1, headSha: plan.successorSha,
    rationale: "Source-bound upstream correction requires independent downstream revalidation.",
    items: inventory.items.map(item => impacted.has(item.id)
      ? { ...item, status: "blocked" as const,
          blockingReason: "Independent revalidation required after reviewed upstream correction: " +
            plan.upstreamItemId + " at " + plan.successorSha }
      : { ...item }),
  };
}
/** Read-only controller proposal for a narrow post-review owner correction.
 * This is not a Pi write grant: the existing specialist runner must separately
 * authenticate/execute the assignment before any source file may change. */
export interface DependentCorrectionAssignment {
  version: 1;
  kind: "reviewed-dependent-correction";
  sourceSha: string;
  turnDigest: string;
  planVersion: number;
  originalCommitSha: string;
  itemId: string;
  assignmentId: string;
  specialist: string;
  originalReviewDigest: string;
  revalidationReviewDigest: string;
  causalCorrectionSha: string;
  /** ONLY original authoring paths cited in the failed independent verdict. */
  authorizedPaths: string[];
  /** The original specialist's goal, not the later reviewer's invented scope. */
  obligation: string;
  digest: string;
}
export function proposeDependentCorrection(input: {
  plan: SelectiveRevalidationPlan;
  item: ExecutionItem;
  originalCommitSha: string;
  assignmentId: string;
  specialist: string;
  originalReviewDigest: string;
  revalidationReviewDigest: string;
  ownerPaths: string[];
  blockingPaths: string[];
  /** Current verified Story SHA after previously completed dependent corrections. */
  currentHeadSha?: string;
  originalObligation: string;
}): DependentCorrectionAssignment {
  const { plan, item } = input;
  assertSelectiveRevalidationPlan(plan);
  if (![...plan.affected, ...plan.unknown].includes(item.id) ||
      !SHA.test(input.originalCommitSha) || !HASH.test(input.originalReviewDigest) ||
      !HASH.test(input.revalidationReviewDigest) ||
      !input.assignmentId.trim() || !input.specialist.trim() ||
      !input.originalObligation.trim())
    throw Error("Dependent correction has no independently reviewed original owner or finding.");
  assertSourcePaths(input.ownerPaths);
  assertSourcePaths(input.blockingPaths);
  const paths = [...new Set(input.blockingPaths)].sort();
  if (!paths.length || paths.some(path => !input.ownerPaths.includes(path)))
    throw Error("Dependent correction requires an exact in-owner bounded path grant.");
  const sourceSha = input.currentHeadSha ?? plan.successorSha;
  if (!SHA.test(sourceSha)) throw Error("Dependent correction source HEAD is invalid.");
  const body = {
    version: 1 as const, kind: "reviewed-dependent-correction" as const,
    sourceSha, turnDigest: plan.turnDigest,
    planVersion: plan.planVersion, originalCommitSha: input.originalCommitSha,
    itemId: item.id, assignmentId: input.assignmentId,
    specialist: input.specialist, originalReviewDigest: input.originalReviewDigest,
    revalidationReviewDigest: input.revalidationReviewDigest,
    causalCorrectionSha: plan.successorSha, authorizedPaths: paths,
    obligation: input.originalObligation,
  };
  return { ...body, digest: digest(body) };
}
export function assertDependentCorrection(
  proposal: DependentCorrectionAssignment, plan: SelectiveRevalidationPlan,
) {
  assertSelectiveRevalidationPlan(plan);
  if (!proposal || proposal.version !== 1 || proposal.kind !== "reviewed-dependent-correction" ||
      !HASH.test(proposal.digest) ||
      !SHA.test(proposal.originalCommitSha) || !HASH.test(proposal.turnDigest) ||
      !HASH.test(proposal.originalReviewDigest) ||
      !HASH.test(proposal.revalidationReviewDigest) ||
      !SHA.test(proposal.sourceSha) ||
      proposal.causalCorrectionSha !== plan.successorSha ||
      proposal.turnDigest !== plan.turnDigest ||
      proposal.planVersion !== plan.planVersion ||
      ![...plan.affected, ...plan.unknown].includes(proposal.itemId) ||
      !proposal.assignmentId?.trim() || !proposal.specialist?.trim() ||
      !proposal.obligation?.trim())
    throw Error("Dependent correction authority is stale, unreviewed or not the original owner.");
  assertSourcePaths(proposal.authorizedPaths);
  if (!proposal.authorizedPaths.length)
    throw Error("Dependent correction has no bound canonical path.");
  const { digest: actual, ...body } = proposal;
  if (actual !== digest(body))
    throw Error("Dependent correction plan differs from the source-bound original.");
}
export interface RevalidationVerdict {
  itemId: string;
  sourceSha: string;
  status: "passed" | "failed";
  /** Must be checked against a separate immutable independent reviewer receipt. */
  reviewerDigest: string;
  findings?: Array<{ path: string; kind: "missing-requirement" | "continuity" |
    "unrequested-change" | "other"; message: string }>;
}
/** Candidate classifications only. A controller still verifies exact Git
 * ancestry, native validation, reviewer independence, and original owner grant
 * before a carry-forward or Repair finding can become authoritative. */
export function decideSelectiveRevalidation(
  plan: SelectiveRevalidationPlan, inventory: GenerationInventory,
  verdicts: readonly RevalidationVerdict[],
  /** Extra heads independently authenticated as narrow reviewed successors. */
  reviewedSuccessorHeads: readonly string[] = [],
) {
  assertSelectiveRevalidationPlan(plan);
  if (plan.inventoryDigest !== itemDigest(inventory) ||
      plan.planVersion !== inventory.planVersion || plan.sourceSha !== inventory.headSha)
    throw Error("Revalidation verdict is not bound to the original approved inventory.");
  if (reviewedSuccessorHeads.some(sha => !SHA.test(sha)))
    throw Error("Reviewed dependent successor SHA is malformed.");
  const acceptedHeads = new Set([plan.successorSha, ...reviewedSuccessorHeads]);
  const affected = new Set([...plan.affected, ...plan.unknown]);
  const items = new Map(inventory.items.map(item => [item.id, item]));
  const decided = new Set<string>();
  const carriedForward: string[] = [];
  const failures: Array<{ id: string; itemId: string; causedBy: string;
    findings: RevalidationVerdict["findings"] }> = [];
  for (const verdict of verdicts) {
    if (!affected.has(verdict.itemId) || decided.has(verdict.itemId) ||
        !acceptedHeads.has(verdict.sourceSha) || !HASH.test(verdict.reviewerDigest))
      throw Error("Revalidation verdict belongs to an unaffected or stale source.");
    if (!items.has(verdict.itemId) ||
        items.get(verdict.itemId)!.dependencies.some(parent =>
          affected.has(parent) && !carriedForward.includes(parent)))
      throw Error("Dependent review cannot pass before its affected upstream source is independently revalidated.");
    decided.add(verdict.itemId);
    if (verdict.status === "passed" && (!verdict.findings || !verdict.findings.length)) {
      carriedForward.push(verdict.itemId);
    } else if (verdict.status === "failed" &&
        Array.isArray(verdict.findings) && verdict.findings.length &&
        verdict.findings.every(f => PATH.test(f.path) && f.message?.trim())) {
      const ids = uniq(verdict.findings.map(f => f.path + ":" + f.kind)).sort();
      failures.push({ id: digest({ turn: plan.turnDigest,
        original: plan.rootUpstreamCommitSha, itemId: verdict.itemId, ids }),
        itemId: verdict.itemId, causedBy: plan.successorSha, findings: verdict.findings });
    } else {
      throw Error("Revalidation verdict cannot imply an unsupported positive or negative finding.");
    }
  }
  return {
    carriedForward: carriedForward.sort(), failures,
    pending: [...affected].filter(id => !decided.has(id) || failures.some(f => f.itemId === id)).sort(),
  };
}
