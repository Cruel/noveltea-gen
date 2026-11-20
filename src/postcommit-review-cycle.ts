/** Controller-owned identity and transcript-prefix evidence for one postcommit
 * assignment Review cycle. The model's conversation is context, never a seal. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JobStartResult } from "./job.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { SemanticReviewPacket, SemanticVerdict } from "./semantic-assignment-review.js";
import { assertReviewCycleSession, reviewCycleId } from "./review-cycle.js";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface PostcommitReviewCycle {
  version: 1;
  id: string;
  jobId: string;
  threadId: string;
  baseSha: string;
  rootSha: string;
  assignmentDigest: string;
  turnDigest: string;
  snapshot: SkillSnapshot;
  provider: string;
  model: string;
  thinking?: "low" | "high";
  reviewer: { id: string; file: string };
  /** Only a proven bounded response-protocol replacement, before any accepted
   * round, may adopt the fresh session and its separate context group. */
  protocolFresh?: true;
  /** Scope change is a NEW reviewer with an authenticated previously failed
   * cycle. The parent verdict remains sealed under its original assignment. */
  predecessor?: { assignmentDigest: string; cycleId: string; failedCommitSha: string };
  rounds: Array<{
    commitSha: string;
    packetDigest: string;
    verdictDigest: string;
    transcriptBytes: number;
    transcriptDigest: string;
  }>;
}

export function reviewCycleRoot(packet: SemanticReviewPacket): string | null {
  if (packet.dispute || packet.items.length !== 1) return null;
  return packet.items[0]!.priorNegative?.rootFailureSha ?? packet.items[0]!.assurance.commitSha;
}

export function postcommitCycleId(
  job: JobStartResult,
  packet: SemanticReviewPacket,
  snapshot: SkillSnapshot,
  provider: string,
  model: string,
): string | null {
  const rootSha = reviewCycleRoot(packet);
  if (!rootSha) return null;
  const assurance = packet.items[0]!.assurance;
  return reviewCycleId({
    jobId: job.jobId,
    threadId: job.threadId,
    baseSha: job.baseSha,
    executionHead: rootSha,
    planVersion: 1,
    contractDigest: assurance.assignmentDigest,
    snapshotId: snapshot.id,
    provider,
    model,
    taskDigest: assurance.turnDigest,
  });
}

function fileFor(job: JobStartResult, rootSha: string, assignmentDigest: string): string {
  if (!SHA.test(rootSha) || !HASH.test(assignmentDigest))
    throw Error("Invalid postcommit reviewer cycle source.");
  return join(job.stateDir, "review-cycles", rootSha + "-" + assignmentDigest + ".json");
}

function ownedSession(job: JobStartResult, file: string): boolean {
  const dir = resolve(job.stateDir, "review-sessions", "assignment-fidelity");
  const rel = relative(dir, file);
  return !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep);
}

