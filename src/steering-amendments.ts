import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { GenerationInventory } from "./generation-plan.js";
import type { TurnEvidence } from "./turn-plan-evidence.js";
import type { SteeringInput, SteeringBoundaryDecision } from "./steering-boundary.js";
import { dependencyGit } from "./dependency-state.js";
import { steeringGroundedTargets } from "./steering-intent.js";
import type { CanonicalScopeRecord } from "./focused-scope.js";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface SteeringAmendment {
  messageId: string;
  authorThreadId: string;
  sourceSha: string;
  submittedHead: string | null;
  version: number;
  previousDigest: string | null;
  turnDigest: string;
  originalObjective: string;
  reason: string;
  direction: string;
  affectedAssignments: string[];
  /** Immutable snapshot of independently verified, unaffected work. */
  carried: Array<{ id: string; sha: string }>;
  digest: string;
}
export interface SteeringPlan {
  schema: "noveltea-steering-plan/v1";
  jobId: string;
  threadId: string;
  authorThreadId: string;
  turnDigest: string;
  originalObjective: string;
  entries: SteeringAmendment[];
}

const planPath = (job: JobStartResult) => join(job.stateDir, "steering-plan.json");

export async function readSteeringPlan(job: JobStartResult, turnDigest?: string): Promise<SteeringPlan | null> {
  if (!existsSync(planPath(job))) return null;
  const raw = JSON.parse(await readFile(planPath(job), "utf8")) as SteeringPlan;
  if (raw.schema !== "noveltea-steering-plan/v1" || raw.jobId !== job.jobId ||
      raw.threadId !== job.threadId || !raw.authorThreadId || !DIGEST.test(raw.turnDigest) ||
      (turnDigest && turnDigest !== raw.turnDigest) || !raw.originalObjective?.trim() ||
      !Array.isArray(raw.entries) || raw.entries.length > 64)
    throw Error("Steering amendment ledger is missing its trusted job/Turn identity.");
  let previous: string | null = null;
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries.entries()) {
    const { digest, ...body } = entry;
    if (!DIGEST.test(digest) || digest !== hash(body) ||
        entry.previousDigest !== previous || entry.version !== index + 1 ||
        entry.turnDigest !== raw.turnDigest || entry.originalObjective !== raw.originalObjective ||
        entry.authorThreadId !== raw.authorThreadId ||
        !entry.messageId || seen.has(entry.messageId) || !SHA.test(entry.sourceSha) ||
        entry.submittedHead !== null && !SHA.test(entry.submittedHead) ||
        !entry.direction?.trim() || entry.direction.length > 4000 ||
        !entry.reason?.trim() || !Array.isArray(entry.affectedAssignments) ||
        !entry.affectedAssignments.length || entry.affectedAssignments.length > 128 ||
        new Set(entry.affectedAssignments).size !== entry.affectedAssignments.length ||
        !Array.isArray(entry.carried) || entry.carried.some(c => !c.id || !SHA.test(c.sha)))
      throw Error("Steering amendment history is corrupt, duplicated or outside its plan.");
    previous = digest;
    seen.add(entry.messageId);
  }
  return raw;
}

function sourceIsAncestor(job: JobStartResult, older: string, current: string): boolean {
  if (!SHA.test(older) || !SHA.test(current)) return false;
  if (older === current) return true;
  try {
    return dependencyGit(job, "merge-base", "--is-ancestor", older, current) === "";
  } catch { return false; }
}

/** Pure scope authorization. The original goal, writer grants and completion
 * depth remain immutable. A model/steering message cannot create a new owner. */
