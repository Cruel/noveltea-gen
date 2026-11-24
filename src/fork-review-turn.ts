/** Review-only projection of an authenticated original Turn through a verified
 * recovery fork. This NEVER creates a turn-plan.json or grants a writer, author
 * approval or protected-canon permission in the child Thread. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { readRecoveryFork } from "./recovery-fork-state.js";
import { readTurnEvidence, validTurnObjective, type TurnEvidence } from "./turn-plan-evidence.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Rebind only the identity used to attribute a review to the new Job.
 * Original author scope, assignment outcomes and dependencies are unchanged. */
export function projectReviewTurn(original: TurnEvidence, job: JobStartResult): TurnEvidence {
  if (
    original?.version !== 1 ||
    !validTurnObjective(original) ||
    !original.source ||
    !/^[a-f0-9]{40}$/.test(original.source.verifiedSha) ||
    !Array.isArray(original.assignments) ||
    !original.assignments.length
  )
    throw Error("Inherited review Turn is incomplete.");
  const { digest: _old, ...source } = original;
  const body = { ...source, source: { ...source.source, jobId: job.jobId, verifiedSha: job.baseSha } };
  return { ...body, digest: hash(body) };
}

/** Called ONLY by independent checkpoint assurance/reviewer code. No other
 * controller entrypoint treats this read-only evidence as new authority. */
export async function readReviewTurnEvidence(job: JobStartResult): Promise<TurnEvidence | null> {
  const local = join(job.stateDir, "turn-plan.json");
  if (existsSync(local)) {
    const hint = JSON.parse(await readFile(local, "utf8")) as TurnEvidence;
    return readTurnEvidence(job, hint.contract);
  }
  return readInheritedReviewTurn(job);
}

/** Synchronous source-bound review projection for integrity checks that must
 * remain synchronous (notably saved Puzzle no-write/plan continuity). The
 * inherited Turn is read-only evidence of requirements, NEVER a new writer or
 * protected-author grant. */
export function readInheritedReviewTurn(job: JobStartResult): TurnEvidence | null {
  const fork = readRecoveryFork(job);
  if (!fork) return null; // unplanned fixture/legacy CLI job
  const original = fork.reviewTurn;
  if (!original) return null; // historical fork: no current review authority
  if (!validTurnObjective(original))
    throw Error("Inherited review lacks an authenticated current-format Turn objective.");
  const { digest, ...body } = original;
  if (
    digest !== hash(body) ||
    !original.goal?.trim() ||
    !/^[a-f0-9]{40}$/.test(original.source?.verifiedSha ?? "") ||
    !original.assignments?.length ||
    JSON.stringify(original.contract) !== JSON.stringify(fork.contract)
  )
    throw Error("Inherited review Turn differs from the original source.");
  // Verify the original Turn against the exact source checkpoint's assurance
  // as well as the immutable fork pin. For nested forks, the source assurance
  // used a projection bound to its own Job/base, not the original parent's.
  const sourceTurn =
    original.source.verifiedSha === fork.sourceBaseSha
      ? original
      : projectReviewTurn(original, {
          jobId: fork.sourceJobId,
          baseSha: fork.sourceBaseSha,
        } as JobStartResult);
  if (fork.checkpoint.assurance && fork.checkpoint.assurance.turnDigest !== sourceTurn.digest)
    throw Error("Fork source checkpoint review attribution differs from inherited Turn.");
  return projectReviewTurn(original, job);
}