async function transcript(job: JobStartResult, reviewer: { id: string; file: string }): Promise<Buffer> {
  if (
    !ownedSession(job, reviewer.file) ||
    !existsSync(reviewer.file) ||
    (await realpath(reviewer.file)) !== reviewer.file
  )
    throw Error("Postcommit reviewer transcript escaped its independent review directory.");
  const stat = await lstat(reviewer.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
    throw Error("Postcommit reviewer transcript is unsafe.");
  const bytes = await readFile(reviewer.file);
  let header: { type?: string; id?: string };
  try {
    header = JSON.parse(bytes.toString("utf8").split("\n", 1)[0]!);
  } catch {
    throw Error("Postcommit reviewer transcript header is malformed.");
  }
  if (header.type !== "session" || header.id !== reviewer.id)
    throw Error("Postcommit reviewer Pi identity differs from the sealed cycle.");
  return bytes;
}

async function write(job: JobStartResult, cycle: PostcommitReviewCycle): Promise<void> {
  const path = fileFor(job, cycle.rootSha, cycle.assignmentDigest);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(cycle) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

/** Never trust a cycle record without checking its original Thread and EVERY
 * previously accepted transcript prefix; later turns may append to that file. */
export async function inspectPostcommitReviewCycle(
  job: JobStartResult,
  rootSha: string,
  assignmentDigest: string,
): Promise<PostcommitReviewCycle | null> {
  const path = fileFor(job, rootSha, assignmentDigest);
  if (!existsSync(path)) return null;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
    throw Error("Unsafe postcommit Review cycle receipt.");
  const cycle = JSON.parse(await readFile(path, "utf8")) as PostcommitReviewCycle;
  if (
    cycle.version !== 1 ||
    cycle.jobId !== job.jobId ||
    cycle.threadId !== job.threadId ||
    cycle.baseSha !== job.baseSha ||
    cycle.rootSha !== rootSha ||
    cycle.assignmentDigest !== assignmentDigest ||
    !HASH.test(cycle.turnDigest) ||
    !HASH.test(cycle.id) ||
    !cycle.snapshot?.id ||
    !cycle.snapshot.path ||
    !cycle.provider ||
    !cycle.model ||
    !cycle.reviewer?.id ||
    !cycle.reviewer.file ||
    (cycle.protocolFresh !== undefined && cycle.protocolFresh !== true) ||
    (cycle.predecessor !== undefined &&
      (!HASH.test(cycle.predecessor.assignmentDigest) ||
        !HASH.test(cycle.predecessor.cycleId) ||
        !SHA.test(cycle.predecessor.failedCommitSha) ||
        cycle.predecessor.assignmentDigest === assignmentDigest)) ||
    !Array.isArray(cycle.rounds)
  )
    throw Error("Postcommit reviewer cycle identity or provenance is invalid.");
  const expected = reviewCycleId({
    jobId: cycle.jobId,
    threadId: cycle.threadId,
    baseSha: cycle.baseSha,
    executionHead: rootSha,
    planVersion: 1,
    contractDigest: assignmentDigest,
    snapshotId: cycle.snapshot.id,
    provider: cycle.provider,
    model: cycle.model,
    taskDigest: cycle.turnDigest,
  });
  if (cycle.id !== expected) throw Error("Postcommit reviewer cycle scope changed.");
  const bytes = await transcript(job, cycle.reviewer);
  const seen = new Set<string>();
  let previousBytes = 0;
  for (const round of cycle.rounds) {
    if (
      !SHA.test(round.commitSha) ||
      !HASH.test(round.packetDigest) ||
      !HASH.test(round.verdictDigest) ||
      !HASH.test(round.transcriptDigest) ||
      !Number.isSafeInteger(round.transcriptBytes) ||
      round.transcriptBytes <= previousBytes ||
      round.transcriptBytes > bytes.length ||
      seen.has(round.commitSha) ||
      sha256(bytes.subarray(0, round.transcriptBytes)) !== round.transcriptDigest
    )
      throw Error("Postcommit reviewer transcript or immutable round evidence changed.");
    previousBytes = round.transcriptBytes;
    seen.add(round.commitSha);
  }
  return cycle;
}

export async function openPostcommitReviewCycle(
  job: JobStartResult,
  packet: SemanticReviewPacket,
  snapshot: SkillSnapshot,
  provider: string,
  model: string,
  thinking?: "low" | "high",
): Promise<PostcommitReviewCycle | null> {
  const rootSha = reviewCycleRoot(packet);
  if (!rootSha) return null;
  const item = packet.items[0]!;
  const found = await inspectPostcommitReviewCycle(job, rootSha, item.assurance.assignmentDigest);
  if (!found) {
    if (item.priorNegative) {
      // A source-bound author choice may materially revise the *assignment*,
      // not the protected Story or prior verdicts. Begin a new independent
      // reviewer conversation only when the controller's verified amendment
      // and the preceding sealed reviewer cycle both prove that transition.
      const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
      const { inspectRejectedRepair } = await import("./rejected-review-repair.js");
      const source = item.priorNegative.sourceCommitSha;
      const previous = (await inspectRecoveryCheckpoints(job)).find(
        (p) => p.eligible && p.commitSha === source && p.assurance,
      );
      const oldDigest = previous?.assurance?.assignmentDigest;
      if (!oldDigest || oldDigest === item.assurance.assignmentDigest)
        throw Error(
          "Original assignment reviewer cycle is missing; reconcile the sealed source before reviewer handoff.",
        );
      const revised = await inspectRejectedRepair(job, source);
      if (
        !revised.revision ||
        sha256(JSON.stringify(revised.revision.assignment)) !== item.assurance.assignmentDigest ||
        revised.revision.assignment.id !== item.assignment.id ||
        revised.rootFailureSha !== rootSha ||
        item.priorNegative.reviewDigest !== revised.sourceReviewDigest ||
        item.assurance.turnDigest !== previous?.assurance?.turnDigest
      )
        throw Error(
          "Original assignment reviewer cycle is missing; reconcile the sealed source before reviewer handoff.",
        );
      const oldCycle = await inspectPostcommitReviewCycle(job, rootSha, oldDigest);
      if (!oldCycle?.rounds.some((r) => r.commitSha === source))
        throw Error("Material scope amendment has no independently sealed predecessor cycle.");
    }
    return null;
  }
  if (
    item.priorNegative &&
    !found.rounds.some((round) => round.commitSha === rootSha && round.commitSha !== item.assurance.commitSha)
  ) {
    // A revised assignment cannot inherit the original source's review as
    // its own pass/fail. Instead it must preserve and prove its one predecessor
    // cycle, while retaining its new independent reviewer's own rounds.
    const prior = found.predecessor;
    if (!prior) throw Error("Reviewer continuity requires the original sealed negative round.");
    const old = await inspectPostcommitReviewCycle(job, rootSha, prior.assignmentDigest);
    if (
      !old ||
      old.id !== prior.cycleId ||
      !old.rounds.some((round) => round.commitSha === prior.failedCommitSha) ||
      old.reviewer.id === found.reviewer.id ||
      old.reviewer.file === found.reviewer.file ||
      (item.priorNegative.sourceCommitSha !== prior.failedCommitSha &&
        !found.rounds.some((round) => round.commitSha === item.priorNegative!.sourceCommitSha))
    )
      throw Error("Authorized new reviewer cycle lost the sealed predecessor source.");
  }
  if (
    found.turnDigest !== item.assurance.turnDigest ||
    found.snapshot.id !== snapshot.id ||
    found.snapshot.path !== snapshot.path ||
    found.provider !== provider ||
    found.model !== model ||
    found.thinking !== thinking
  )
    throw Error("Reviewer cycle changed assignment, pinned methods or model; start an authorized new cycle.");
  return found;
}

export async function bindPostcommitReviewCycle(
  job: JobStartResult,
  packet: SemanticReviewPacket,
  snapshot: SkillSnapshot,
  provider: string,
  model: string,
  thinking: "low" | "high" | undefined,
  session: { id: string; file: string },
  writer?: { id: string; file: string },
): Promise<PostcommitReviewCycle | null> {
  const rootSha = reviewCycleRoot(packet);
  if (!rootSha) return null;
  const item = packet.items[0]!;
  const prior = await openPostcommitReviewCycle(job, packet, snapshot, provider, model, thinking);
  if (writer) assertReviewCycleSession(writer, session, prior?.reviewer);
  else if (prior && (prior.reviewer.file !== session.file || prior.reviewer.id !== session.id))
    throw Error("Postcommit reviewer cannot switch conversations during the same assignment.");
  if (prior) return prior;
  if (!ownedSession(job, session.file))
    throw Error("Postcommit reviewer is outside the read-only session directory.");
  // Pi may not write the session header until the first prompt. The protocol
  // started marker and subsequent accepted-round check independently fence it.
  if (existsSync(session.file)) await transcript(job, session);
  let predecessor: PostcommitReviewCycle["predecessor"];
  if (item.priorNegative) {
    const { inspectRecoveryCheckpoints } = await import("./recovery-checkpoints.js");
    const oldPoint = (await inspectRecoveryCheckpoints(job)).find(
      (point) => point.eligible && point.commitSha === item.priorNegative!.sourceCommitSha,
    );
    const oldDigest = oldPoint?.assurance?.assignmentDigest;
    if (!oldDigest || oldDigest === item.assurance.assignmentDigest)
      throw Error("New reviewer scope has no controller-verified prior assignment.");
    const oldCycle = await inspectPostcommitReviewCycle(job, rootSha, oldDigest);
    if (
      !oldCycle ||
      !oldCycle.rounds.some((round) => round.commitSha === item.priorNegative!.sourceCommitSha) ||
      oldCycle.reviewer.id === session.id ||
      oldCycle.reviewer.file === session.file
    )
      throw Error("A revised assignment requires a fresh reviewer and sealed predecessor.");
    predecessor = {
      assignmentDigest: oldDigest,
      cycleId: oldCycle.id,
      failedCommitSha: item.priorNegative.sourceCommitSha,
    };
  }
  const cycle: PostcommitReviewCycle = {
    version: 1,
    jobId: job.jobId,
    threadId: job.threadId,
    baseSha: job.baseSha,
    rootSha,
    assignmentDigest: item.assurance.assignmentDigest,
    turnDigest: item.assurance.turnDigest,
    snapshot,
    provider,
    model,
    ...(thinking ? { thinking } : {}),
    id: reviewCycleId({
      jobId: job.jobId,
      threadId: job.threadId,
      baseSha: job.baseSha,
      executionHead: rootSha,
      planVersion: 1,
      contractDigest: item.assurance.assignmentDigest,
      snapshotId: snapshot.id,
      provider,
      model,
      taskDigest: item.assurance.turnDigest,
    }),
    reviewer: session,
    ...(predecessor ? { predecessor } : {}),
    rounds: [],
  };
  await write(job, cycle);
  return cycle;
}

/** The shared protocol guard has exhausted the original malformed response
 * and accepted an independently valid fresh invocation. A replacement AFTER
 * a prior accepted round needs a separate authenticated evidence handoff. */
export async function replacePostcommitProtocolReviewer(
  job: JobStartResult,
  packet: SemanticReviewPacket,
  cycle: PostcommitReviewCycle,
  reviewer: { id: string; file: string },
): Promise<PostcommitReviewCycle> {
  const saved = await inspectPostcommitReviewCycle(job, cycle.rootSha, cycle.assignmentDigest);
  if (!saved || saved.id !== cycle.id || saved.rounds.length)
    throw Error("Existing accepted reviewer history cannot be replaced by protocol fallback.");
  if (
    saved.reviewer.id === reviewer.id ||
    saved.reviewer.file === reviewer.file ||
    !ownedSession(job, reviewer.file) ||
    !reviewer.file.startsWith(
      join(job.stateDir, "review-sessions", "assignment-fidelity", "protocol-fresh") + sep,
    )
  )
    throw Error("Protocol reviewer replacement has an invalid independent Pi identity.");
  if (
    reviewCycleRoot(packet) !== cycle.rootSha ||
    packet.items[0]?.assurance.assignmentDigest !== cycle.assignmentDigest ||
    !HASH.test(packet.sourceDigest)
  )
    throw Error("Protocol fallback is not bound to the original assignment packet.");
  // Never accept a new reviewer merely because its file exists. The common
  // response-contract controller must have exhausted the first response,
  // issued its single source-bound allowance, and accepted the replacement.
  const receiptRoot = join(job.stateDir, "review-protocol", "assignment-" + packet.sourceDigest);
  const parse = async (suffix: string) => {
    const path = receiptRoot + suffix;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
      throw Error("Unsafe fresh reviewer recovery receipt.");
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  };
  const original = await parse(".initial.json");
  const allowance = await parse(".fresh-allowance.json");
  const fresh = await parse(".fresh.json");
  if (
    original.status !== "protocol-exhausted" ||
    original.contract !== "reviewer.assignment-verdict.v1" ||
    original.sourceDigest !== packet.sourceDigest ||
    original.sessionId !== saved.reviewer.id ||
    original.sessionFile !== saved.reviewer.file ||
    allowance.freshAllowanceConsumed !== true ||
    allowance.contract !== original.contract ||
    allowance.sourceDigest !== packet.sourceDigest ||
    allowance.originalSessionId !== saved.reviewer.id ||
    allowance.originalSessionFile !== saved.reviewer.file ||
    allowance.freshSessionId !== reviewer.id ||
    allowance.freshSessionFile !== reviewer.file ||
    fresh.contract !== original.contract ||
    fresh.sourceDigest !== packet.sourceDigest ||
    fresh.status !== "accepted" ||
    fresh.sessionId !== reviewer.id ||
    fresh.sessionFile !== reviewer.file
  )
    throw Error("Fresh reviewer lacks its accepted source-bound protocol recovery.");
  await transcript(job, reviewer);
  saved.reviewer = reviewer;
  saved.protocolFresh = true;
  await write(job, saved);
  return saved;
}

export async function acceptPostcommitReviewRound(
  job: JobStartResult,
  packet: SemanticReviewPacket,
  verdict: SemanticVerdict,
  cycle: PostcommitReviewCycle,
): Promise<void> {
  const item = packet.items[0]!;
  if (
    item.assurance.assignmentDigest !== cycle.assignmentDigest ||
    item.assurance.turnDigest !== cycle.turnDigest ||
    reviewCycleRoot(packet) !== cycle.rootSha
  )
    throw Error("Postcommit reviewer verdict belongs to another assignment cycle.");
  const saved = await inspectPostcommitReviewCycle(job, cycle.rootSha, cycle.assignmentDigest);
  if (!saved || saved.id !== cycle.id) throw Error("Postcommit reviewer cycle disappeared.");
  const digest = sha256(JSON.stringify(verdict));
  const prior = saved.rounds.find((r) => r.commitSha === item.assurance.commitSha);
  if (prior) {
    if (prior.packetDigest !== packet.sourceDigest || prior.verdictDigest !== digest)
      throw Error("Postcommit reviewer round cannot rewrite a prior decision.");
    return;
  }
  const bytes = await transcript(job, saved.reviewer);
  if (saved.rounds.length && bytes.length <= saved.rounds.at(-1)!.transcriptBytes)
    throw Error("New review did not append to the previous reviewer conversation.");
  saved.rounds.push({
    commitSha: item.assurance.commitSha,
    packetDigest: packet.sourceDigest,
    verdictDigest: digest,
    transcriptBytes: bytes.length,
    transcriptDigest: sha256(bytes),
  });
  await write(job, saved);
}
