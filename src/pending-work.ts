import { existsSync } from "node:fs";
import { readFile, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { GenerationRequest } from "./generation.js";
import { isFocusedScope, type CanonicalScopeRecord } from "./focused-scope.js";
import { dependencyGit, sourceDigest } from "./dependency-state.js";
import { readTurnEvidence } from "./turn-plan-evidence.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { executionId } from "./checkpoint-assurance.js";
import { createSkillSnapshot } from "./snapshot.js";
import { loadSkillConfig } from "./skills.js";
import { reviewNarrative, type ReviewAssignment } from "./narrative-review-specialist.js";
import { pendingDigest, authorizePendingAmendment,
  type PendingOmissionProof, type PendingProposal } from "./pending-work-amendments.js";
import { readPendingState, emptyPendingState, pendingSignature,
  omissionContext, applyPendingHistory, assertPendingReviewSettled,
  beginPendingReview, settlePendingReview } from "./pending-work-state.js";
import type { GenerationInventory, ExecutionItem } from "./generation-plan.js";

const canonical = /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/;

async function verifiedSources(job: JobStartResult, report: ValidationResult, head: string) {
  const result = report.report as { records?: CanonicalScopeRecord[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (report.status !== "passed" || !Array.isArray(result?.records) ||
      result.protection?.status !== "checked" || result.protection.base !== head ||
      result.protection.changes?.length || result.protection.warnings?.length)
    throw Error("Pending-work replanning requires full native canonical/protection verification.");
  const hashes: Record<string, string> = {};
  for (const record of result.records) {
    if (!canonical.test(record.path)) throw Error("Invalid native canonical source for replanning.");
    const file = join(job.worktreeStoryRoot, record.path);
    if (await realpath(file) !== file || !(await lstat(file)).isFile())
      throw Error("Unsafe canonical source during pending-work review.");
    hashes[record.path] = sourceDigest(await readFile(file, "utf8"));
  }
  return { records: result.records, hashes };
}

/** Priority is advisory. All actual causal prerequisites come from the trusted
 * inventory's canonical DAG, never from the model's preferred ordering. */
export function pendingTopologicalOrder(inventory: GenerationInventory,
  preferred: readonly string[] = []): string[] {
  const pending = inventory.items.filter(item => item.status === "pending");
  const ids = new Set(pending.map(item => item.id));
  const done = new Set<string>();
  const ordered: string[] = [];
  while (done.size < ids.size) {
    const runnable = pending.filter(item => !done.has(item.id) &&
      item.dependencies.every(id => !ids.has(id) || done.has(id)));
    if (!runnable.length)
      throw Error("Canonical pending work has an unresolved causal cycle; no replan is safe.");
    runnable.sort((a, b) => {
      const priority = (item: ExecutionItem) => {
        const exact = preferred.indexOf(item.id);
        const fallback = preferred.indexOf(item.stage);
        return exact < 0 ? fallback < 0 ? preferred.length : fallback : exact;
      };
      return priority(a) - priority(b) ||
        inventory.items.indexOf(a) - inventory.items.indexOf(b);
    });
    const item = runnable[0]!;
    ordered.push(item.id);
    done.add(item.id);
  }
  return ordered;
}

/** The controller, not the planner, decides which canonical paths can satisfy
 * an assignment. A model-proposed file or target never enters this table. */
function authorityPaths(inventory: GenerationInventory,
  turn: NonNullable<Awaited<ReturnType<typeof readTurnEvidence>>>,
  records: CanonicalScopeRecord[]) {
  const allowed: Record<string, string[]> = {};
  for (const item of inventory.items) {
    const assignment = turn.assignments.find(a => a.id === item.id);
    if (assignment && item.stage === "focus") {
      allowed[item.id] = [...assignment.authority.existingPaths];
    } else if (item.stage !== "focus") {
      // Full-Story stages have no single-record ownership inference here.
      // Those omissions require a separately scoped semantic review design.
      allowed[item.id] = [];
    }
    if (allowed[item.id]?.some(path => !records.some(r => r.path === path)))
      throw Error("Pending writer grant differs from native Story records.");
  }
  return allowed;
}

async function candidateReview(job: JobStartResult, request: GenerationRequest,
  item: ExecutionItem, turn: NonNullable<Awaited<ReturnType<typeof readTurnEvidence>>>,
  records: CanonicalScopeRecord[], hashes: Record<string, string>,
  allowedPaths: string[], head: string): Promise<PendingOmissionProof | null> {
  if (item.stage !== "focus" || allowedPaths.length !== 1 ||
      request.fixture || !isFocusedScope(request.contract))
    return null;
  const assignment = turn.assignments.find(a => a.id === item.id);
  if (!assignment || assignment.authority.mayCreate ||
      request.contract.scope.creates?.some(c => assignment.targets.includes(c.id)))
    return null;
  // A previously started or interrupted specialist retains its original
  // writer lease, even if it left a clean worktree. It cannot be pruned.
  const savedWriter = join(job.stateDir, "focused-items", item.milestone + ".json");
  if (existsSync(savedWriter)) return null;
  const record = records.find(r => r.path === allowedPaths[0] &&
    assignment.targets.includes(r.metadata.id) && r.metadata.status === "approved");
  if (!record || Array.isArray(record.metadata.decisions) && record.metadata.decisions.length)
    return null;

  const adjacent = omissionContext(records, record.path);
  if (!adjacent) return null;
  const context = adjacent.map(r => ({ path: r.path, sha256: hashes[r.path]! }));
  const config = request.skillsSource
    ? { discovery: "explicit-only" as const, novelteaSkills: request.skillsSource,
        skillDirs: [], requiredSkills: ["nt-narrative-review", "nt-catalog"] }
    : await loadSkillConfig(undefined, false);
  const snapshot = await createSkillSnapshot(config);
  if (!snapshot) throw Error("Independent omission reviewer has no pinned review skills.");
  const { inspectPiPolicy } = await import("./job-pi-policy.js");
  const { policy } = await inspectPiPolicy(job);
  let reviewerSession = "";
  const packet: ReviewAssignment = {
    contract: turn.contract, planVersion: 1, scopeIds: assignment.targets,
    paths: [record.path, ...context.map(x => x.path)],
    routes: [], milestoneRoutes: [], puzzleRoutes: [], outstanding: [], uncertainties: [],
    turnGoal: "INDEPENDENT OMISSION GATE: Examine the current actual canonical Story and the " +
      "specific pending assignment outcome below. PASS ONLY if this work is ALREADY fully " +
      "satisfied without any edits, including its causal prerequisites, author obligations, " +
      "and relevant protected decisions. Otherwise BLOCK and leave the original pending " +
      "specialist untouched. A native-valid or complete-status record alone is never enough. " +
      "Original author goal: " + turn.goal,
    specialistAssignments: [assignment],
    omission: { assignmentId: assignment.id, headSha: head },
  };
  const review = await reviewNarrative(job, snapshot, packet,
    request.provider ?? policy.profile.provider, request.model ?? policy.profile.model,
    undefined, async file => { reviewerSession = file; });
  if (review.verdict !== "pass") return null;
  if (!reviewerSession) throw Error("Independent omission review omitted its preserved transcript.");
  if (dependencyGit(job, "rev-parse", "HEAD") !== head)
    throw Error("Story HEAD changed during omission review; no pruning.");
  const lines = (await readFile(join(job.worktreeStoryRoot, record.path), "utf8")).split("\n");
  const evidence = review.evidence.find(witness => {
    const pos = witness.indexOf(record.path + ":");
    const line = pos < 0 ? null : witness.slice(pos + record.path.length + 1).match(/^[1-9][0-9]*/);
    return line && Number(line[0]) <= lines.length;
  });
  if (!evidence) throw Error("Independent omission reviewer has no actual canonical source-line witness.");
  return { assignmentId: item.id, sourceSha: head, path: record.path,
    sourceHash: hashes[record.path]!, context, evidence, reviewerSession,
    reviewerSnapshot: snapshot.id, verdict: "pass" };
}

/** Called only at a clean, verified, writer-locked LangGraph safe boundary.
 * The writer grants and original objective are immutable; only pending work
 * is reordered or independently certified as already fulfilled. */
export async function reconcilePendingWork(job: JobStartResult, request: GenerationRequest,
  inventory: GenerationInventory, prior: GenerationInventory | null | undefined,
  validation?: ValidationResult, allowAmend = true): Promise<{
    inventory: GenerationInventory; order: string[] | null;
    stateVersion: number | null; invalidated: string[];
  }> {
  if (!request.turnPlanDigest || !validation ||
      !inventory.items.some(i => i.stage === "architecture" && i.status === "verified"))
    return { inventory, order: null, stateVersion: null, invalidated: [] };
  const turn = await readTurnEvidence(job, request.contract, request.task, request.turnPlanDigest);
  if (!turn?.objective) return { inventory, order: null, stateVersion: null, invalidated: [] };
  const head = inventory.headSha;
  const oldItems = prior?.items ?? [];
  const newlyTyped = inventory.items.filter(item => item.status === "pending").flatMap(item =>
    item.dependencies.filter(needs => oldItems.some(old => old.id === item.id &&
      !old.dependencies.includes(needs))).map(needs => ({ item: item.id, needs })));
  const recordsHint = (validation.report as { records?: CanonicalScopeRecord[] } | undefined)?.records ?? [];
  const mayPrune = !request.fixture &&
    inventory.items.some(item => item.stage === "focus" && item.status === "pending" &&
      turn.assignments.some(assignment => assignment.id === item.id &&
        assignment.authority.existingPaths.length === 1 &&
        recordsHint.some(record => assignment.authority.existingPaths.includes(record.path) &&
          assignment.targets.includes(record.metadata.id) && record.metadata.status === "approved")));
  // A normal safe boundary need not read/hash the whole Story or even open
  // model/reviewer state. Only genuine new causal evidence or a saved amendment
  // requires the expensive native source/receipt verification.
  if (!mayPrune && !newlyTyped.length &&
      !existsSync(join(job.stateDir, "pending-work.json")))
    return { inventory, order: null, stateVersion: null, invalidated: [] };
  if (validation.status !== "passed") {
    if (existsSync(join(job.stateDir, "pending-work.json")))
      throw Error("Pending plan receipts cannot be reused without valid native Story evidence.");
    return { inventory, order: null, stateVersion: null, invalidated: [] };
  }
  if (dependencyGit(job, "rev-parse", "HEAD") !== head ||
      dependencyGit(job, "status", "--porcelain=v1", "--untracked-files=all"))
    throw Error("Pending work cannot be amended over interrupted or dirty Story writes.");
  const { records, hashes } = await verifiedSources(job, validation, head);
  const state = await readPendingState(job, turn.digest) ?? emptyPendingState(job, turn.digest);
  assertPendingReviewSettled(state);
  const canonicalEdges = inventory.items.flatMap(item => item.dependencies.map(needs =>
    ({ item: item.id, needs })));
  const applied = await applyPendingHistory(job, state, inventory, hashes, canonicalEdges, records);
  let current = applied.inventory;
  let order = applied.order;
  const original = prior?.items ?? [];
  const newEdges = current.items.filter(item => item.status === "pending").flatMap(item =>
    item.dependencies.filter(needs => original.some(old => old.id === item.id &&
      !old.dependencies.includes(needs))).map(needs => ({ item: item.id, needs })));
  const authorizedPaths = authorityPaths(current, turn, records);
  const protectedPaths = records.filter(record => Array.isArray(record.metadata.decisions) &&
    record.metadata.decisions.length > 0).map(record => record.path);
  const checkpoints = await inspectRecoveryCheckpoints(job);
  const reviewed = current.items.filter(item => item.status === "verified").flatMap(item => {
    const original = checkpoints.find(point => point.eligible && executionId(point.workItem) === item.id &&
      point.commitSha === item.verifiedSha &&
      (point.semanticReview === "passed" || point.semanticReview === "not-required"));
    const priorOmission = state.entries.some(entry => entry.prune.some(p =>
      p.assignmentId === item.id && hashes[p.path] === p.sourceHash));
    return original || priorOmission || item.stage === "foundation"
      ? [{ id: item.id, sha: item.verifiedSha! }] : [];
  });
  // A previously verified or pruned result is never silently assigned another writer.
  const candidate = current.items.find(item => item.status === "pending" &&
    item.stage === "focus" && authorizedPaths[item.id]?.length === 1 &&
    !protectedPaths.includes(authorizedPaths[item.id]![0]!) &&
    records.some(r => authorizedPaths[item.id]?.includes(r.path) && r.metadata.status === "approved"));
  const signature = candidate ? pendingSignature(head, candidate.id, current) : null;
  if (allowAmend && candidate && signature && state.entries.length < 4 &&
      !state.attempts.some(a => a.signature === signature)) {
    const started = await beginPendingReview(job, state, signature, head);
    if (started) {
      const proof = await candidateReview(job, request, candidate, turn, records,
        hashes, authorizedPaths[candidate.id]!, head);
      const prune = proof ? [candidate.id] : [];
      const proposal: PendingProposal = { sourceSha: head, turnDigest: turn.digest,
        beforeVersion: state.version,
        order: pendingTopologicalOrder({ ...current, items: current.items.filter(i =>
          !prune.includes(i.id)) }), prune, prerequisites: newEdges,
        reason: proof ? "Independent source-bound reviewer confirmed the pending assignment is already satisfied." :
          "Pending scope remains necessary after independent review." };
      if (proof || newEdges.length) {
        const amendment = authorizePendingAmendment({ proposal, inventory: current,
          turnDigest: turn.digest, version: state.version, omissionProofs: proof ? [proof] : [],
          sourceHashes: hashes, authorizedPaths, protectedPaths, canonicalEdges, reviewed });
        await settlePendingReview(job, state, signature, "unchanged", amendment);
        current = (await applyPendingHistory(job, state, inventory, hashes, canonicalEdges,
          records)).inventory;
        order = proposal.order;
      } else await settlePendingReview(job, state, signature, "rejected");
    }
  } else if (allowAmend && newEdges.length && state.entries.length < 4) {
    const signature = pendingDigest({ head, newEdges, version: state.version });
    if (!state.attempts.some(a => a.signature === signature)) {
      await beginPendingReview(job, state, signature, head);
      const proposal: PendingProposal = { sourceSha: head, turnDigest: turn.digest,
        beforeVersion: state.version, order: pendingTopologicalOrder(current),
        prune: [], prerequisites: newEdges,
        reason: "Native-validated canonical prerequisites reordered only remaining specialist work." };
      const amendment = authorizePendingAmendment({ proposal, inventory: current,
        turnDigest: turn.digest, version: state.version, omissionProofs: [], sourceHashes: hashes,
        authorizedPaths, protectedPaths, canonicalEdges, reviewed });
      await settlePendingReview(job, state, signature, "unchanged", amendment);
      order = proposal.order;
    }
  }
  return { inventory: current, order, stateVersion: state.version,
    invalidated: applied.invalidated };
}
