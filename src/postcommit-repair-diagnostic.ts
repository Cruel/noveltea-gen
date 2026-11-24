/** Independent, read-only postcommit reassessment. Diagnostic advice never
 * certifies a source, modifies an accepted negative verdict, or grants edits.
 * Invocation and transcript recovery use the existing response-contract gate.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { PostcommitReviewCycle } from "./postcommit-review-cycle.js";
import type { SemanticReviewPacket, SemanticVerdict } from "./semantic-assignment-review.js";
import { inspectCompletedProtocolResponse } from "./response-contract-recovery.js";
import { repairProgressScope, validateEditorialRepairDiagnosis } from "./editorial-repair-progress.js";
import { execFileSync } from "./git-read-cache.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type PostcommitDiagnosisReason = "reassessment" | "review-depth";
export interface PostcommitDiagnosis {
  schema: "noveltea-postcommit-diagnosis/v1";
  sourceDigest: string;
  action: "continue" | "replace" | "split" | "escalate";
  explanation: string;
  assessments: Array<{
    kind: "material" | "cosmetic" | "deferred" | "scope";
    reason: string;
    requirement: { quote: string };
    evidence: { path: string; quote: string };
  }>;
}

export interface PostcommitDiagnosticAdmission {
  sourceDigest: string;
  reason: PostcommitDiagnosisReason;
  round: number;
  protocolRoot: string;
  contract: "reviewer.postcommit-diagnosis.v1";
}

/** After two corrected negative reviews, request reassessment of whether
 * those revisions were materially productive. Later checks sample review
 * depth, without imposing a ceiling on productive source corrections. */
export function postcommitDiagnosticReason(round: number): PostcommitDiagnosisReason | null {
  return round === 3 ? "reassessment" :
    round >= 5 && (round - 5) % 4 === 0 ? "review-depth" : null;
}

/** Reconstruct progress from the existing immutable reviewer transcript and Git,
 * not a new counter or mutable diagnosis cache. Scope changes start a new
 * cycle; their first correction still compares against the sealed predecessor. */
export async function foundationDiagnosticReason(job: JobStartResult,
  cycle: PostcommitReviewCycle, paths: string[]): Promise<PostcommitDiagnosisReason | null> {
  const { inspectPostcommitReviewCycle } = await import("./postcommit-review-cycle.js");
  const { parseSpecialistJson } = await import("./composition-specialist.js");
  const { normalizeFailedSemanticFindingKinds } = await import("./semantic-assignment-review.js");
  const readRound = async (owner: PostcommitReviewCycle, round: PostcommitReviewCycle["rounds"][number]) => {
    const bytes = (await readFile(owner.reviewer.file)).subarray(0, round.transcriptBytes);
    const records = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    const message = records.filter(r => r.type === "message" && r.message?.role === "assistant" &&
      r.message.stopReason === "stop").at(-1)?.message;
    const raw = message?.content?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text).join("\n");
    if (!raw || createHash("sha256").update(bytes).digest("hex") !== round.transcriptDigest)
      throw Error("Foundation review progress lost its sealed transcript");
    const verdict = normalizeFailedSemanticFindingKinds(parseSpecialistJson(raw)) as SemanticVerdict;
    if (verdict.sourceDigest !== round.packetDigest || digest(verdict) !== round.verdictDigest)
      throw Error("Foundation review progress differs from its sealed verdict");
    return verdict;
  };
  const blob = (sha: string) => digest(paths.map(path => execFileSync("git", [
    "show", sha + ":" + (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path,
  ], { cwd: job.worktreeRoot, encoding: "utf8" })));
  const seen = new Set<string>();
  let previous: { sha: string; verdict: SemanticVerdict } | undefined;
  if (cycle.predecessor) {
    const parent = await inspectPostcommitReviewCycle(job, cycle.rootSha, cycle.predecessor.assignmentDigest);
    const round = parent?.rounds.find(r => r.commitSha === cycle.predecessor!.failedCommitSha);
    if (!parent || parent.id !== cycle.predecessor.cycleId || !round)
      throw Error("Foundation review progress lost its sealed predecessor");
    previous = { sha: round.commitSha, verdict: await readRound(parent, round) };
    seen.add(blob(previous.sha));
  }
  let stalled = 0;
  for (const round of cycle.rounds) {
    const verdict = await readRound(cycle, round);
    const source = blob(round.commitSha);
    if (previous && verdict.verdict === "fail") {
      if (previous.verdict.verdict !== "fail")
        throw Error("Foundation correction has no preceding negative review");
      const priorPaths = [...new Set(previous.verdict.findings.map(f => f.path))];
      if (!priorPaths.every(path => paths.includes(path)))
        throw Error("Foundation convergence left its authorized record");
      const scope = repairProgressScope(job, previous.sha, round.commitSha, priorPaths,
        previous.verdict.findings.map(f => ({ severity: "blocking", source: f.path, message: f.message })));
      const progress = validateEditorialRepairDiagnosis(verdict.progressDiagnosis, scope);
      stalled = progress.status === "material" && !seen.has(source) ? 0 : stalled + 1;
    }
    seen.add(source);
    previous = { sha: round.commitSha, verdict };
  }
  if (previous?.verdict.verdict !== "fail") return null;
  return stalled >= 2 ? "reassessment" : null;
}