export function proposeSteeringAmendment(input: {
  steering: SteeringInput;
  jobId: string; threadId: string; headSha: string;
  inventory: GenerationInventory; turn: TurnEvidence;
  catalog: CanonicalScopeRecord[]; changedSinceSubmission: string[];
  prior: SteeringPlan | null;
}): { amendment: SteeringAmendment | null; decision: SteeringBoundaryDecision } {
  const { steering: m, headSha: head, turn, inventory, prior } = input;
  const reject = (reason: string): { amendment: null; decision: SteeringBoundaryDecision } =>
    ({ amendment: null, decision: { messageId: m.messageId, content: m.content, kind: "review-required",
      sourceSha: head, amendmentDigest: null, reason } });
  if (m.jobId !== input.jobId || m.threadId !== input.threadId ||
      !SHA.test(head) || inventory.headSha !== head || !DIGEST.test(turn.digest) ||
      !turn.objective || !m.content?.trim() || m.content.length > 4000 ||
      !["pending", "deferred", "delivered"].includes(m.state))
    return reject("Steering source or original Turn authority is not valid at this boundary.");
  if (prior && (prior.jobId !== input.jobId || prior.authorThreadId !== input.threadId ||
      prior.turnDigest !== turn.digest || prior.originalObjective !== turn.goal))
    return reject("Steering amendments differ from the original author objective.");
  const replay = prior?.entries.find(e => e.messageId === m.messageId);
  if (replay) {
    if (replay.direction !== m.content.trim() || replay.submittedHead !== m.submittedHead)
      return reject("A prior steering message cannot be replayed with different author content or source.");
    return { amendment: null, decision: { messageId: m.messageId, content: m.content, kind: "applied",
      sourceSha: replay.sourceSha, amendmentDigest: replay.digest,
      reason: "Existing exact steering amendment replayed without duplicate work." } };
  }
  if (m.submittedHead === null)
    return reject("No source HEAD was pinned when the instruction was sent; explicit review is required.");
  if (m.disposition === "protected-review" ||
      /\b(?:protected\s+(?:creative\s+)?decision|creative[- ]direction|retcon|override\s+canon)\b/i.test(m.content))
    return reject("Protected canon requires the existing exact trusted approval, not a steer or generic Author Choice.");
  if (/\b(?:cancel|stop\s+(?:the\s+)?job|abort\s+(?:the\s+)?run)\b/i.test(m.content))
    return reject("Cancellation is a separate authenticated execution control.");
  const pending = inventory.items.filter(item => item.status === "pending" &&
    ["focus", "foundations", "event", "interactive", "composition"].includes(item.stage));
  if (!pending.length) return reject("No remaining writable assignment can implement this direction; author review is required.");
  const targets = steeringGroundedTargets(m.content, input.catalog);
  if (!targets.length)
    return reject('No unambiguous canonical target is grounded in the validated Story catalog; explicit scope review is required.');
  const direct = pending.filter(item => targets.some(t => item.targetIds.includes(t)));
  if (targets.length && targets.some(t => !input.catalog.some(record => record.metadata.id === t) &&
      !turn.contract.scope.creates?.some(create => create.id === t)))
    return reject("Unknown canonical record in author steer; no speculative ID or writer can be authorized.");
  if (targets.length && targets.some(t => !direct.some(item => item.targetIds.includes(t))))
    return reject("A steering target lies outside remaining controller-authorized specialists.");
  const affected = direct;
  // A source change to an assigned existing record since instruction submission
  // needs a new source-bound scope review, never an automatic stale overwrite.
  const allowedPaths = new Set(affected.flatMap(item => turn.assignments
    .filter(a => a.id === item.id).flatMap(a => a.authority.existingPaths)));
  if (input.changedSinceSubmission.some(path => allowedPaths.has(path)))
    return reject("Steering target changed since the instruction was sent; reconcile its current source first.");
  if (affected.some(item => item.status !== "pending" ||
      !["focus", "foundations", "event", "interactive", "composition"].includes(item.stage)))
    return reject("Steering cannot rewrite an active or verified assignment.");
  if (affected.some(item => item.stage === "focus" &&
      !turn.assignments.some(a => a.id === item.id && a.authority.existingPaths.every(path =>
        input.catalog.some(record => record.path === path)))))
    return reject("Focused steering cannot expand the original record write grant.");
  if (affected.some(item => item.targetIds.some(id => input.catalog.some(record =>
    record.metadata.id === id && Array.isArray(record.metadata.decisions) &&
    record.metadata.decisions.length > 0))))
    return reject("A protected target requires exact author approval.");
  if ((prior?.entries.length ?? 0) >= 64)
    return reject('This Turn has reached its bounded steering-amendment limit; request an explicit reviewed continuation.');
  const previousDigest = prior?.entries.at(-1)?.digest ?? null;
  const body = {
    messageId: m.messageId, authorThreadId: m.threadId, sourceSha: head, submittedHead: m.submittedHead,
    version: (prior?.entries.length ?? 0) + 1, previousDigest, turnDigest: turn.digest,
    originalObjective: turn.goal,
    reason: "Authenticated author direction retargets only pending controller-owned assignments at a verified Story boundary.",
    direction: m.content.trim(), affectedAssignments: affected.map(a => a.id),
    carried: inventory.items.filter(item => item.status === "verified" && item.verifiedSha)
      .map(item => ({ id: item.id, sha: item.verifiedSha! })),
  };
  const amendment = { ...body, digest: hash(body) };
  return { amendment, decision: { messageId: m.messageId, content: m.content, kind: "applied",
    sourceSha: head, amendmentDigest: amendment.digest, reason: body.reason } };
}

