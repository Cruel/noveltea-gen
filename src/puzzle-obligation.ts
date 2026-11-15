/** Controller-owned decision for optional Puzzle work. The author's source-bound
 * Turn is authoritative; a specialist's no-write assertion is only evidence. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Plan } from "./architecture.js";
import type { JobStartResult } from "./job.js";
import { readTurnEvidence, validTurnObjective, type TurnEvidence } from "./turn-plan-evidence.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9-]*$/;

/** A bare "mystery" or "fair-play clues" is a delivery obligation, NOT a
 * request to construct a formal Puzzle with two solution Events. An explicit
 * puzzle mechanism or player-solving goal is different. */
export function explicitlyRequiresPuzzle(statement: string): boolean {
  // A specialist saying that its *stage* is deferred is not an approved
  // requirement. Neither is a choice of methods ("Choice or Puzzle") or a
  // prohibition ("no puzzles"). An unresolved mandatory goal is different.
  const text = statement.trim();
  const formal =
    /\b(puzzles?|riddles?|ciphers?|cryptograms?|code[ -]breaking|logic challenges?|escape[ -]room challenges?)\b/i;
  const deferred =
    /\b(?:deferred|optional|if appropriate|where appropriate|if relevant|as needed|not required)\b/i;
  const prohibited =
    /\b(?:no|without|avoid|exclude|do not|don't|never)\s+(?:(?:require|add|create|author|include)\s+)?(?:(?:a|any)\s+)?(?:formal\s+)?(?:puzzles?|riddles?|ciphers?|cryptograms?)\b/i;
  if (prohibited.test(text)) return false;
  if (formal.test(text)) {
    if (/\b(?:must|require[ds]?|mandatory|necessary|essential|player (?:will|has to|needs to))\b/i.test(text))
      return true;
    if (deferred.test(text) || /\b(?:choice|choices)\s*(?:\/|or)\s*puzzles?\b/i.test(text)) return false;
    // An explicit author-requested formal Puzzle ("a puzzle mystery") is a
    // requirement even when the author did not use the word "must".
    return true;
  }
  return (
    /\b(?:player|protagonist|reader)\b.{0,60}\b(?:must|needs? to|has to|will)\s+(?:actually\s+)?(?:solve|deduce|identify|unmask|figure out|work out)\b.{0,90}\b(?:mystery|case|crime|culprit|murderer|killer|perpetrator)\b/i.test(
      text,
    ) ||
    /\b(?:must|needs? to|has to|will)\s+(?:be\s+)?(?:solv(?:e|ed)|deduc(?:e|ed)|identif(?:y|ied)|unmask(?:ed)?)\b.{0,90}\b(?:mystery|case|crime|culprit|murderer|killer|perpetrator)\b/i.test(
      text,
    ) ||
    /\b(?:mystery|case|crime|culprit|murderer|killer|perpetrator)\b.{0,90}\b(?:must be solved|to solve|to identify|to deduce|to unmask)\b/i.test(
      text,
    )
  );
}

export interface PuzzleObligation {
  required: boolean;
  turnDigest: string | null;
  reasons: string[];
}
interface StoryRecord {
  path: string;
  metadata: { type: string; status: string; id: string; solutions?: string[] };
}

/** Fail closed for legacy jobs that have no source-bound objective. Existing
 * formally authored Puzzles always remain subject to the strict solution gate. */
export async function puzzleObligation(
  job: JobStartResult,
  plan: Plan,
  records: StoryRecord[],
  relatedEventIds: string[],
  sourceObligations: string[] = [],
): Promise<PuzzleObligation> {
  const reasons: string[] = [];
  let turn: TurnEvidence | null = null;
  if (existsSync(join(job.stateDir, "turn-plan.json"))) {
    const saved = JSON.parse(await readFile(join(job.stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
    turn = await readTurnEvidence(job, saved.contract);
  }
  if (!turn?.objective) reasons.push("No authenticated original Turn objective (legacy/unknown obligation).");
  else {
    const source = [
      turn.originalRequest,
      turn.goal,
      ...turn.objective.obligations,
      ...turn.contract.constraints,
    ];
    if (turn.objective.requestedTargets.some((id) => id.startsWith("puzzle.")))
      reasons.push("Original source-bound target explicitly requires a Puzzle.");
    if (source.some(explicitlyRequiresPuzzle))
      reasons.push("Original source-bound Turn requires a Puzzle or player-solved mystery.");
  }
  if (
    plan.contract.scope.targets.some((id) => id.startsWith("puzzle.")) ||
    (plan.contract.scope.supportingTargets ?? []).some((id) => id.startsWith("puzzle.")) ||
    plan.contract.constraints.some(explicitlyRequiresPuzzle) ||
    sourceObligations.some(explicitlyRequiresPuzzle)
  ) {
    reasons.push("Controller-approved scope or verified Event obligations require Puzzle work.");
  }
  if (
    records.some(
      (record) =>
        record.metadata.status !== "superseded" &&
        record.metadata.type === "puzzle" &&
        (plan.contract.scope.targets.includes(record.metadata.id) ||
          record.metadata.solutions?.some((id) => relatedEventIds.includes(id))),
    )
  ) {
    reasons.push("A related canonical Puzzle already has a solvability obligation.");
  }
  return { required: reasons.length > 0, turnDigest: turn?.digest ?? null, reasons };
}

export interface PuzzleNoWritePayload {
  version: 1;
  decision: "not-applicable";
  jobId: string;
  threadId: string;
  branch: string;
  baseSha: string;
  milestoneId: string;
  unitId: string;
  eventHead: string;
  choiceHead: string;
  verifiedHead: string;
  planVersion: number;
  planDigest: string;
  turnDigest: string;
  snapshotId: string;
  worker: "pi" | "fixture";
  provider: string;
  model: string;
  piSessionFile: string | null;
  piSessionSha256: string | null;
  /** Actual specialist JSON; no omitted/normalized negative findings. */
  report: { modifiedRecords: []; architecturalConflicts: string[]; laterObligations: string[] };
  skillReads: string[];
}
export interface PuzzleNoWriteRef {
  nonce: string;
  digest: string;
}
interface PuzzleNoWriteSeal {
  nonce: string;
  digest: string;
  payload: PuzzleNoWritePayload;
}
function proofFile(job: JobStartResult, milestone: string) {
  if (!MILESTONE.test(milestone)) throw new Error("Invalid Puzzle no-write Milestone.");
  return join(job.stateDir, "interactive-no-write", milestone.slice(10) + ".json");
}
function validPayload(payload: PuzzleNoWritePayload): boolean {
  return (
    payload?.version === 1 &&
    payload.decision === "not-applicable" &&
    SHA.test(payload.baseSha) &&
    SHA.test(payload.eventHead) &&
    SHA.test(payload.choiceHead) &&
    SHA.test(payload.verifiedHead) &&
    DIGEST.test(payload.planDigest) &&
    DIGEST.test(payload.turnDigest) &&
    DIGEST.test(payload.snapshotId) &&
    Number.isSafeInteger(payload.planVersion) &&
    payload.planVersion > 0 &&
    !!payload.unitId &&
    (payload.worker === "pi" || payload.worker === "fixture") &&
    Array.isArray(payload.report?.modifiedRecords) &&
    payload.report.modifiedRecords.length === 0 &&
    Array.isArray(payload.report?.architecturalConflicts) &&
    payload.report.architecturalConflicts.length > 0 &&
    payload.report.architecturalConflicts.every((x) => typeof x === "string" && !!x.trim()) &&
    Array.isArray(payload.report?.laterObligations) &&
    payload.report.laterObligations.every((x) => typeof x === "string") &&
    Array.isArray(payload.skillReads) &&
    payload.skillReads.every((x) => typeof x === "string") &&
    (payload.worker === "fixture"
      ? payload.piSessionFile === null && payload.piSessionSha256 === null
      : !!payload.piSessionFile && DIGEST.test(payload.piSessionSha256 ?? ""))
  );
}
/** A no-write Pi witness is a finished original-session transcript, not merely
 * a filename supplied by the model. Never follow symlinks or read arbitrary
 * paths when a controller receipt is restored or transferred. */
export function puzzleNoWriteSessionDigest(job: JobStartResult, unitId: string, sessionFile: string): string {
  const slug = /^interactive-puzzle-([a-z][a-z0-9-]*)$/.exec(unitId)?.[1];
  if (!slug) throw new Error("Invalid Puzzle specialist session owner.");
  const directory = join(job.stateDir, "interactive-sessions", "interactive-" + slug, "puzzle") + sep;
  if (
    !sessionFile.startsWith(directory) ||
    resolve(sessionFile) !== sessionFile ||
    realpathSync(sessionFile) !== sessionFile ||
    !sessionFile.endsWith(".jsonl")
  )
    throw new Error("Optional Puzzle transcript is outside its original source-bound session.");
  const stat = lstatSync(sessionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024 * 1024)
    throw new Error("Optional Puzzle transcript is not a bounded regular file.");
  return createHash("sha256").update(readFileSync(sessionFile)).digest("hex");
}
/** The private controller writes this once, outside the agent's /story sandbox.
 * The nonce and complete-source digest are checked again on every replay. */
export async function sealPuzzleNoWrite(
  job: JobStartResult,
  payload: PuzzleNoWritePayload,
): Promise<PuzzleNoWriteRef> {
  if (
    !validPayload(payload) ||
    payload.jobId !== job.jobId ||
    payload.threadId !== job.threadId ||
    payload.branch !== job.branch ||
    payload.baseSha !== job.baseSha
  )
    throw new Error("Unbound/invalid optional Puzzle no-write evidence.");
  const nonce = randomUUID(),
    signature = hash(payload);
  const path = proofFile(job, payload.milestoneId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ nonce, digest: signature, payload }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return { nonce, digest: signature };
}
function assertSeal(
  job: JobStartResult,
  milestone: string,
  ref: PuzzleNoWriteRef | undefined,
  sealed: PuzzleNoWriteSeal,
): PuzzleNoWritePayload {
  if (
    !ref ||
    !DIGEST.test(ref.digest) ||
    !/^[a-f0-9-]{36}$/.test(ref.nonce) ||
    sealed.nonce !== ref.nonce ||
    sealed.digest !== ref.digest ||
    hash(sealed.payload) !== ref.digest ||
    !validPayload(sealed.payload) ||
    sealed.payload.jobId !== job.jobId ||
    sealed.payload.threadId !== job.threadId ||
    sealed.payload.baseSha !== job.baseSha ||
    sealed.payload.branch !== job.branch ||
    sealed.payload.milestoneId !== milestone
  )
    throw new Error("Optional Puzzle no-write receipt source/owner/digest changed.");
  if (
    sealed.payload.worker === "pi" &&
    puzzleNoWriteSessionDigest(job, sealed.payload.unitId, sealed.payload.piSessionFile!) !==
      sealed.payload.piSessionSha256
  )
    throw new Error("Optional Puzzle transcript changed after its exact controller no-write seal.");
  // The original approved Turn is a separate controller authority. A valid
  // replacement Turn must not inherit a Puzzle omission from the prior one.
  const saved = JSON.parse(readFileSync(join(job.stateDir, "turn-plan.json"), "utf8")) as TurnEvidence;
  const { digest, ...body } = saved;
  if (
    digest !== sealed.payload.turnDigest ||
    digest !== hash(body) ||
    (saved.source?.jobId !== null && saved.source?.jobId !== job.jobId) ||
    saved.source.verifiedSha !== job.baseSha ||
    !validTurnObjective(saved)
  )
    throw new Error("Optional Puzzle no-write source Turn changed or lost its approval digest.");
  return sealed.payload;
}
export async function readPuzzleNoWrite(
  job: JobStartResult,
  milestone: string,
  ref: PuzzleNoWriteRef | undefined,
): Promise<PuzzleNoWritePayload> {
  const path = proofFile(job, milestone);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw new Error("Optional Puzzle controller receipt is not a bounded regular file.");
  return assertSeal(job, milestone, ref, JSON.parse(await readFile(path, "utf8")) as PuzzleNoWriteSeal);
}
/** Historical carry-forward proof is verified synchronously by the existing
 * signed plan-continuity admission path. */
export function readPuzzleNoWriteSync(
  job: JobStartResult,
  milestone: string,
  ref: PuzzleNoWriteRef | undefined,
): PuzzleNoWritePayload {
  const path = proofFile(job, milestone);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
    throw new Error("Optional Puzzle controller receipt is not a bounded regular file.");
  return assertSeal(job, milestone, ref, JSON.parse(readFileSync(path, "utf8")) as PuzzleNoWriteSeal);
}