export async function postcommitDiagnosticAdmissionForSource(job: JobStartResult,
  cycle: PostcommitReviewCycle, packet: SemanticReviewPacket, verdict: SemanticVerdict) {
  const item = packet.items[0];
  const reason = item?.progressScope && verdict.verdict === "fail"
    ? await foundationDiagnosticReason(job, cycle, item.assurance.changedPaths)
    : undefined;
  return postcommitDiagnosticAdmission(job, cycle, packet, verdict, reason);
}

/** Advisory source-bound admission, never a new review verdict or write grant. */
export function postcommitDiagnosticAdmission(job: JobStartResult,
  cycle: PostcommitReviewCycle, packet: SemanticReviewPacket,
  verdict: SemanticVerdict, sourceReason?: PostcommitDiagnosisReason | null): PostcommitDiagnosticAdmission | null {
  if (verdict.verdict !== "fail" || packet.dispute ||
      packet.items.length !== 1 || !packet.items[0]?.priorNegative ||
      verdict.sourceDigest !== packet.sourceDigest ||
      cycle.rounds.at(-1)?.packetDigest !== packet.sourceDigest ||
      cycle.rounds.at(-1)?.commitSha !== packet.items[0].assurance.commitSha ||
      cycle.rounds.at(-1)?.verdictDigest !== digest(verdict)) return null;
  const round = cycle.rounds.length;
  const reason = sourceReason === undefined ? postcommitDiagnosticReason(round) : sourceReason;
  if (!reason) return null;
  const sourceDigest = digest({
    schema: "noveltea-postcommit-diagnostic-source/v1",
    cycleId: cycle.id, jobId: job.jobId, threadId: job.threadId,
    baseSha: cycle.baseSha, assignmentDigest: cycle.assignmentDigest,
    sourceDigest: packet.sourceDigest, rounds: cycle.rounds, reason,
  });
  return { sourceDigest, reason, round,
    protocolRoot: join(job.stateDir, "postcommit-diagnostics", cycle.id,
      packet.items[0].assurance.commitSha),
    contract: "reviewer.postcommit-diagnosis.v1" };
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function nonempty(value: unknown, max: number, min = 8): value is string {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

/** Require literal anchors in the sealed current packet and the original
 * assignment's obligations. No model classification is treated as authority. */
export function parsePostcommitDiagnosis(raw: string, admission: PostcommitDiagnosticAdmission,
  packet: SemanticReviewPacket): PostcommitDiagnosis {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch { throw Error("Postcommit Diagnostic response is not strict JSON."); }
  if (Buffer.byteLength(raw) > 32_000 ||
      !exact(value, ["schema", "sourceDigest", "action", "explanation", "assessments"]) ||
      value.schema !== "noveltea-postcommit-diagnosis/v1" ||
      value.sourceDigest !== admission.sourceDigest ||
      !["continue", "replace", "split", "escalate"].includes(String(value.action)) ||
      !nonempty(value.explanation, 1400) ||
      !Array.isArray(value.assessments) ||
      value.assessments.length < 1 || value.assessments.length > 8)
    throw Error("Postcommit Diagnostic response is not a bounded independent reassessment.");
  const diagnosis = value as unknown as PostcommitDiagnosis;
  const item = packet.items[0]!;
  const requirements = [item.assignment.outcome, item.unitOutcome];
  for (const assessment of diagnosis.assessments) {
    if (!exact(assessment, ["kind", "reason", "requirement", "evidence"]) ||
        !["material", "cosmetic", "deferred", "scope"].includes(assessment.kind) ||
        !nonempty(assessment.reason, 900) ||
        !exact(assessment.requirement, ["quote"]) ||
        !nonempty(assessment.requirement.quote, 900) ||
        !requirements.some(source => source.includes(assessment.requirement.quote)) ||
        !exact(assessment.evidence, ["path", "quote"]) ||
        typeof assessment.evidence.path !== "string" ||
        !nonempty(assessment.evidence.quote, 900) ||
        !item.canonicalContext.some(source =>
          source.path === assessment.evidence.path &&
          source.content.includes(assessment.evidence.quote)))
      throw Error("Postcommit Diagnostic lacks literal current-source and acceptance-criteria citations.");
  }
  return diagnosis;
}

interface DiagnosticDisposition {
  version: 1;
  cycleId: string;
  commitSha: string;
  round: number;
  sourceDigest: string;
  verdictDigest: string;
  diagnosis: PostcommitDiagnosis;
  diagnosisDigest: string;
}
const dispositionPath = (job: JobStartResult, cycleId: string, sha: string) =>
  join(job.stateDir, "postcommit-diagnostics", cycleId, sha + ".outcome.json");

export async function savePostcommitDiagnosis(job: JobStartResult,
  cycle: PostcommitReviewCycle, packet: SemanticReviewPacket,
  verdict: SemanticVerdict, admission: PostcommitDiagnosticAdmission,
  diagnosis: PostcommitDiagnosis) {
  if ((await postcommitDiagnosticAdmissionForSource(job, cycle, packet, verdict))?.sourceDigest !== admission.sourceDigest ||
      diagnosis.sourceDigest !== admission.sourceDigest)
    throw Error("Diagnostic outcome changed its independently verified source.");
  const commitSha = packet.items[0]!.assurance.commitSha;
  const record: DiagnosticDisposition = {
    version: 1, cycleId: cycle.id, commitSha, round: admission.round,
    sourceDigest: admission.sourceDigest,
    verdictDigest: cycle.rounds.at(-1)!.verdictDigest,
    diagnosis, diagnosisDigest: digest(diagnosis),
  };
  const file = dispositionPath(job, cycle.id, commitSha);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const previous = await readPostcommitDiagnosis(job, cycle, commitSha);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record))
      throw Error("Conflicting immutable postcommit Diagnostic outcome.");
    return;
  }
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