/** Persist before announcing application in Chat or dispatching another writer.
 * A crashed DB acknowledgement can be replayed using the exact same receipt. */
export async function saveSteeringAmendment(job: JobStartResult, turn: TurnEvidence,
  amendment: SteeringAmendment): Promise<void> {
  const prior = await readSteeringPlan(job, turn.digest);
  if (prior?.entries.some(e => e.messageId === amendment.messageId)) {
    if (prior.entries.find(e => e.messageId === amendment.messageId)?.digest !== amendment.digest)
      throw Error("Steering message was already amended against a different Story source.");
    return;
  }
  if (amendment.version > 64 || amendment.version !== (prior?.entries.length ?? 0) + 1 ||
      amendment.previousDigest !== (prior?.entries.at(-1)?.digest ?? null) ||
      amendment.turnDigest !== turn.digest || amendment.originalObjective !== turn.goal ||
      prior && prior.authorThreadId !== amendment.authorThreadId)
    throw Error("Concurrent or stale steering amendment cannot replace the original plan.");
  const plan: SteeringPlan = prior ?? {
    schema: "noveltea-steering-plan/v1", jobId: job.jobId, threadId: job.threadId,
    authorThreadId: amendment.authorThreadId,
    turnDigest: turn.digest, originalObjective: turn.goal, entries: [],
  };
  const output = { ...plan, entries: [...plan.entries, amendment] };
  const temp = planPath(job) + "." + randomUUID() + ".tmp";
  await mkdir(job.stateDir, { recursive: true });
  await writeFile(temp, JSON.stringify(output, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, planPath(job));
}

export async function steeringForAssignment(job: JobStartResult, turnDigest: string | undefined,
  assignmentId: string, head: string): Promise<string> {
  if (!turnDigest) return "";
  const plan = await readSteeringPlan(job, turnDigest);
  if (!plan) return "";
  const applicable = plan.entries.filter(entry => entry.affectedAssignments.includes(assignmentId));
  for (const entry of applicable) {
    if (!sourceIsAncestor(job, entry.sourceSha, head))
      throw Error("Steering plan source is no longer in this Thread's verified Git ancestry.");
  }
  return applicable.map(entry => "Authenticated author steering (" + entry.messageId + ", source " +
    entry.sourceSha + "): " + entry.direction +
    "\nThis is not a new write grant. Preserve the original Turn objective, existing assignment targets, " +
    "independent reviewer gates, validated Story canon and completion depth. If this direction " +
    "needs new scope or protected changes, stop and report the need for trusted author approval.")
    .join("\n");
}

export function steeringSourceIsAncestor(job: JobStartResult, source: string, head: string) {
  return sourceIsAncestor(job, source, head);
}