export async function readPostcommitDiagnosis(job: JobStartResult,
  cycle: PostcommitReviewCycle, commitSha: string): Promise<DiagnosticDisposition | null> {
  if (!/^[0-9a-f]{40}$/.test(commitSha) || !/^[0-9a-f]{64}$/.test(cycle.id))
    throw Error("Diagnostic source has no authenticated review cycle.");
  const file = dispositionPath(job, cycle.id, commitSha);
  if (!existsSync(file)) return null;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000)
    throw Error("Unsafe postcommit Diagnostic receipt.");
  const saved = JSON.parse(await readFile(file, "utf8")) as DiagnosticDisposition;
  const round = cycle.rounds.find(r => r.commitSha === commitSha);
  if (!round || saved.version !== 1 || saved.cycleId !== cycle.id ||
      saved.commitSha !== commitSha ||
      saved.round !== cycle.rounds.indexOf(round) + 1 ||
      saved.verdictDigest !== round.verdictDigest ||
      !/^[0-9a-f]{64}$/.test(saved.sourceDigest) ||
      saved.diagnosis?.sourceDigest !== saved.sourceDigest ||
      digest(saved.diagnosis) !== saved.diagnosisDigest ||
      !["continue", "replace", "split", "escalate"].includes(saved.diagnosis.action))
    throw Error("Postcommit Diagnostic outcome is stale or tampered.");
  const accepted = await inspectCompletedProtocolResponse({
    receiptFile: join(job.stateDir, "postcommit-diagnostics", cycle.id, commitSha),
    sourceDigest: saved.sourceDigest, contract: "reviewer.postcommit-diagnosis.v1",
    sessionRoots: [join(job.stateDir, "review-sessions", "assignment-diagnostic")],
    validate: text => {
      try { return digest(JSON.parse(text)) === saved.diagnosisDigest ? [] :
        [{ path: "$.diagnosis", expected: "exact independently accepted diagnosis" }]; }
      catch { return [{ path: "$.diagnosis", expected: "valid accepted JSON" }]; }
    },
    parse: text => JSON.parse(text) as PostcommitDiagnosis,
  });
  if (JSON.stringify(accepted) !== JSON.stringify(saved.diagnosis))
    throw Error("Postcommit Diagnostic recommendation differs from its authenticated Pi transcript.");
  return saved;
}
