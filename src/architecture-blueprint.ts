/** Private, source-bound causal Architecture planning. This is not canonical Story
 * content, a user approval or a portable completed-Git recovery checkpoint. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext, PiBudgetPause } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { assertReviewCycleSession, reviewCycleId } from "./review-cycle.js";
import { evaluateReviewConvergence, type ConvergentReview, type ReviewRound } from "./review-convergence.js";
import { diagnosticCaseFingerprint, diagnosticEvidence, diagnosticTrigger, parseBlueprintDiagnosis,
  type BlueprintDiagnosis, type DiagnosticTrigger } from "./blueprint-diagnostic.js";
import { buildBlueprintObligations, validateBlueprintObligations,
  type BlueprintObligations, type ObligationSources } from "./architecture-blueprint-obligations.js";
import { parseBlueprintPatch, applyBlueprintPatch,
  allowedBlueprintPatchTargets } from "./architecture-blueprint-patch.js";
import { parseBlueprintWire } from "./architecture-blueprint-wire.js";
import { assembleBlueprintStages, assembleBlueprintOutlineCore,
  assembleCurrentBlueprintOutline, BEAT_BATCH_SIZE, EVIDENCE_BATCH_SIZE,
  parseBlueprintBeatBatch, parseBlueprintEvidence, parseBlueprintObligationStage,
  parseBlueprintOutline, parseBlueprintOutlineCore, parseBlueprintOutlineHeader,
  parseBlueprintRouteStage, requiredBlueprintRouteChoices,
  type BlueprintEvidence, type BlueprintOutline, type BlueprintOutlineCore,
  type BlueprintOutlineHeader, type BlueprintOutlineBeat, type BlueprintRouteConsequence
} from "./architecture-blueprint-stages.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

/** Distinguish settled, invalid model output from ambiguous interrupted Pi work.
 * A rejected patch may be inspected/replayed but never resumed as approval. */
export function classifyBlueprintFailure(reason: string):
  "invalid-plan" | "review-rejected" | "interrupted" {
  if (reason.includes("requires independent reassessment") ||
      reason.includes("Diagnostic review requires") ||
      reason.includes("exhausted bounded corrections")) return "review-rejected";
  if (/\b(?:interrupted|cancelled|canceled|aborted|timed out|timeout)\b/i.test(reason))
    return "interrupted";
  if (/^(?:Blueprint patch |Blueprint JSONL |Blueprint response |Blueprint model response |Causal blueprint |Causal outline |Causal evidence |Independent blueprint review |Invalid bounded causal blueprint)/.test(reason) ||
      reason.includes("invalid beat relationships"))
    return "invalid-plan";
  return "interrupted";
}

// The complete blueprint is assembled from separately bounded beat and
// evidence batches. Its aggregate limit must not be a single-response budget;
// keep an independent 64 KB ceiling for the fully assembled document.
const MAX_BLUEPRINT_BYTES = 64000;
const REQUIRED_SKILLS = ["nt-story-architecture/SKILL.md", "nt-catalog/SKILL.md"] as const;

export interface CausalBlueprint {
  schema: "noveltea-causal-blueprint/v1";
  premise: string;
  beats: Array<{
    id: string;
    purpose: string;
    dependsOn: string[];
    observations: Array<{ source: string; observable: string; supports: string; limits: string }>;
    change: string;
    decisions: Array<{ question: string; alternatives: Array<{ action: string; lastingEffect: string }> }>;
  }>;
  resolution: { question: string; conclusion: string; supportedBy: string[]; uncertainty: string };
}
export type BlueprintReview = {
  status: "pass" | "revise";
  findings: Array<{ beatId: string; reason: string; correction: string }>;
} | ConvergentReview;
export interface BlueprintPin {
  schema: "noveltea-approved-blueprint/v2" | "noveltea-approved-blueprint/v3" | "noveltea-approved-blueprint/v4";
  /** Only v4 approvals carry a continuing reviewer conversation. */
  reviewCycleId?: string;
  jobId: string;
  threadId: string;
  baseSha: string;
  executionHead: string;
  planVersion: number;
  contractDigest: string;
  snapshotId: string;
  model: string;
  provider: string;
  taskDigest: string;
  draftVersion: number;
  blueprintDigest: string;
  reviewDigest: string;
  obligationsDigest: string;
  stagesDigest?: string;
  plannerSessionId: string;
  plannerSessionFile: string;
  reviewerSessionId: string;
  reviewerSessionFile: string;
}

function nonempty(value: unknown, max = 700): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function strict(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, "");
  if (Buffer.byteLength(trimmed) > MAX_BLUEPRINT_BYTES) throw Error("Causal blueprint output exceeds its bounded size.");
  try { return JSON.parse(trimmed); } catch { throw Error("Causal blueprint reviewer/planner returned invalid JSON."); }
}
export function parseCausalBlueprint(text: string): CausalBlueprint {
  const value = parseJson(text);
  if (!strict(value, ["schema", "premise", "beats", "resolution"]) ||
      value.schema !== "noveltea-causal-blueprint/v1" || !nonempty(value.premise, MAX_BLUEPRINT_BYTES) ||
      !Array.isArray(value.beats) || value.beats.length < 2 || value.beats.length > 16 ||
      !strict(value.resolution, ["question", "conclusion", "supportedBy", "uncertainty"]))
    throw Error("Invalid bounded causal blueprint structure.");
  const resolution = value.resolution;
  if (!nonempty(resolution.question, MAX_BLUEPRINT_BYTES) ||
      !nonempty(resolution.conclusion, MAX_BLUEPRINT_BYTES) ||
      !nonempty(resolution.uncertainty, MAX_BLUEPRINT_BYTES) ||
      !Array.isArray(resolution.supportedBy) ||
      !resolution.supportedBy.length || resolution.supportedBy.length > 16)
    throw Error("Causal blueprint resolution requires a question, supported conclusion and explicit uncertainty.");
  const seen = new Set<string>();
  let observations = 0;
  for (const beat of value.beats) {
    const beatKeys = ["id", "purpose", "dependsOn", "observations", "change"];
    if ((!strict(beat, [...beatKeys, "decisions"]) && !strict(beat, beatKeys)) ||
        typeof beat.id !== "string" || !SLUG.test(beat.id) || seen.has(beat.id) ||
        !nonempty(beat.purpose, MAX_BLUEPRINT_BYTES) ||
        !nonempty(beat.change, MAX_BLUEPRINT_BYTES) ||
        !Array.isArray(beat.dependsOn) || beat.dependsOn.length > 8 ||
        beat.dependsOn.some((id: unknown) => typeof id !== "string" || !seen.has(id)) ||
        new Set(beat.dependsOn).size !== beat.dependsOn.length ||
        !Array.isArray(beat.observations) || beat.observations.length > 8 ||
        (beat.decisions !== undefined && (!Array.isArray(beat.decisions) || beat.decisions.length > 6)))
      throw Error("Causal blueprint has duplicate, out-of-order or invalid beat relationships.");
    // A narrative-led beat need not contain a player decision. Omission is
    // canonically equivalent to [], but unknown fields and malformed decisions
    // still fail; independent review sees the normalized complete design.
    if (beat.decisions === undefined) beat.decisions = [];
    const decisions = beat.decisions as unknown[];
    for (const observation of beat.observations) {
      if (!strict(observation, ["source", "observable", "supports", "limits"]) ||
          !["source", "observable", "supports", "limits"].every(key =>
            nonempty(observation[key], MAX_BLUEPRINT_BYTES)))
        throw Error("Causal blueprint evidence must separate source, observation, support and limits.");
      observations++;
    }
    for (const decision of decisions) {
      if (!strict(decision, ["question", "alternatives"]) ||
          !nonempty(decision.question, MAX_BLUEPRINT_BYTES) ||
          !Array.isArray(decision.alternatives) || decision.alternatives.length < 2 ||
          decision.alternatives.length > 5 || decision.alternatives.some((alt: unknown) =>
            !strict(alt, ["action", "lastingEffect"]) ||
            !nonempty(alt.action, MAX_BLUEPRINT_BYTES) ||
            !nonempty(alt.lastingEffect, MAX_BLUEPRINT_BYTES)))
        throw Error("Causal blueprint decisions need distinct, lasting alternatives.");
    }
    seen.add(beat.id);
  }
  if (!observations || resolution.supportedBy.some((id: unknown) =>
    typeof id !== "string" || !seen.has(id)) ||
      new Set(resolution.supportedBy).size !== resolution.supportedBy.length ||
      !resolution.supportedBy.some((id: string) =>
        (value.beats as CausalBlueprint["beats"]).find(beat => beat.id === id)?.observations.length))
    throw Error("Causal blueprint resolution lacks a supported, source-linked evidence chain.");
  return value as unknown as CausalBlueprint;
}
export function parseBlueprintReview(text: string, blueprint: CausalBlueprint): BlueprintReview {
  const value = parseJson(text);
  const convergent = !!value && typeof value === "object" &&
    "schema" in value && value.schema === "noveltea-blueprint-review/v2";
  if (!strict(value, convergent ? ["schema", "status", "findings", "prior"] : ["status", "findings"]) ||
      (convergent && !Array.isArray(value.prior)) ||
      !["pass", "revise"].includes(String(value.status)) || !Array.isArray(value.findings) ||
      value.findings.length > 8 || (value.status === "pass" ? value.findings.length !== 0 : !value.findings.length))
    throw Error("Independent blueprint review has malformed verdict or findings.");
  const ids = new Set(blueprint.beats.map(b => b.id));
  for (const finding of value.findings) {
    if (!strict(finding, convergent ?
          ["beatId", "reason", "correction", "requirement", "evidence", "origin"] :
          ["beatId", "reason", "correction"]) || !ids.has(finding.beatId as string) ||
        !nonempty(finding.reason) || !nonempty(finding.correction))
      throw Error("Independent blueprint review contains unbounded or unknown causal findings.");
  }
  return value as unknown as BlueprintReview;
}

const root = (job: JobStartResult) => join(job.stateDir, "architecture-blueprints");
const draftPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-draft-" + iteration + ".json");
const verdictPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-verdict-" + iteration + ".json");
const obligationsPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-obligations.json");
const outlinePath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-outline.json");
const outlineCorePath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-outline-core.json");
const outlineHeaderPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-outline-header.json");
const outlineBeatPath = (job: JobStartResult, version: number, first: number) =>
  join(root(job), "plan-" + version + "-outline-beats-" + first + ".json");
const outlineRoutesPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-outline-routes.json");
const evidencePath = (job: JobStartResult, version: number, first: number) =>
  join(root(job), "plan-" + version + "-evidence-" + first + ".json");
const stagesPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-stages.json");
const patchPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-patch-" + iteration + ".json");
const reviewSessionPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-review-session-" + iteration + ".json");
const convergencePath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-convergence-" + iteration + ".json");
const diagnosticPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-diagnostic-" + iteration + ".json");
const replacementPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-replacement-" + iteration + ".json");
const pausePath = (job: JobStartResult, version: number, iteration: number,
  boundary: "writer" | "review" | "diagnostic" | "replacement") =>
  join(root(job), "plan-" + version + "-pause-" + iteration + "-" + boundary + ".json");
const initialPausePath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-pause-initial-review.json");
const plannerAdmissionPausePath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-pause-planner-admission.json");
const initialReviewStartedPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-initial-review-started.json");
async function obligationSources(job: JobStartResult, plan: Plan, task: string): Promise<ObligationSources> {
  return { foundation: await readFile(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8"),
    contract: plan.contract, task };
}
export function parseInitialBlueprint(text: string, sources: ObligationSources) {
  const wire = parseBlueprintWire(text, 60000);
  let draft: unknown;
  let items: unknown;
  if (wire.format === "jsonl") {
    if (wire.values.length < 2 || wire.values.length > 21)
      throw Error("Causal blueprint JSONL needs one draft and 1–20 source obligations.");
    draft = wire.values[0];
    items = wire.values.slice(1);
  } else {
    if (!strict(wire.value, ["blueprint", "obligations"]))
      throw Error("Causal blueprint must contain both its design and source-derived proof obligations.");
    draft = wire.value.blueprint;
    items = wire.value.obligations;
  }
  const blueprint = parseCausalBlueprint(JSON.stringify(draft));
  return { blueprint, obligations: buildBlueprintObligations(items, blueprint, sources) };
}
const admittedPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-admitted.json");
const approvedPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-approved.json");
async function immutable(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function safeRead(path: string, parent: string): Promise<unknown> {
  if (!path.startsWith(parent + sep) || !existsSync(path) ||
      await realpath(path) !== path || !(await lstat(path)).isFile())
    throw Error("Blueprint or its review evidence is missing or unsafe.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
function sameLineage(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string): Omit<BlueprintPin, "schema" | "draftVersion" |
  "blueprintDigest" | "reviewDigest" | "obligationsDigest" | "stagesDigest" | "plannerSessionId" | "plannerSessionFile" |
  "reviewerSessionId" | "reviewerSessionFile" | "reviewCycleId"> {
  return { jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    executionHead: head, planVersion: plan.version, contractDigest: sha(plan.contract),
    snapshotId: snapshot.id, provider, model, taskDigest: sha(task) };
}
async function transcript(job: JobStartResult, file: string, id: string, directory: string) {
  const parent = join(job.stateDir, directory);
  if (typeof file !== "string" || !file.startsWith(parent + sep) ||
      typeof id !== "string" || !id || !existsSync(file) ||
      await realpath(file) !== file || !(await lstat(file)).isFile())
    throw Error("Causal blueprint's pinned independent Pi transcript is absent or unsafe.");
  const first = (await readFile(file, "utf8")).split("\n")[0];
  let header: { type?: string; id?: string };
  try { header = JSON.parse(first ?? "") as typeof header; } catch { throw Error("Invalid blueprint Pi transcript header."); }
  if (header.type !== "session" || header.id !== id) throw Error("Blueprint Pi transcript identity mismatch.");
}
/** Single verifier for approved and initial-pause v1/v2/v3 staged drafts. */
async function verifyStageChain(job: JobStartResult, plan: Plan, stageDigest?: string): Promise<{
  initial: CausalBlueprint; outline?: BlueprintOutline; stages?: unknown;
}> {
  let outline: BlueprintOutline | undefined;
  let stages: unknown;
  const initial = parseCausalBlueprint(JSON.stringify(await safeRead(
    draftPath(job, plan.version, 0), root(job))));
  if (stageDigest !== undefined) {
    const receipt = await safeRead(stagesPath(job, plan.version), root(job));
    stages = receipt;
    const batched = !!receipt && typeof receipt === "object" &&
      "schema" in receipt && receipt.schema === "noveltea-blueprint-stages/v3";
    const split = batched || (!!receipt && typeof receipt === "object" &&
      "schema" in receipt && receipt.schema === "noveltea-blueprint-stages/v2");
    if (!strict(receipt, batched ?
          ["schema", "outlineDigest", "headerDigest", "beatDigests",
            "coreDigest", "routesDigest", "evidenceDigests"] :
          split ? ["schema", "outlineDigest", "coreDigest", "routesDigest", "evidenceDigests"] :
          ["schema", "outlineDigest", "evidenceDigests"]) ||
        !["noveltea-blueprint-stages/v1", "noveltea-blueprint-stages/v2",
          "noveltea-blueprint-stages/v3"].includes(String(receipt.schema)) ||
        !Array.isArray(receipt.evidenceDigests) ||
        sha(receipt) !== stageDigest)
      throw Error("Approved causal blueprint stage receipt changed or is missing.");
    outline = parseBlueprintOutline(JSON.stringify(
      await safeRead(outlinePath(job, plan.version), root(job))));
    if (sha(outline) !== receipt.outlineDigest)
      throw Error("Approved causal outline changed after admission.");
    if (split) {
      const core = parseBlueprintOutlineCore(JSON.stringify(
        await safeRead(outlineCorePath(job, plan.version), root(job))));
      const routes = await safeRead(outlineRoutesPath(job, plan.version), root(job));
      if (sha(core) !== receipt.coreDigest ||
          !Array.isArray(routes) || sha(routes) !== receipt.routesDigest ||
          !isDeepStrictEqual(assembleCurrentBlueprintOutline(
            core, routes as BlueprintRouteConsequence[]), outline))
        throw Error("Approved causal outline core or Choice route stage changed.");
      if (batched) {
        const header = parseBlueprintOutlineHeader(JSON.stringify(
          await safeRead(outlineHeaderPath(job, plan.version), root(job))));
        if (sha(header) !== receipt.headerDigest || !Array.isArray(receipt.beatDigests) ||
            receipt.beatDigests.length !== Math.ceil(header.beatIds.length / BEAT_BATCH_SIZE))
          throw Error("Approved causal header or beat-batch receipt changed.");
        const beats: BlueprintOutlineBeat[] = [];
        for (let first = 0; first < header.beatIds.length; first += BEAT_BATCH_SIZE) {
          const chunk = await safeRead(outlineBeatPath(job, plan.version, first), root(job));
          if (!Array.isArray(chunk) ||
              sha(chunk) !== receipt.beatDigests[first / BEAT_BATCH_SIZE])
            throw Error("Approved causal beat batch changed after planning.");
          beats.push(...parseBlueprintBeatBatch(
            chunk.map(row => JSON.stringify(row)).join("\n"), header, first, beats));
        }
        if (!isDeepStrictEqual(assembleBlueprintOutlineCore(header, beats), core))
          throw Error("Approved causal core differs from its verified header and beat batches.");
      }
    }
    const evidence: BlueprintEvidence[] = [];
    const expectedBatches = Math.ceil(outline.beats.length / EVIDENCE_BATCH_SIZE);
    if (receipt.evidenceDigests.length !== expectedBatches)
      throw Error("Approved causal evidence batch count changed.");
    for (let first = 0; first < outline.beats.length; first += EVIDENCE_BATCH_SIZE) {
      const chunk = await safeRead(evidencePath(job, plan.version, first), root(job));
      if (!Array.isArray(chunk) ||
          sha(chunk) !== receipt.evidenceDigests[first / EVIDENCE_BATCH_SIZE])
        throw Error("Approved causal evidence batch changed.");
      evidence.push(...parseBlueprintEvidence(
        chunk.map(line => JSON.stringify(line)).join("\n"), outline, first));
    }
    if (!isDeepStrictEqual(assembleBlueprintStages(outline, evidence), initial))
      throw Error("Approved causal draft differs from its staged source-bound evidence.");
  }
  return { initial, outline, stages };
}
interface BlueprintDiagnosticReceipt {
  schema: "noveltea-blueprint-diagnostic-receipt/v1";
  cycleId: string;
  evidenceDigest: string;
  caseFingerprint: string;
  trigger: DiagnosticTrigger;
  draftDigest: string;
  reviewDigest: string;
  reviewerSessionId: string;
  diagnosis: BlueprintDiagnosis;
  sessionId: string;
  sessionFile: string;
  transcriptBytes: number;
  transcriptDigest: string;
}
interface BlueprintReplacementReceipt {
  schema: "noveltea-blueprint-replacement-receipt/v1";
  cycleId: string;
  diagnosisDigest: string;
  draftDigest: string;
  reviewDigest: string;
  verdict: ConvergentReview;
  sessionId: string;
  sessionFile: string;
  transcriptBytes: number;
  transcriptDigest: string;
}
async function verifiedAuxiliaryTranscript(job: JobStartResult, directory: string,
  file: string, id: string, length: number, hash: string) {
  if (!Number.isSafeInteger(length) || length <= 0 || !HASH.test(hash))
    throw Error("Independent diagnostic/replacement review transcript receipt is invalid.");
  await transcript(job, file, id, directory);
  const bytes = await readFile(file);
  if (bytes.length < length ||
      createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== hash)
    throw Error("Independent diagnostic/replacement review transcript changed after sealing.");
}
async function readDiagnosis(job: JobStartResult, plan: Plan, version: number,
  cycleId: string, rounds: readonly ReviewRound[], sources: ObligationSources,
  reviewerSessionId: string, writerSessionId: string): Promise<BlueprintDiagnosticReceipt | null> {
  const path = diagnosticPath(job, plan.version, version);
  if (!existsSync(path)) return null;
  const receipt = await safeRead(path, root(job)) as BlueprintDiagnosticReceipt;
  if (!strict(receipt, ["schema", "cycleId", "evidenceDigest", "caseFingerprint", "trigger",
    "draftDigest", "reviewDigest", "reviewerSessionId", "diagnosis",
    "sessionId", "sessionFile", "transcriptBytes", "transcriptDigest"]) ||
      receipt.schema !== "noveltea-blueprint-diagnostic-receipt/v1" ||
      receipt.cycleId !== cycleId ||
      receipt.evidenceDigest !== diagnosticEvidence(cycleId, rounds, sources) ||
      receipt.caseFingerprint !== diagnosticCaseFingerprint(cycleId,
        rounds.at(-1)!.blueprint, rounds.at(-1)!.verdict, sources) ||
      receipt.draftDigest !== sha(rounds.at(-1)?.blueprint) ||
      receipt.reviewDigest !== sha(rounds.at(-1)?.verdict) ||
      receipt.reviewerSessionId !== reviewerSessionId ||
      !["stagnation", "late-blockers", "review-depth"].includes(receipt.trigger) ||
      receipt.sessionId === reviewerSessionId || receipt.sessionId === writerSessionId)
    throw Error("Independent Blueprint diagnosis changed its source or reviewer provenance.");
  const diagnosis = parseBlueprintDiagnosis(JSON.stringify(receipt.diagnosis),
    rounds.at(-1)!.blueprint, sources);
  if (!isDeepStrictEqual(diagnosis, receipt.diagnosis))
    throw Error("Independent Blueprint diagnosis did not match its sealed evidence.");
  await verifiedAuxiliaryTranscript(job, "architecture-blueprint-diagnostic-sessions",
    receipt.sessionFile, receipt.sessionId, receipt.transcriptBytes, receipt.transcriptDigest);
  return receipt;
}
async function readReplacement(job: JobStartResult, plan: Plan, version: number,
  cycleId: string, blueprint: CausalBlueprint, history: readonly ReviewRound[],
  sources: ObligationSources, diagnostic: BlueprintDiagnosticReceipt | null,
  writerSessionId: string, previousReviewerSessionId: string): Promise<BlueprintReplacementReceipt | null> {
  const path = replacementPath(job, plan.version, version);
  if (!existsSync(path)) return null;
  const receipt = await safeRead(path, root(job)) as BlueprintReplacementReceipt;
  if (!diagnostic || diagnostic.diagnosis.action !== "replace" ||
      !strict(receipt, ["schema", "cycleId", "diagnosisDigest", "draftDigest",
        "reviewDigest", "verdict", "sessionId", "sessionFile",
        "transcriptBytes", "transcriptDigest"]) ||
      receipt.schema !== "noveltea-blueprint-replacement-receipt/v1" ||
      receipt.cycleId !== cycleId ||
      receipt.diagnosisDigest !== sha(diagnostic) ||
      receipt.draftDigest !== sha(blueprint) ||
      receipt.reviewDigest !== sha(history.at(-1)?.verdict) ||
      [writerSessionId, previousReviewerSessionId, diagnostic.sessionId].includes(receipt.sessionId) ||
      receipt.sessionFile === diagnostic.sessionFile)
    throw Error("Independent replacement review has stale or unauthorized provenance.");
  const parsed = parseBlueprintReview(JSON.stringify(receipt.verdict), blueprint);
  evaluateReviewConvergence(parsed, blueprint, history, sources, 0, true);
  await verifiedAuxiliaryTranscript(job, "architecture-blueprint-review-sessions",
    receipt.sessionFile, receipt.sessionId, receipt.transcriptBytes, receipt.transcriptDigest);
  return receipt;
}
async function readRecordedBlueprint(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string,
  pausedPin?: BlueprintPin, pendingDiagnostic = false): Promise<{
    blueprint: CausalBlueprint; pin: BlueprintPin; rounds: ReviewRound[]; stalled: number;
  } | null> {
  const path = approvedPath(job, plan.version);
  if (!pausedPin && !existsSync(path)) return null;
  const record = pausedPin ?? await safeRead(path, root(job)) as BlueprintPin;
  const expected = sameLineage(job, plan, snapshot, provider, model, task, head);
  if (!record || !["noveltea-approved-blueprint/v2", "noveltea-approved-blueprint/v3",
      "noveltea-approved-blueprint/v4"].includes(record.schema) ||
      (record.schema !== "noveltea-approved-blueprint/v2"
        ? !record.stagesDigest || !HASH.test(record.stagesDigest)
        : record.stagesDigest !== undefined) ||
      (record.schema === "noveltea-approved-blueprint/v4"
        ? record.reviewCycleId !== reviewCycleId(expected)
        : record.reviewCycleId !== undefined) ||
      Object.entries(expected).some(([key, value]) => record[key as keyof BlueprintPin] !== value) ||
      !Number.isSafeInteger(record.draftVersion) || record.draftVersion < 0 ||
      !HASH.test(record.blueprintDigest) || !HASH.test(record.reviewDigest) ||
      !HASH.test(record.obligationsDigest))
    throw Error("Approved causal blueprint is stale, incomplete or bound to a different scope.");
  const admission = await safeRead(admittedPath(job, plan.version), root(job));
  if (!strict(admission, Object.keys(expected)) ||
      Object.entries(expected).some(([key, value]) => admission[key] !== value))
    throw Error("Causal blueprint source-bound pre-session admission is stale or absent.");
  const start = await safeRead(join(root(job), "plan-" + plan.version + "-started.json"), root(job));
  if (!start || typeof start !== "object" ||
      Object.entries(expected).some(([key, value]) =>
        (start as Record<string, unknown>)[key] !== value) ||
      (start as Record<string, unknown>).plannerSessionId !== record.plannerSessionId ||
      (start as Record<string, unknown>).plannerSessionFile !== record.plannerSessionFile)
    throw Error("Causal blueprint source-bound planner start receipt is stale or absent.");
  const sources = await obligationSources(job, plan, task);
  const manifest = await safeRead(obligationsPath(job, plan.version), root(job));
  const { initial } = await verifyStageChain(job, plan, record.stagesDigest);
  validateBlueprintObligations(manifest, initial, sources);
  if (sha(manifest) !== record.obligationsDigest)
    throw Error("Approved causal proof obligations changed after review.");
  let blueprint = initial;
  const reviewers = new Set<string>();
  let previousTranscriptBytes = 0;
  const priorRounds: ReviewRound[] = [];
  let stalled = 0;
  let diagnosisCount = 0;
  const seenCases = new Set<string>();
  let activeReviewer: { id: string; file: string } | undefined;
  const cycleId = record.reviewCycleId ?? "";
  for (let i = 0; i <= record.draftVersion; i++) {
    const stored = await safeRead(draftPath(job, plan.version, i), root(job));
    if (sha(blueprint) !== sha(stored))
      throw Error("Causal blueprint patch history is stale or was rewritten.");
    const verdict = await safeRead(verdictPath(job, plan.version, i), root(job));
    const review = parseBlueprintReview(JSON.stringify(verdict), blueprint);
    if ("schema" in review && review.schema === "noveltea-blueprint-review/v2") {
      const convergence = evaluateReviewConvergence(review, blueprint, priorRounds, sources, stalled);
      // A sealed diagnosis may safely authorize continuation of a stalled
      // negative verdict; its independent evidence is verified below.
      const receipt = await safeRead(convergencePath(job, plan.version, i), root(job));
      if (!isDeepStrictEqual(receipt, {
        schema: "noveltea-blueprint-convergence/v1", draftDigest: sha(blueprint),
        verdictDigest: sha(review), productive: convergence.productive,
        stalled: convergence.stalled, oscillating: convergence.oscillating,
      })) throw Error("Approved causal blueprint convergence evidence changed.");
      stalled = convergence.stalled;
    } else if (i > 2 || priorRounds.some(round => "schema" in round.verdict)) {
      // Older v2/v3/v4 approvals remain readable, but new unbounded cycles
      // cannot downgrade to the old unaccountable response format.
      throw Error("Approved causal blueprint lost its convergence review evidence.");
    }
    const reviewSession = await safeRead(reviewSessionPath(job, plan.version, i), root(job)) as {
      schema?: string; cycleId?: string; sessionId: string; sessionFile: string;
      verdictDigest: string; blueprintDigest: string; transcriptBytes?: number;
      transcriptDigest?: string };
    const persistent = record.schema === "noveltea-approved-blueprint/v4";
    if (!strict(reviewSession, persistent
          ? ["schema", "cycleId", "sessionId", "sessionFile", "verdictDigest",
            "blueprintDigest", "transcriptBytes", "transcriptDigest"]
          : ["sessionId", "sessionFile", "verdictDigest", "blueprintDigest"]) ||
        reviewSession.verdictDigest !== sha(verdict) ||
        reviewSession.blueprintDigest !== sha(blueprint) ||
        (persistent
          ? reviewSession.schema !== "noveltea-blueprint-review-turn/v1" ||
            reviewSession.cycleId !== record.reviewCycleId ||
            !Number.isSafeInteger(reviewSession.transcriptBytes) ||
            reviewSession.transcriptBytes! <= previousTranscriptBytes ||
            !HASH.test(reviewSession.transcriptDigest ?? "") ||
            (i > 0 && (reviewSession.sessionId !== activeReviewer?.id ||
              reviewSession.sessionFile !== activeReviewer?.file))
          : reviewers.has(reviewSession.sessionId) || reviewers.has(reviewSession.sessionFile)))
      throw Error("Causal blueprint independent review provenance changed.");
    assertReviewCycleSession(
      { id: record.plannerSessionId, file: record.plannerSessionFile },
      { id: reviewSession.sessionId, file: reviewSession.sessionFile });
    activeReviewer = { id: reviewSession.sessionId, file: reviewSession.sessionFile };
    reviewers.add(reviewSession.sessionId);
    reviewers.add(reviewSession.sessionFile);
    await transcript(job, reviewSession.sessionFile, reviewSession.sessionId,
      "architecture-blueprint-review-sessions");
    if (persistent) {
      const bytes = await readFile(reviewSession.sessionFile);
      if (bytes.length < reviewSession.transcriptBytes! ||
          createHash("sha256").update(bytes.subarray(0, reviewSession.transcriptBytes!))
            .digest("hex") !== reviewSession.transcriptDigest)
        throw Error("Causal blueprint review transcript changed after sealed verdict.");
      previousTranscriptBytes = reviewSession.transcriptBytes!;
    }
    let effective = review;
    const rounds = [...priorRounds, { blueprint, verdict: review }];
    if (persistent) {
      const diagnosis = await readDiagnosis(job, plan, i, cycleId, rounds, sources,
        reviewSession.sessionId, record.plannerSessionId);
      const expectedTrigger = diagnosticTrigger(rounds, stalled, diagnosisCount);
      if (diagnosis) {
        if (!expectedTrigger || diagnosis.trigger !== expectedTrigger ||
            seenCases.has(diagnosis.caseFingerprint))
          throw Error("Blueprint diagnosis was repeated or not requested by the verified Review cycle.");
        seenCases.add(diagnosis.caseFingerprint);
        diagnosisCount++;
        if (["split", "escalate"].includes(diagnosis.diagnosis.action))
          throw Error("Historical Blueprint diagnostic escalated; no automatic review continuation is authorized.");
        const replacement = await readReplacement(job, plan, i, cycleId, blueprint,
          rounds, sources, diagnosis, record.plannerSessionId, reviewSession.sessionId);
        if (replacement) {
          effective = replacement.verdict;
          activeReviewer = { id: replacement.sessionId, file: replacement.sessionFile };
          previousTranscriptBytes = 0;
        } else if (diagnosis.diagnosis.action === "replace" &&
            !(pendingDiagnostic && i === record.draftVersion)) {
          throw Error("Blueprint replacement requires an independent current review.");
        }
        stalled = 0;
      } else if (expectedTrigger === "stagnation" &&
          !(pendingDiagnostic && i === record.draftVersion)) {
        throw Error("Approved causal blueprint contains a stalled review requiring independent reassessment.");
      }
    }
    priorRounds.push({ blueprint, verdict: effective });
    if (i === record.draftVersion) {
      if (effective.status !== (pausedPin ? "revise" : "pass") ||
          sha(blueprint) !== record.blueprintDigest ||
          sha(effective) !== record.reviewDigest ||
          activeReviewer?.id !== record.reviewerSessionId ||
          activeReviewer?.file !== record.reviewerSessionFile)
        throw Error("Approved causal blueprint or independent verdict changed after review.");
    } else {
      const patch = await safeRead(patchPath(job, plan.version, i + 1), root(job));
      blueprint = applyBlueprintPatch(blueprint, effective, patch).blueprint;
    }
  }
  await transcript(job, record.plannerSessionFile, record.plannerSessionId, "architecture-blueprint-sessions");
  await transcript(job, record.reviewerSessionFile, record.reviewerSessionId, "architecture-blueprint-review-sessions");
  return { blueprint, pin: record, rounds: priorRounds, stalled };
}

export async function readApprovedBlueprint(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string): Promise<{ blueprint: CausalBlueprint; pin: BlueprintPin } | null> {
  const verified = await readRecordedBlueprint(job, plan, snapshot, provider, model, task, head);
  return verified ? { blueprint: verified.blueprint, pin: verified.pin } : null;
}


type PlannerAdmissionPause = {
  schema: "noveltea-blueprint-planner-admission-pause/v1";
  lineage: ReturnType<typeof sameLineage>;
  step: string;
  reason: string;
};

/** A budget gate can expire after the graph's preflight but before the
 * planner session exists. Only a write-once receipt at that exact safe
 * boundary admits a new planner; arbitrary admitted-but-unstarted work is
 * still blocked as an ambiguous interruption. */
async function readPlannerAdmissionPause(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string) {
  if (!existsSync(plannerAdmissionPausePath(job, plan.version))) return false;
  const marker = await safeRead(plannerAdmissionPausePath(job, plan.version), root(job));
  const lineage = sameLineage(job, plan, snapshot, provider, model, task, head);
  if (!strict(marker, ["schema", "lineage", "step", "reason"]) ||
      marker.schema !== "noveltea-blueprint-planner-admission-pause/v1" ||
      !isDeepStrictEqual(marker.lineage, lineage) ||
      marker.step !== "blueprint:" + plan.version ||
      !["steps", "modelCalls", "cost-unavailable", "costUsd", "activeSeconds"].includes(
        String(marker.reason)) ||
      !isDeepStrictEqual(await safeRead(admittedPath(job, plan.version), root(job)), lineage))
    throw Error("Planner admission budget pause has stale or invalid source-bound evidence.");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(root(job))).filter(name =>
    name.startsWith("plan-" + plan.version + "-"));
  if (files.some(name => name !== "plan-" + plan.version + "-admitted.json" &&
      name !== "plan-" + plan.version + "-pause-planner-admission.json"))
    throw Error("Planner advanced beyond its budget pause; inspect Pi work instead of replay.");
  return true;
}

type InitialReviewPause = {
  schema: "noveltea-blueprint-initial-review-pause/v1";
  lineage: ReturnType<typeof sameLineage>;
  plannerSessionId: string;
  plannerSessionFile: string;
  plannerTranscriptBytes: number;
  plannerTranscriptDigest: string;
  draftDigest: string;
  stagesDigest: string;
  obligationsDigest: string;
};

/** A complete staged draft, but no reviewer turn, is a distinct safe
 * boundary. Verify the whole staged chain before allowing the initial review
 * to start; an unfinished planner can never claim this marker. */
async function readInitialReviewPause(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string) {
  if (!existsSync(initialPausePath(job, plan.version))) return null;
  const marker = await safeRead(initialPausePath(job, plan.version), root(job));
  const lineage = sameLineage(job, plan, snapshot, provider, model, task, head);
  if (!strict(marker, ["schema", "lineage", "plannerSessionId", "plannerSessionFile",
        "plannerTranscriptBytes", "plannerTranscriptDigest", "draftDigest",
        "stagesDigest", "obligationsDigest"]) ||
      marker.schema !== "noveltea-blueprint-initial-review-pause/v1" ||
      !isDeepStrictEqual(marker.lineage, lineage) ||
      !Number.isSafeInteger(marker.plannerTranscriptBytes) ||
      (marker.plannerTranscriptBytes as number) < 1 ||
      ![marker.plannerTranscriptDigest, marker.draftDigest, marker.stagesDigest,
        marker.obligationsDigest].every(x => typeof x === "string" && HASH.test(x)))
    throw Error("Initial Blueprint review pause has invalid source-bound evidence.");
  const admitted = await safeRead(admittedPath(job, plan.version), root(job));
  const started = await safeRead(join(root(job), "plan-" + plan.version + "-started.json"), root(job));
  if (!isDeepStrictEqual(admitted, lineage) ||
      !isDeepStrictEqual(started, { ...lineage,
        plannerSessionId: marker.plannerSessionId,
        plannerSessionFile: marker.plannerSessionFile }))
    throw Error("Initial Blueprint review pause has stale planner admission.");
  await transcript(job, marker.plannerSessionFile as string,
    marker.plannerSessionId as string, "architecture-blueprint-sessions");
  const bytes = await readFile(marker.plannerSessionFile as string);
  if (bytes.length !== marker.plannerTranscriptBytes ||
      createHash("sha256").update(bytes).digest("hex") !== marker.plannerTranscriptDigest)
    throw Error("Initial Blueprint planner transcript changed after safe pause.");
  // An initial pause is usable only before the first reviewer is admitted.
  // The write-once start receipt intentionally outlives a crash in the
  // reviewer prompt or before its verdict is sealed.
  if (existsSync(initialReviewStartedPath(job, plan.version)))
    throw Error("Initial Blueprint reviewer already started; inspect original session instead of replay.");
  const { readdir } = await import("node:fs/promises");
  if ((await readdir(root(job))).some(name => new RegExp(
    "^plan-" + plan.version + "-(verdict|review-session|convergence|patch|approved)-").test(name) ||
    name === "plan-" + plan.version + "-approved.json"))
    throw Error("Initial Blueprint review has already started or progressed; inspect instead of replay.");
  const verifiedStages = await verifyStageChain(job, plan, marker.stagesDigest as string);
  const { initial, outline, stages } = verifiedStages;
  if (!outline || !stages || (stages as { schema?: string }).schema !== "noveltea-blueprint-stages/v3" ||
      sha(initial) !== marker.draftDigest)
    throw Error("Initial Blueprint draft or stage chain differs from paused receipt.");
  const sources = await obligationSources(job, plan, task);
  const manifest = validateBlueprintObligations(await safeRead(
    obligationsPath(job, plan.version), root(job)), initial, sources);
  if (sha(manifest) !== marker.obligationsDigest)
    throw Error("Initial Blueprint source obligations changed.");
  return { initial, manifest, outline, stages, plannerSessionId: marker.plannerSessionId as string,
    plannerSessionFile: marker.plannerSessionFile as string };
}

type BlueprintPause = {
  schema: "noveltea-blueprint-safe-pause/v1";
  boundary: "writer" | "review" | "diagnostic" | "replacement";
  nextVersion: number;
  pin: BlueprintPin;
  nextDraftDigest: string | null;
  writerTranscriptDigest: string;
  writerTranscriptBytes: number;
  reviewerTranscriptDigest: string;
  reviewerTranscriptBytes: number;
};

/** Only budget pauses at explicitly sealed turn boundaries may resume. A
 * crashed/incomplete Pi turn never creates this grant. Prior receipts and
 * source-bound approval evidence are rechecked before reopening sessions. */
async function readPausedBlueprint(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string) {
  if (!existsSync(root(job))) return null;
  const { readdir } = await import("node:fs/promises");
  const escaped = String(plan.version);
  const matches = (await readdir(root(job))).flatMap(name => {
    const match = new RegExp("^plan-" + escaped + "-pause-([0-9]+)-(writer|review|diagnostic|replacement)\\.json$").exec(name);
    return match ? [{ version: Number(match[1]), boundary: match[2] as BlueprintPause["boundary"] }] : [];
  }).sort((a, b) => b.version - a.version ||
    ["writer", "review", "diagnostic", "replacement"].indexOf(b.boundary) -
    ["writer", "review", "diagnostic", "replacement"].indexOf(a.boundary));
  if (!matches.length) return null;
  const { version, boundary } = matches[0]!;
  const marker = await safeRead(pausePath(job, plan.version, version, boundary), root(job));
  if (!strict(marker, ["schema", "boundary", "nextVersion", "pin", "nextDraftDigest",
        "writerTranscriptDigest", "writerTranscriptBytes",
        "reviewerTranscriptDigest", "reviewerTranscriptBytes"]) ||
      marker.schema !== "noveltea-blueprint-safe-pause/v1" ||
      marker.boundary !== boundary || marker.nextVersion !== version ||
      !Number.isSafeInteger(version) || version < 1 ||
      !marker.pin || typeof marker.pin !== "object" ||
      (marker.pin as BlueprintPin).draftVersion !== (boundary === "diagnostic" ||
        boundary === "replacement" ? version : version - 1) ||
      (boundary !== "review" ? marker.nextDraftDigest !== null :
        typeof marker.nextDraftDigest !== "string" || !HASH.test(marker.nextDraftDigest)) ||
      ![marker.writerTranscriptDigest, marker.reviewerTranscriptDigest]
        .every(value => typeof value === "string" && HASH.test(value)) ||
      ![marker.writerTranscriptBytes, marker.reviewerTranscriptBytes]
        .every(value => Number.isSafeInteger(value) && (value as number) > 0))
    throw Error("Causal blueprint budget-pause marker is invalid or ambiguous.");
  // A prior safe pause cannot be used to replay a turn that subsequently
  // started and crashed. Neither transcript may have gained even one byte
  // beyond the exact stopped boundary.
  for (const [file, size, digest] of [
    [(marker.pin as BlueprintPin).plannerSessionFile,
      marker.writerTranscriptBytes, marker.writerTranscriptDigest],
    [(marker.pin as BlueprintPin).reviewerSessionFile,
      marker.reviewerTranscriptBytes, marker.reviewerTranscriptDigest],
  ] as Array<[string, number, string]>) {
    await transcript(job, file, file === (marker.pin as BlueprintPin).plannerSessionFile
      ? (marker.pin as BlueprintPin).plannerSessionId
      : (marker.pin as BlueprintPin).reviewerSessionId,
    file === (marker.pin as BlueprintPin).plannerSessionFile
      ? "architecture-blueprint-sessions" : "architecture-blueprint-review-sessions");
    const bytes = await readFile(file);
    if (bytes.length !== size ||
        createHash("sha256").update(bytes).digest("hex") !== digest)
      throw Error("Causal blueprint Pi session changed after its safe budget pause; inspect instead of replay.");
  }
  for (const name of await readdir(root(job))) {
    const match = new RegExp("^plan-" + escaped +
      "-(draft|patch|verdict|review-session|convergence)-([0-9]+)\\.json$").exec(name);
    if (match && (Number(match[2]) > version ||
        (Number(match[2]) === version &&
          (boundary === "writer" ||
            (boundary === "review" && !["draft", "patch"].includes(match[1]!))))))
      throw Error("Causal blueprint progressed beyond the last safe pause; inspect instead of replay.");
  }
  const diagnosisBoundary = boundary === "diagnostic" || boundary === "replacement";
  const verified = await readRecordedBlueprint(job, plan, snapshot, provider, model, task, head,
    marker.pin as BlueprintPin, diagnosisBoundary);
  if (!verified || verified.pin.schema !== "noveltea-approved-blueprint/v4" ||
      verified.rounds.at(-1)?.verdict.status !== "revise" ||
      (!diagnosisBoundary && existsSync(verdictPath(job, plan.version, version))) ||
      (diagnosisBoundary && !existsSync(verdictPath(job, plan.version, version))))
    throw Error("Causal blueprint budget pause does not end at a sealed negative verdict.");
  if (diagnosisBoundary) {
    const sources = await obligationSources(job, plan, task);
    const cycleId = verified.pin.reviewCycleId!;
    const original = await safeRead(reviewSessionPath(job, plan.version, version), root(job)) as
      { sessionId: string };
    const diagnosis = await readDiagnosis(job, plan, version, cycleId,
      verified.rounds, sources, original.sessionId, verified.pin.plannerSessionId);
    if ((boundary === "diagnostic" && diagnosis) ||
        (boundary === "replacement" && (!diagnosis || diagnosis.diagnosis.action !== "replace" ||
          existsSync(replacementPath(job, plan.version, version)))))
      throw Error("Causal Blueprint diagnostic pause no longer matches the sealed action.");
  }
  let nextDraft: CausalBlueprint | undefined;
  let nextPatch: unknown;
  if (boundary === "writer") {
    if (existsSync(draftPath(job, plan.version, version)) ||
        existsSync(patchPath(job, plan.version, version)))
      throw Error("Causal blueprint writer progressed beyond its safe pause; inspect Pi evidence.");
  } else if (boundary === "review") {
    nextPatch = await safeRead(patchPath(job, plan.version, version), root(job));
    nextDraft = applyBlueprintPatch(verified.blueprint, verified.rounds.at(-1)!.verdict, nextPatch).blueprint;
    const stored = await safeRead(draftPath(job, plan.version, version), root(job));
    if (sha(stored) !== marker.nextDraftDigest || sha(nextDraft) !== marker.nextDraftDigest)
      throw Error("Causal blueprint paused draft does not match its sealed source patch.");
  }
  const outline = parseBlueprintOutline(JSON.stringify(
    await safeRead(outlinePath(job, plan.version), root(job))));
  const manifest = await safeRead(obligationsPath(job, plan.version), root(job)) as BlueprintObligations;
  const stages = await safeRead(stagesPath(job, plan.version), root(job)) as {
    schema: "noveltea-blueprint-stages/v3"; headerDigest: string; beatDigests: string[];
    coreDigest: string; routesDigest: string; outlineDigest: string; evidenceDigests: string[];
  };
  const initial = parseCausalBlueprint(JSON.stringify(
    await safeRead(draftPath(job, plan.version, 0), root(job))));
  return { ...verified, boundary, nextVersion: version, nextDraft, nextPatch,
    outline, manifest, stages, initial };
}

/** This inspection is read-only. Graph reconciliation can admit only an
 * authenticated, sealed budget boundary, not arbitrary incomplete Pi work. */
export async function inspectPausedBlueprint(job: JobStartResult, plan: Plan,
  snapshot: SkillSnapshot, provider: string, model: string, task: string, head: string):
  Promise<{ boundary: "planner-admission" | "initial-review" | BlueprintPause["boundary"]; nextVersion: number } | null> {
  const paused = await readPausedBlueprint(job, plan, snapshot, provider, model, task, head);
  if (paused) return { boundary: paused.boundary, nextVersion: paused.nextVersion };
  const initial = await readInitialReviewPause(job, plan, snapshot, provider, model, task, head);
  if (initial) return { boundary: "initial-review", nextVersion: 0 };
  return await readPlannerAdmissionPause(job, plan, snapshot, provider, model, task, head)
    ? { boundary: "planner-admission", nextVersion: 0 } : null;
}

/** A reviewer must be a separate read-only Pi session. All prompts and source
 * readers use the pinned sandbox; no model has authority to write Story bytes. */
async function sessionFor(
  job: JobStartResult, snapshot: SkillSnapshot, provider: string, model: string,
  step: string, directory: string,
  resumeSession?: { file: string; id: string },
) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [],
    requiredSkills: ["nt-story-architecture", "nt-catalog"],
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-story-architecture", "nt-catalog"].every(name =>
        skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Causal blueprint session lacks pinned skills.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    // Context reuse is keyed by group, not by step. Each independent reviewer
    // must have a unique group, even though transcripts share a directory.
    // Otherwise preparePiContext reopens the prior reviewer's same Pi session,
    // violating independent critique and approved-pin provenance.
    group: step, step, paths: [], snapshot: snapshot.id, provider, model,
    directory: join(job.stateDir, directory), resumeSession,
    // Planning and review happen before canonical writing: each model call
    // must honor normal job budget gates rather than the in-writer exemption.
  }, runtime);
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "specialist");
  // Apply the last budget gate BEFORE creating a new Pi session. A safe
  // initial-review pause must never strand an unpinned, ambiguous reviewer.
  await context.beforeTurn(context.manager.getSessionFile() ?? undefined);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: safeTools ?? [],
    noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  if (context.thinking && session.thinkingLevel !== context.thinking) {
    session.dispose();
    throw Error("Causal blueprint session changed the pinned thinking effort.");
  }
  const file = session.sessionManager.getSessionFile();
  if (!file) { session.dispose(); throw Error("Causal blueprint requires persistent Pi transcript."); }
  return { project, session, file, context };
}
function verifyReadSources(messages: Parameters<typeof completedPinnedSkillReads>[0],
  project: string, snapshot: SkillSnapshot) {
  const reads = completedPinnedSkillReads(messages, project, snapshot.path);
  const expected = [join(project, "creative-direction/foundation.md"),
    ...REQUIRED_SKILLS.map(path => join(snapshot.path, "skills", path))];
  if (expected.some(path => !reads.includes(path)))
    throw Error("Causal blueprint agent did not read Creative Direction and both required pinned skills.");
}
function lastText(session: Awaited<ReturnType<typeof sessionFor>>["session"]) {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || last.role !== "assistant" || ["aborted", "error"].includes(last.stopReason))
    throw Error("Causal blueprint Pi session was interrupted; preserve original transcript.");
  return session.getLastAssistantText() ?? "";
}
export function blueprintOutlinePrompt(plan: Plan, task: string) {
  return (
    "You are the NovelTea READ-ONLY CAUSAL STORY ARCHITECT. " +
    "First use read to inspect skill://nt-story-architecture/SKILL.md, " +
    "skill://nt-catalog/SKILL.md, creative-direction/foundation.md. No writing or shell. " +
    "Plan the COMPLETE Arc as a COMPACT CAUSAL OUTLINE, not canonical Story records. " +
    "A PROVISIONAL DESIGN MUST ANSWER THE MYSTERY: name who did what, the " +
    "specific mechanism, why that act advanced the motive, any deception's " +
    "actual false inference, and how independent future inspectable facts " +
    "would test each conclusion. The original Creative Direction does NOT " +
    "need to name the culprit first: invent a coherent possible answer as " +
    "proposed FICTION, not as already-authored or canonically verified Fact. " +
    "Never defer the culprit, act, mechanism, motive or answer to later " +
    "Events, later authorship or independent review. Review will test your " +
    "provisional solution, not supply it. " +
    "This is a new Story with only Creative Direction Foundation. " +
    "Carry all approved author promises, including the WHAT, WHEN, WHO, HOW, WHY " +
    "questions the source actually promises, each meaningful player Choice and " +
    "its distinct lasting alternatives, refused/cooperative paths, material " +
    "relationships, route reconvergence and final resolution. Avoid filler. " +
    "Trace the core resolution backward through named future inspectable " +
    "events without claiming uncreated evidence is already canon. " +
    "Do not confuse finding an intermediate location with resolving a disappearance. " +
    "Do not claim a mechanism or motive solely from access or a changed object. " +
    "Only a SHORT causal header is requested NOW: beat prose/decisions, " +
    "route-state rows, evidence observations and source obligations are collected " +
    "later in SEPARATE small prompts. Fix the causal answer and ordered beat IDs " +
    "now; no later stage can change them. " +
    "PERSISTENT CHOICE-STATE RULE: for EVERY alternative, state the specific " +
    "knowledge, inspectable evidence access, relationship trust or source exposure " +
    "it gains, withholds, preserves or irreversibly loses. Use concrete named " +
    "accounts, records and people in this story, not vague possible risks, " +
    "generic route ledgers or promises that differences will be tracked later. " +
    "For each Choice explicitly carry these DIFFERENT states into its downstream " +
    "beat purposes/changes and the final supported ending AFTER route convergence. " +
    "If a witness is asked, they can REFUSE, be unavailable or withdraw: include " +
    "that outcome, its actual trust/exposure cost and an inspectable independent " +
    "fallback that does not pretend their answer was given. " +
    "If disclosure endangers a person, state the checkable threat mechanism " +
    "and HOW this disclosure exposes them; a protected route never has to " +
    "reveal their identity. No Choice may guarantee cooperation or magically " +
    "restore access after refusal. Conditional events need explicit fallback. " +
    "If the author specifies a play-duration target, account for a PLAUSIBLE " +
    "single first-playthrough path: substantive reading and investigation load, " +
    "approximate beat durations and exclusive alternatives, not multiplying all " +
    "branch lengths or padding a record quota. Put that in beat purpose/change " +
    "where relevant; do not add schema fields. " +
    "Use 2–16 beats and the full authorized objective and scope. " +
    "APPROVED CONTRACT: " +
    JSON.stringify(plan.contract) +
    "\\nORIGINAL AUTHOR TASK: " +
    JSON.stringify(task) +
    "\\nReturn ONLY ONE compact valid JSON object, no code fences or prose, " +
    "with EXACT root keys schema,premise,beatIds,resolution,causalAnswer. " +
    "schema is noveltea-causal-outline-header/v1. beatIds is an ordered array " +
    "of 2–16 UNIQUE lowercase beat slugs, in causal dependency order; " +
    "resolution.supportedBy and causalAnswer.proof.beatIds refer to those IDs. " +
    "Do NOT emit beat objects, decisions, observations or routeConsequences. " +
    "A later stage will give every beat its purpose, dependencies, change " +
    "and concrete decisions/alternatives (or decisions:[] for narrative beats). " +
    "Resolution has question,conclusion,supportedBy (beat ids),uncertainty. " +
    "causalAnswer has EXACT keys question,answer,mechanism,responsibility,motive," +
    "misdirection,proof. question/answer/mechanism/responsibility/motive are " +
    "nonempty concrete strings; do not describe an unresolved placeholder. " +
    "misdirection has EXACT keys signal,falseInference,actualExplanation; " +
    "say 'none' for all three when no misdirection is promised. If there " +
    "IS misdirection, name the exact signal, the WRONG belief it creates " +
    "and the actual explanation. proof has EXACT keys directTest,corroboration," +
    "refusalFallback,beatIds; identify physical/documents/source observations " +
    "the player could eventually inspect, independent cross-checks and what " +
    "REMAINS AVAILABLE when a witness refuses (or no witness is involved). " +
    "All proof beatIds must appear in resolution.supportedBy. " +
    "Do NOT include routeConsequences now: a separate JSONL stage " +
    "will enumerate the earned/foregone state of every alternative AFTER " +
    "the compact beat batches define them. Keep the header short, preferably " +
    "under 4KB, with no long repetitive beat prose. " +
    "The final proof is not approved until independent review. " +
    "Check every string and closing brace before responding."
  );
}
export function blueprintBeatPrompt(
  header: BlueprintOutlineHeader, earlier: BlueprintOutlineBeat[], first: number,
) {
  const ids = header.beatIds.slice(first, first + BEAT_BATCH_SIZE);
  return (
    "READ-ONLY CAUSAL BEAT DETAIL STAGE. The short causal header and all " +
    "earlier accepted beats are FIXED and may not be rewritten. " +
    "Define ONLY the " + ids.length + " requested beats, with one compact " +
    "complete JSON object PER LINE (JSONL), in the EXACT requested ID order. " +
    "Each line must have EXACT keys id,purpose,dependsOn,change,decisions. " +
    "id is the requested slug. dependsOn is an array of only EARLIER beat IDs, " +
    "not future or invented IDs. purpose states a concrete role in the planned " +
    "mystery; change explains what the player gains, learns, loses or changes " +
    "by completing the beat. decisions is [] if no Choice occurs; otherwise " +
    "each decision has EXACT keys question,alternatives and 2 or more materially " +
    "distinct alternatives with EXACT action,lastingEffect keys. Protect refusal " +
    "paths and confidentiality, specify durable access/trust/exposure differences, " +
    "and show how later beats can use independent records if a witness refuses. " +
    "Do NOT defer the culprit, mechanism, intent, proof or promised route outcomes; " +
    "they are proposed in the fixed causal header. Describe substantive reading " +
    "and investigation where the approved playthrough needs it, but do not " +
    "sum mutually exclusive routes. No evidence observations yet. " +
    "Do not include any other beat, full outline, code fence, wrapper or prose. " +
    "EXACT REQUESTED BEAT IDS: " + JSON.stringify(ids) +
    "\\nFIXED CAUSAL HEADER: " + JSON.stringify(header) +
    "\\nALREADY ACCEPTED EARLIER BEATS: " + JSON.stringify(earlier)
  );
}

export function blueprintRoutesPrompt(core: BlueprintOutlineCore) {
  const required = requiredBlueprintRouteChoices(core);
  return (
    "READ-ONLY CAUSAL ROUTE-STATE STAGE. The causal answer and beat graph " +
    "are already validated and FIXED. Do not change any question, action, " +
    "lastingEffect, beat ID, dependency, mechanism or resolution. " +
    "Provide EXACTLY " + required.length + " separate compact JSONL objects, " +
    "one line for EACH indexed alternative in the following EXACT order. " +
    "Never include an alternative twice or skip one. Each line has EXACT keys " +
    "beatId,decisionIndex,alternativeIndex,laterBeatId,preserved,foregone," +
    "persistentEffect. Use zero-based decisionIndex and alternativeIndex. " +
    "laterBeatId must be a reachable strictly LATER dependent beat ID " +
    "or 'resolution' for an ending alternative. preserved and foregone name " +
    "specific inspectable evidence, access, trust, confidentiality, or exposure " +
    "retained/lost on that route. persistentEffect names the precise downstream " +
    "consequence and must be distinct for materially different alternatives; " +
    "don't promise a generic ledger. Refusal permanently withholds testimony; " +
    "a protected witness cannot be silently exposed after reconvergence. " +
    "No code fences, enclosing array, prose, duplicate lines or blank lines. " +
    "EXACT REQUIRED ALTERNATIVES: " + JSON.stringify(required) +
    "\\nIMMUTABLE CAUSAL CORE: " + JSON.stringify(core)
  );
}

export function blueprintEvidencePrompt(outline: BlueprintOutline, first: number) {
  const batch = outline.beats.slice(first, first + EVIDENCE_BATCH_SIZE);
  return (
    "READ-ONLY CAUSAL BLUEPRINT EVIDENCE STAGE. The outline below is " +
    "FIXED; do not rewrite its beats, decisions, alternatives, ending or IDs. " +
    "For ONLY the listed beats, plan what future evidence the player can " +
    "actually inspect. Separate an evidence source, directly observable fact, " +
    "supported inference and the limits of that inference. Do not infer WHEN " +
    "from undated objects, WHO from mere access, WHY from opportunity, or HOW " +
    "without a direct test. Preserve independent corroboration on any refused " +
    "witness route, and the lasting consequences of all preceding choices. " +
    "For EVERY earlier player alternative, show what can still be inspected " +
    "on that route and what testimony, source access or trust has been lost. " +
    "A request for testimony NEVER guarantees cooperation; specify a refusal " +
    "outcome and independent evidence that still permits justified conclusions. " +
    "No evidence at a reconverged beat may silently restore withheld accounts " +
    "or treat a suspect's reaction as independently corroborated proof. " +
    "For WHO or HOW, distinguish source custody or opportunity from an " +
    "inspectable causal link to the act and tested mechanism. For WHY, name " +
    "an inspectable, independently corroborated link between the ACT and the " +
    "INTENDED outcome, not a stake, benefit or suspect explanation alone; " +
    "otherwise leave motive explicitly uncertain. If a person faces exposure " +
    "from testimony, make the threat and disclosure-to-exposure link checkable " +
    "while keeping the protected route private. Specify concrete alternate " +
    "evidence, not merely that a dossier will cross-check it. " +
    "Empty observations are allowed for pacing beats without inspectable clues, " +
    "but the overall resolution MUST have an evidence-bearing supported beat. " +
    "These are FUTURE authoring commitments, not existing canonical facts. " +
    "Return exactly " +
    batch.length +
    " standalone compact JSON object" +
    (batch.length === 1 ? "" : "s") +
    ", ONE PER LINE, in order. " +
    "Each line has EXACT keys id and observations, with id from the batch. " +
    "observations is an array (maximum 8) of objects with EXACT keys " +
    "source,observable,supports,limits, all nonempty strings. " +
    "No code fences, enclosing array, text, extra braces or blank lines. " +
    "Do not weaken or contradict the outlined concrete causalAnswer or " +
    "any indexed routeConsequences. If the proposed mechanism is a physical " +
    "act, an independent observation must actually distinguish its method " +
    "from accidental coincidence. Do not substitute a generic promise of " +
    "a later clue or confession for the specified evidence. " +
    "COMPLETE IMMUTABLE OUTLINE: " +
    JSON.stringify(outline) +
    "\\nTHIS BATCH: " +
    JSON.stringify(batch.map((beat) => beat.id))
  );
}
function blueprintObligationsPrompt(plan: Plan, task: string, blueprint: CausalBlueprint,
  sources: ObligationSources) {
  return "READ-ONLY SOURCE-GROUNDED CAUSAL OBLIGATION INVENTORY. " +
    "The causal blueprint below is already STRUCTURALLY VALIDATED, and FIXED. " +
    "Inventory EACH concrete promise of the actual approved Creative Direction " +
    "and author task that the eventual Story must prove, including separately " +
    "promised WHAT, WHEN, WHO, HOW, WHY, protected Choice consequences, refusal " +
    "routes and ending outcomes. Do not invent extra author requirements. " +
    "Each obligation must cite an 8–40-character EXACT CONTIGUOUS substring " +
    "of the source specified by source:foundation,task,contract. " +
    "Copy case, punctuation and whitespace exactly from the SOURCE TEXT BELOW; " +
    "do not combine disconnected words or write a paraphrase as a quote. " +
    "Quote the shortest source fragment that identifies a real promise. " +
    "Include one or more EXISTING beat IDs that must fulfill the proof. " +
    "1–20 separate lines, each exactly ONE compact valid JSON object with " +
    "EXACT keys id,category,source,quote,question,proof,route,beatIds. " +
    "category is what|when|who|how|why|consequence|route|other. " +
    "source is foundation|task|contract. Use lowercase slug IDs. " +
    "Do not include wrapper, enclosing array, markdown, extra braces, " +
    "blank lines, explanations or any change to the blueprint. " +
    "\\nEXACT FOUNDATION SOURCE: " + JSON.stringify(sources.foundation) +
    "\\nEXACT AUTHOR TASK SOURCE: " + JSON.stringify(task) +
    "\\nEXACT CONTRACT JSON SOURCE: " + JSON.stringify(plan.contract) +
    "\\nIMMUTABLE FULL BLUEPRINT: " + JSON.stringify(blueprint);
}
function reviewPrompt(
  plan: Plan,
  blueprint: CausalBlueprint,
  obligations: BlueprintObligations,
  task: string,
  outline: BlueprintOutline,
  prior: readonly (ReviewRound & { patch?: unknown })[],
  sourceChanges?: unknown,
) {
  return (
    "You are an INDEPENDENT, READ-ONLY CAUSAL ARCHITECTURE BLUEPRINT REVIEWER. " +
    "Read skill://nt-story-architecture/SKILL.md, skill://nt-catalog/SKILL.md, " +
    "creative-direction/foundation.md. No writing, shell, approval or expansion of scope. " +
    "Compare the proposed plan with approved author objective and hard constraints. " +
    "Inspect every dependency and what each observation could prove. Specifically " +
    "catch unsupported time/identity/intent inferences, skipped disappearance " +
    "resolution, unreachable evidence when player refuses cooperation, " +
    "decisions with unmodeled alternative consequences, and inconsistencies " +
    "after reconvergence. Planned plausible future evidence need not already " +
    "exist in canonical Event/Fact files. Do not impose generic plot preferences. " +
    "If a concrete causal answer was proposed in the outline, test whether " +
    "the final resolution and actual evidence now support THAT named mechanism, " +
    "responsibility, motive and any signal's specific false inference. " +
    "Do not permit a generic promise to fill those facts later. Check each " +
    "indexed Choice-route state against the actual downstream beat and ending, " +
    "including earned and forever unavailable evidence after convergence. " +
    "The provisional outline is not author canon or independent proof. " +
    "Check every source-quoted obligation against the actual approved Creative " +
    "Direction, author task, the scope and all supported/refused routes. " +
    "An obligation inventory can itself omit a promised outcome: report that " +
    "as a finding on the beat responsible for the missing proof, never approve " +
    "an incomplete inventory as exhaustive. Treat source-anchored obligations " +
    "as immutable during corrections, not as evidence that the fiction is true. " +
    "Every material decision alternative must have a concrete knowledge, " +
    "evidence-access, trust or exposure state that survives reconvergence. " +
    "Verify who refuses testimony, what remains independently inspectable " +
    "and whether downstream disclosure matches facts earned ON THAT ROUTE. " +
    "If scope promises duration, require a plausible single-playthrough " +
    "load estimate accounting for exclusive paths, not a repeated target. " +
    "Report ALL material fixable problems in one verdict (maximum 8). " +
    "Findings reference exact beat IDs and propose bounded changes within " +
    "the approved story premise. Approval only means a coherent provisional plan; " +
    "later authored Story content must pass independent checks separately. " +
    "Source contract: " +
    JSON.stringify(plan.contract) +
    "\nOriginal author task: " +
    JSON.stringify(task) +
    "\nIMMUTABLE SOURCE-GROUNDED PROOF OBLIGATIONS:\n" +
    JSON.stringify(obligations) +
    "\nPROVISIONAL SOURCE-BOUND OUTLINE AND ROUTE STATES:\n" +
    JSON.stringify(outline) +
    "\nFULL MERGED BLUEPRINT JSON:\n" +
    JSON.stringify(blueprint) +
    (prior.length ? "\nTHIS IS A CONTINUATION OF YOUR OWN INDEPENDENT REVIEW, NOT A " +
      "NEW REVIEWER. RE-READ pinned sources and methodology in THIS turn. " +
      "Account for EVERY prior material finding (including historically resolved " +
      "ones that may have regressed), using original round/index and a concrete " +
      "quote in the CURRENT relevant beat, causal descendant, or supported resolution field. Status is " +
      "resolved, improved, persisting or regressed. A changed draft, more words, " +
      "a new finding or mere assurance does NOT prove improvement. Cite the " +
      "actual new or altered evidence/route consequence that materially " +
      "addresses an earlier blocker; a justified resolution-only correction " +
      "may cite its exact changed conclusion, uncertainty, or supportedBy. " +
      "Distinguish newly introduced from " +
      "previously overlooked blockers, and identify continuing ones. " +
      "Do not drop older findings simply because a newer one appears. " +
      "\nHISTORICAL SOURCE-BOUND VERDICTS (round, digest, verdict, applied patch): " +
      JSON.stringify(prior.map((item, round) => ({ round,
        blueprintDigest: sha(item.blueprint), verdict: item.verdict,
        patch: item.patch ?? null }))) +
      "\nPREVIOUS REVIEWED BLUEPRINT DIGEST: " + sha(prior[prior.length - 1]!.blueprint) +
      "\nPREVIOUS VERIFIED VERDICT: " + JSON.stringify(prior[prior.length - 1]!.verdict) +
      "\nEXACT SOURCE CHANGES: " + JSON.stringify(sourceChanges) +
      "\nNEW REVIEWED BLUEPRINT DIGEST: " + sha(blueprint) : "") +
    "\n" +
    "Return ONLY strict JSON with exact keys schema,status,findings,prior. " +
    "schema is noveltea-blueprint-review/v2. " +
    "status pass requires findings:[]; revise requires 1–8 material findings. " +
    "Each finding has EXACT keys beatId,reason,correction,requirement,evidence,origin. " +
    "requirement is {source:foundation|task|contract,quote:exact 8+ character " +
    "substring of that authorized source}. evidence is {beatId:the finding beat, " +
    "quote:exact 8+ character substring of the CURRENT beat}, or " +
    "{beatId:resolution,field:conclusion|uncertainty|supportedBy,quote:exact " +
    "current resolution-field substring} when the finding concerns its " +
    "supported conclusion. origin is " +
    "initial (first review only), continuing, introduced (new in corrected " +
    "source), or overlooked (present but missed earlier). No optional tastes. " +
    "prior is an array with ONE item for EVERY historical finding, ordered by " +
    "round then findingIndex, or [] on the first review. Each item has EXACT " +
    "keys round,findingIndex,status,reason,evidence. status is resolved, " +
    "improved, persisting or regressed; evidence has beatId and exact current " +
    "beat quote, from the original finding beat or its causal descendant, " +
    "or a supported resolution-field citation using field and exact quote. " +
    "A final pass still needs all historical assessments and the full current " +
    "source-grounded contract reviewed independently."
  );
}

function blueprintCorrectionPrompt(blueprint: CausalBlueprint, verdict: BlueprintReview,
  outline: BlueprintOutline) {
  return "INDEPENDENT CAUSAL REVIEW. The original blueprint and immutable " +
          "source-derived proof obligation manifest remain fixed; do not rewrite them. " +
          "Return ONLY STRICT JSON LINES (JSONL), no enclosing array or wrapper. " +
          "LINE ONE is a complete compact JSON header object with EXACT keys " +
          "{schema:'noveltea-blueprint-patch/v1',baseDigest:string,reviewDigest:string}. " +
          "EACH FOLLOWING LINE is exactly one complete JSON operation object. " +
          "No blank lines, markdown fences, leading or trailing prose. " +
          "Each operation must name findingBeatId, an exact " +
          "beat ID from the review; target only that beat or a causal dependent. " +
          "findingBeatId is the REVIEWER'S SOURCE finding ID, NOT the target's " +
          "beatId. E.g. when a pacing finding at first beat A requires edits " +
          "at descendant beat B, use findingBeatId:A with beatId:B; NEVER " +
          "invent findingBeatId:B unless B appears among the verdict findings. " +
          "EXACT permitted finding-to-target mapping: " +
          JSON.stringify(allowedBlueprintPatchTargets(blueprint, verdict)) + ". " +
          "Kinds: replace {findingBeatId,path,expected,value} for exact old text " +
          "at beats/ID/purpose, beats/ID/change, " +
          "beats/ID/observations/INDEX/source|observable|supports|limits, " +
          "beats/ID/decisions/INDEX/alternatives/INDEX/lastingEffect, or " +
          "resolution/conclusion|uncertainty; append-observation " +
          "{findingBeatId,beatId,value:{source,observable,supports,limits}}; " +
          "append-decision {findingBeatId,beatId,value:{question,alternatives}}; " +
          "add-dependency {findingBeatId,beatId,dependsOn:earlierBeatId}; " +
          "insert-beat {findingBeatId,afterBeatId,beat:completeNewBeat}; " +
          "support-resolution {findingBeatId,beatId}. Every operation also has " +
          "kind. Example TWO separate JSONL lines (not a JSON array):\n" +
          JSON.stringify({ schema: "noveltea-blueprint-patch/v1",
            baseDigest: sha(blueprint), reviewDigest: sha(verdict) }) + "\n" +
          JSON.stringify({ kind: "replace", findingBeatId: verdict.findings[0]!.beatId,
            path: "beats/" + verdict.findings[0]!.beatId + "/change",
            expected: "exact old text", value: "new corrected text" }) + "\n" +
          "Replace placeholders with actual old/new source text and add one " +
          "operation per further line. Validate that EACH line parses as " +
          "standalone JSON; never append a second closing brace after any line. " +
          "To refine an existing Choice lastingEffect, the new text MUST " +
          "contain the entire old lastingEffect unmodified; no old decision " +
          "or alternative may be erased. New beat IDs must be unique. " +
          "Never replace the premise, original question, decision action, " +
          "protected author outcome, unrelated clue or entire list. " +
          "PATCH COMPLETENESS CHECK: address EVERY independent finding " +
          "with named inspectable evidence or an exact durable alternative " +
          "state, not a statement that a ledger will later track choices. " +
          "When review identifies unmodeled Choice consequences, extend EACH " +
          "affected alternative's lastingEffect via exact replace without " +
          "erasing its old text, AND amend dependent beat changes or evidence " +
          "to consume those specific gained/lost facts, trust or access. " +
          "Never restore refused testimony, hidden context or a damaged " +
          "relationship at reconvergence. For motives, support intent with " +
          "independently inspectable act-to-intended-outcome evidence rather " +
          "than a stake alone; if no support exists, keep the claim uncertain. " +
          "A claimed first-playthrough duration needs plausible reading and " +
          "investigation load on one supported route, excluding alternate " +
          "branches; no invented padding. Before returning, compare the " +
          "entire merged design to EACH review finding, including any " +
          "interactions between your operations. " +
          "Fix the causal findings and preserve all prior supported proof " +
          "including under refused routes. The independently reviewed FULL " +
          "merged design must still satisfy every original obligation. " +
          "The original proposed causalAnswer and indexed routeConsequences " +
          "must remain accounted for in the merged Story design; do not replace " +
          "an omitted cause with a vague promise to decide it later. " +
          "PROVISIONAL CAUSAL ANSWER: " +
          JSON.stringify(outline.schema === "noveltea-causal-outline/v2" ?
            outline.causalAnswer : null) +
          " BASE DIGEST: " + sha(blueprint) + " REVIEW DIGEST: " + sha(verdict) +
          " FINDINGS: " + JSON.stringify(verdict.findings);
}

/** A diagnosis is an independent read-only opinion, not a substitute for a
 * current verdict. Seal the exact source and transcript before acting. */
async function performBlueprintDiagnosis(job: JobStartResult, snapshot: SkillSnapshot,
  plan: Plan, provider: string, model: string, task: string, cycleId: string,
  rounds: readonly ReviewRound[], sources: ObligationSources, trigger: DiagnosticTrigger,
  writer: { id: string; file: string }, reviewer: { id: string; file: string },
  patches: readonly unknown[]): Promise<BlueprintDiagnosticReceipt> {
  const version = rounds.length - 1;
  const saved = await readDiagnosis(job, plan, version, cycleId, rounds, sources,
    reviewer.id, writer.id);
  if (saved) return saved;
  const fingerprint = diagnosticCaseFingerprint(cycleId,
    rounds.at(-1)!.blueprint, rounds.at(-1)!.verdict, sources);
  for (let earlier = 0; earlier < version; earlier++) {
    const path = diagnosticPath(job, plan.version, earlier);
    if (!existsSync(path)) continue;
    const historical = await safeRead(path, root(job)) as BlueprintDiagnosticReceipt;
    if (historical.caseFingerprint === fingerprint)
      throw Error("Diagnostic review requires author-guided escalation for identical source evidence.");
  }
  const diagnosisSession = await sessionFor(job, snapshot, provider, model,
    "blueprint-diagnostic:" + cycleId + ":" + version,
    "architecture-blueprint-diagnostic-sessions");
  try {
    if ([writer.id, reviewer.id].includes(diagnosisSession.session.sessionId) ||
        [writer.file, reviewer.file].includes(diagnosisSession.file))
      throw Error("Diagnostic reviewer is not independent of the Review cycle.");
    const start = diagnosisSession.session.messages.length;
    await promptStorySpecialist(diagnosisSession.session,
      diagnosisSession.context.contextNote +
      "INDEPENDENT, READ-ONLY CAUSAL BLUEPRINT DIAGNOSTIC REVIEW. " +
      "Read skill://nt-story-architecture/SKILL.md, skill://nt-catalog/SKILL.md " +
      "and creative-direction/foundation.md. No writing, approval, shell or tools " +
      "outside the pinned read-only source readers. " +
      "Assess material current-stage defects versus downstream implementation " +
      "requests, cosmetic tastes, reviewer goalpost drift, genuine regression and " +
      "excessively broad scope. Do not presume that the persistent reviewer is " +
      "right or wrong; judge the exact actual current source and accepted task. " +
      "A replacement reviewer requires a NEW INDEPENDENT, CURRENT verdict; " +
      "your diagnosis NEVER approves, waives a sealed failure, changes the " +
      "author's protected decisions, or authorizes any expanded writes. " +
      "Recommend continue for a bounded further correction, replace for a fresh " +
      "independent reviewer, split for authorized replanning, or escalate for " +
      "unresolved authority/scope disputes. " +
      "TRIGGER: " + trigger +
      "\\nCYCLE ID: " + cycleId +
      "\\nFOUNDATION SOURCE: " + JSON.stringify(sources.foundation) +
      "\\nTASK SOURCE: " + JSON.stringify(task) +
      "\\nACCEPTED CONTRACT: " + JSON.stringify(plan.contract) +
      "\\nPAST VERDICTS AND CORRECTIONS (historical, immutable): " +
      JSON.stringify(rounds.map((round, i) => ({
        round: i, draftDigest: sha(round.blueprint),
        verdict: round.verdict, patch: patches[i] ?? null,
      }))) +
      "\\nCURRENT EXACT BLUEPRINT: " + JSON.stringify(rounds.at(-1)!.blueprint) +
      "\\nReturn ONLY strict JSON {schema:'noveltea-blueprint-diagnosis/v1'," +
      "action:'continue|replace|split|escalate',explanation:string," +
      "assessments:[{kind:'material|deferred|cosmetic|scope',reason:string," +
      "requirement:{source:'foundation|task|contract',quote:exact 8+ character " +
      "source substring},evidence:{beatId:string,quote:exact 8+ character current " +
      "beat substring}}]}. A resolution evidence citation may instead use " +
      "{beatId:'resolution',field:'conclusion|uncertainty|supportedBy',quote:string}. " +
      "Each assessment must cite real current work and an actual accepted source. " +
      "Do not output a pass/fail verdict or invent new acceptance requirements.");
    const parse = () => {
      verifyReadSources(diagnosisSession.session.messages.slice(start),
        diagnosisSession.project.root, snapshot);
      return parseBlueprintDiagnosis(lastText(diagnosisSession.session),
        rounds.at(-1)!.blueprint, sources);
    };
    let diagnosis: BlueprintDiagnosis;
    try { diagnosis = parse(); }
    catch (error) {
      await promptStorySpecialist(diagnosisSession.session,
        "CONTROLLER REJECTED DIAGNOSTIC RESPONSE: " +
        (error instanceof Error ? error.message : "invalid evidence") +
        ". This is format/source-read correction only, not a new semantic judgment. " +
        "Read required sources, preserve substantive conclusions and return " +
        "ONE complete strict diagnostic JSON response with exact citations.");
      diagnosis = parse();
    }
    await diagnosisSession.context.completed(diagnosisSession.file, diagnosisSession.session.sessionId);
    const bytes = await readFile(diagnosisSession.file);
    const receipt: BlueprintDiagnosticReceipt = {
      schema: "noveltea-blueprint-diagnostic-receipt/v1", cycleId,
      evidenceDigest: diagnosticEvidence(cycleId, rounds, sources),
      caseFingerprint: diagnosticCaseFingerprint(cycleId,
        rounds.at(-1)!.blueprint, rounds.at(-1)!.verdict, sources),
      trigger, draftDigest: sha(rounds.at(-1)!.blueprint),
      reviewDigest: sha(rounds.at(-1)!.verdict), reviewerSessionId: reviewer.id,
      diagnosis, sessionId: diagnosisSession.session.sessionId,
      sessionFile: diagnosisSession.file, transcriptBytes: bytes.length,
      transcriptDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    await immutable(diagnosticPath(job, plan.version, version), receipt);
    return receipt;
  } finally { diagnosisSession.session.dispose(); }
}

/** A replacement verdict never rewrites a negative judgment. A fresh Pi
 * conversation must independently inspect the current exact Blueprint. */
async function performBlueprintReplacement(job: JobStartResult, snapshot: SkillSnapshot,
  plan: Plan, provider: string, model: string, task: string, cycleId: string,
  rounds: readonly ReviewRound[], sources: ObligationSources,
  diagnosis: BlueprintDiagnosticReceipt, writer: { id: string; file: string },
  reviewer: { id: string; file: string }, obligations: BlueprintObligations,
  outline: BlueprintOutline, changes: unknown): Promise<{
    receipt: BlueprintReplacementReceipt;
    session: Awaited<ReturnType<typeof sessionFor>>;
  }> {
  const version = rounds.length - 1;
  if (diagnosis.diagnosis.action !== "replace")
    throw Error("Only an independently diagnosed reviewer replacement is permitted.");
  if (existsSync(replacementPath(job, plan.version, version)))
    throw Error("Completed replacement review must be resumed from its sealed writer boundary.");
  const fresh = await sessionFor(job, snapshot, provider, model,
    "blueprint-review-replacement:" + cycleId + ":" + version,
    "architecture-blueprint-review-sessions");
  try {
    if ([writer.id, reviewer.id, diagnosis.sessionId].includes(fresh.session.sessionId) ||
        [writer.file, reviewer.file, diagnosis.sessionFile].includes(fresh.file))
      throw Error("Replacement reviewer reused a writer, diagnostic or disputed review session.");
    const start = fresh.session.messages.length;
    await promptStorySpecialist(fresh.session,
      fresh.context.contextNote +
      "YOU ARE A FRESH, INDEPENDENT REPLACEMENT REVIEWER. " +
      "The previous negative verdict and diagnosis are historical evidence, " +
      "not a pass, permission to waive defects or a reason to agree. " +
      "Your source-bound current verdict must independently satisfy all " +
      "current-stage obligations. Return a normal v2 verdict after inspecting " +
      "the pinned sources and exact current Blueprint. " +
      "\\nDIAGNOSIS: " + JSON.stringify(diagnosis.diagnosis) +
      "\\n" + reviewPrompt(plan, rounds.at(-1)!.blueprint, obligations,
        task, outline, rounds, changes));
    const parse = () => {
      verifyReadSources(fresh.session.messages.slice(start), fresh.project.root, snapshot);
      const verdict = parseBlueprintReview(lastText(fresh.session),
        rounds.at(-1)!.blueprint);
      return evaluateReviewConvergence(verdict, rounds.at(-1)!.blueprint,
        rounds, sources, 0, true).review;
    };
    let verdict: ConvergentReview;
    try { verdict = parse(); }
    catch (error) {
      await promptStorySpecialist(fresh.session,
        "CONTROLLER REJECTED REPLACEMENT REVIEW PROTOCOL: " +
        (error instanceof Error ? error.message : "invalid reviewer evidence") +
        ". Re-read pinned sources, preserve your substantive assessment, " +
        "and return one complete source-grounded current v2 verdict.");
      verdict = parse();
    }
    await fresh.context.completed(fresh.file, fresh.session.sessionId);
    const bytes = await readFile(fresh.file);
    const receipt: BlueprintReplacementReceipt = {
      schema: "noveltea-blueprint-replacement-receipt/v1", cycleId,
      diagnosisDigest: sha(diagnosis),
      draftDigest: sha(rounds.at(-1)!.blueprint),
      reviewDigest: sha(rounds.at(-1)!.verdict), verdict,
      sessionId: fresh.session.sessionId, sessionFile: fresh.file,
      transcriptBytes: bytes.length,
      transcriptDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    await immutable(replacementPath(job, plan.version, version), receipt);
    return { receipt, session: fresh };
  } catch (error) { fresh.session.dispose(); throw error; }
}

/** A fail-closed, checkpointed original planner session, with independently
 * reviewed immutable versions and a final approved pin published last. */
export async function createReviewedBlueprint(job: JobStartResult, snapshot: SkillSnapshot,
  plan: Plan, provider: string, model: string, task: string, head: string): Promise<BlueprintPin> {
  const approved = await readApprovedBlueprint(job, plan, snapshot, provider, model, task, head);
  if (approved) return approved.pin;
  const paused = await readPausedBlueprint(job, plan, snapshot, provider, model, task, head);
  const initialPause = paused ? null :
    await readInitialReviewPause(job, plan, snapshot, provider, model, task, head);
  const plannerAdmissionPause = !paused && !initialPause &&
    await readPlannerAdmissionPause(job, plan, snapshot, provider, model, task, head);
  // Never quietly replay a partially executed planner or reviewer after crash.
  if (!paused && !initialPause && !plannerAdmissionPause && existsSync(root(job))) {
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(root(job))).some(name => name.startsWith("plan-" + plan.version + "-")))
      throw Error("Unfinished causal blueprint sessions/evidence exist; inspect rather than replay an ambiguous Pi plan.");
  }
  const sources = await obligationSources(job, plan, task);
  // Durable admission precedes the Pi SDK session creation. A process crash
  // in the sessionFor/started-receipt gap must never re-enter a new planner.
  if (!paused && !initialPause && !plannerAdmissionPause)
    await immutable(admittedPath(job, plan.version),
      sameLineage(job, plan, snapshot, provider, model, task, head));
  let planner: Awaited<ReturnType<typeof sessionFor>>;
  try {
    planner = await sessionFor(job, snapshot, provider, model,
      "blueprint:" + plan.version, "architecture-blueprint-sessions",
      paused ? { file: paused.pin.plannerSessionFile, id: paused.pin.plannerSessionId } :
        initialPause ? { file: initialPause.plannerSessionFile, id: initialPause.plannerSessionId } : undefined);
  } catch (error) {
    if (error instanceof PiBudgetPause && !paused && !initialPause && !plannerAdmissionPause)
      await immutable(plannerAdmissionPausePath(job, plan.version), {
        schema: "noveltea-blueprint-planner-admission-pause/v1",
        lineage: sameLineage(job, plan, snapshot, provider, model, task, head),
        step: "blueprint:" + plan.version, reason: error.reason,
      } satisfies PlannerAdmissionPause);
    throw error;
  }
  let reviewer: Awaited<ReturnType<typeof sessionFor>> | undefined;
  try {
    let initialBlueprint!: CausalBlueprint;
    let manifest!: BlueprintObligations;
    let outline!: BlueprintOutline;
    let stagesReceipt!: unknown;
    if (!paused && !initialPause) {
      // Even a crash before the first successful JSON result leaves durable evidence
      // of the begun Pi writer. Its session must not be silently replayed.
      await immutable(join(root(job), "plan-" + plan.version + "-started.json"), {
        ...sameLineage(job, plan, snapshot, provider, model, task, head),
        plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
      });
      const validatedStage = async <T>(name: string, parse: (text: string) => T,
        correction: string): Promise<T> => {
        verifyReadSources(planner.session.messages, planner.project.root, snapshot);
        try { return parse(lastText(planner.session)); }
        catch (error) {
          const reason = error instanceof Error ? error.message : "Invalid model output";
          await promptStorySpecialist(planner.session,
            "CONTROLLER REJECTED the " + name + " stage: " + reason + ". " +
            "Correct ONLY this stage, preserve all previously validated stages. " +
            correction + " Return the complete corrected stage, no prose or markdown. " +
            "Do not write Story files.");
          verifyReadSources(planner.session.messages, planner.project.root, snapshot);
          return parse(lastText(planner.session));
        }
      };
      await promptStorySpecialist(planner.session,
        planner.context.contextNote + blueprintOutlinePrompt(plan, task));
      const header = await validatedStage(
        "causal header",
        parseBlueprintOutlineHeader,
        "Return ONE short, fully closed causal-outline-header/v1 JSON object " +
          "with premise, beatIds, resolution and concrete causalAnswer. " +
          "Do not include full beat objects, decisions, observations or routes.",
      );
      await immutable(outlineHeaderPath(job, plan.version), header);
      const beats: BlueprintOutlineBeat[] = [];
      const beatDigests: string[] = [];
      for (let first = 0; first < header.beatIds.length; first += BEAT_BATCH_SIZE) {
        await promptStorySpecialist(planner.session, blueprintBeatPrompt(header, beats, first));
        const batch = await validatedStage(
          "causal beat batch " + first,
          text => parseBlueprintBeatBatch(text, header, first, beats),
          "Return ONLY " +
            Math.min(BEAT_BATCH_SIZE, header.beatIds.length - first) +
            " valid JSONL beat objects for these exact IDs, one per line: " +
            JSON.stringify(header.beatIds.slice(first, first + BEAT_BATCH_SIZE)) +
            ". Do not emit the header, earlier beats, future beats or an array.",
        );
        await immutable(outlineBeatPath(job, plan.version, first), batch);
        beats.push(...batch);
        beatDigests.push(sha(batch));
      }
      const core = assembleBlueprintOutlineCore(header, beats);
      await immutable(outlineCorePath(job, plan.version), core);
      const requiredRoutes = requiredBlueprintRouteChoices(core);
      let routeConsequences: BlueprintRouteConsequence[] = [];
      if (requiredRoutes.length) {
        await promptStorySpecialist(planner.session, blueprintRoutesPrompt(core));
        routeConsequences = await validatedStage(
          "Choice route consequences",
          text => parseBlueprintRouteStage(text, core),
          "Return ONLY " + requiredRoutes.length + " complete standalone JSONL rows, " +
            "one for EACH of these exact [beatId,decisionIndex,alternativeIndex] keys " +
            "IN ORDER: " + JSON.stringify(requiredRoutes.map(
              row => [row.beatId, row.decisionIndex, row.alternativeIndex])) +
            ". No duplicates, wrapper or omitted routes. Preserve the fixed causal core.",
        );
      }
      await immutable(outlineRoutesPath(job, plan.version), routeConsequences);
      outline = assembleCurrentBlueprintOutline(core, routeConsequences);
      await immutable(outlinePath(job, plan.version), outline);
      const evidence: BlueprintEvidence[] = [];
      const evidenceDigests: string[] = [];
      for (let first = 0; first < outline.beats.length; first += EVIDENCE_BATCH_SIZE) {
        await promptStorySpecialist(planner.session, blueprintEvidencePrompt(outline, first));
        const batch = await validatedStage("evidence batch " + first,
          text => parseBlueprintEvidence(text, outline, first),
          "Return ONLY the " +
          Math.min(EVIDENCE_BATCH_SIZE, outline.beats.length - first) +
          " requested evidence objects as valid JSONL, one per line, " +
          "with EXACT id and observations fields. " +
          "Every observation requires source,observable,supports,limits.");
        await immutable(evidencePath(job, plan.version, first), batch);
        evidence.push(...batch);
        evidenceDigests.push(sha(batch));
      }
      initialBlueprint = assembleBlueprintStages(outline, evidence);
      await promptStorySpecialist(planner.session,
        blueprintObligationsPrompt(plan, task, initialBlueprint, sources));
      manifest = await validatedStage("source obligations",
        text => parseBlueprintObligationStage(text, initialBlueprint, sources),
        "Return ONLY 1–20 standalone valid JSON obligation lines. " +
        "Every quote MUST be copied EXACTLY as a contiguous 8–40-character " +
        "substring of its corresponding source text from the previous prompt; " +
        "never fabricate or combine quotations, and reference existing beat IDs.");
      await immutable(obligationsPath(job, plan.version), manifest);
      await immutable(draftPath(job, plan.version, 0), initialBlueprint);
      stagesReceipt = {
        schema: "noveltea-blueprint-stages/v3",
        headerDigest: sha(header), beatDigests,
        coreDigest: sha(core), routesDigest: sha(routeConsequences),
        outlineDigest: sha(outline), evidenceDigests,
      };
      await immutable(stagesPath(job, plan.version), stagesReceipt);
    } else {
      const stored = paused ?? initialPause!;
      initialBlueprint = stored.initial;
      manifest = stored.manifest;
      outline = stored.outline;
      stagesReceipt = stored.stages;
    }
    let previous: { blueprint: CausalBlueprint; verdict: BlueprintReview } | undefined =
      paused?.rounds.at(-1);
    const reviewHistory: Array<ReviewRound & { patch?: unknown }> = paused
      ? await Promise.all(paused.rounds.map(async (round, index) => ({ ...round,
          ...(index ? { patch: await safeRead(patchPath(job, plan.version, index), root(job)) } : {}) })))
      : [];
    let stalled = paused?.stalled ?? 0;
    let sourceChanges: unknown = paused?.nextPatch ??
      (paused?.boundary === "diagnostic" || paused?.boundary === "replacement"
        ? reviewHistory.at(-1)?.patch : undefined);
    const cycleId = reviewCycleId(sameLineage(job, plan, snapshot, provider, model, task, head));
    const latestRotation = paused?.rounds.map((_, index) =>
      existsSync(replacementPath(job, plan.version, index)) ? index : -1)
      .filter(index => index >= 0).at(-1);
    const reviewerGroup = latestRotation === undefined
      ? "blueprint-review-cycle:" + cycleId
      : "blueprint-review-replacement:" + cycleId + ":" + latestRotation;
    // A fully staged initial draft is durable before the first reviewer
    // budget gate. Pausing here must not force the planner to run again.
    if (!paused && !initialPause)
      await planner.context.completed(planner.file, planner.session.sessionId);
    try {
      reviewer = await sessionFor(job, snapshot, provider, model,
        reviewerGroup, "architecture-blueprint-review-sessions",
        paused ? { file: paused.pin.reviewerSessionFile, id: paused.pin.reviewerSessionId } : undefined);
    } catch (error) {
      if (error instanceof PiBudgetPause && !paused && !initialPause) {
        const bytes = await readFile(planner.file);
        await immutable(initialPausePath(job, plan.version), {
          schema: "noveltea-blueprint-initial-review-pause/v1",
          lineage: sameLineage(job, plan, snapshot, provider, model, task, head),
          plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
          plannerTranscriptBytes: bytes.length,
          plannerTranscriptDigest: createHash("sha256").update(bytes).digest("hex"),
          draftDigest: sha(initialBlueprint), stagesDigest: sha(stagesReceipt),
          obligationsDigest: sha(manifest),
        } satisfies InitialReviewPause);
      }
      throw error;
    }
    assertReviewCycleSession(
      { id: planner.session.sessionId, file: planner.file },
      { id: reviewer.session.sessionId, file: reviewer.file },
      paused ? { id: paused.pin.reviewerSessionId, file: paused.pin.reviewerSessionFile } : undefined);
    const expectedWriter = paused
      ? { id: paused.pin.plannerSessionId, file: paused.pin.plannerSessionFile }
      : initialPause
        ? { id: initialPause.plannerSessionId, file: initialPause.plannerSessionFile }
        : null;
    if (expectedWriter && (planner.session.sessionId !== expectedWriter.id ||
        planner.file !== expectedWriter.file))
      throw Error("Paused causal Blueprint writer Pi session was replaced.");
    if (paused?.boundary === "writer") {
      const last = paused.rounds.at(-1)!;
      await promptStorySpecialist(planner.session,
        "RESUME AT VERIFIED CAUSAL BLUEPRINT WRITER BOUNDARY. Reuse this ORIGINAL writer " +
        "conversation; source and authority are unchanged. " +
        blueprintCorrectionPrompt(last.blueprint, last.verdict, outline));
    }
    const sealBudgetPause = async (boundary: BlueprintPause["boundary"],
      nextVersion: number, pin: BlueprintPin, nextDraftDigest: string | null) => {
      const writerBytes = await readFile(planner.file);
      const reviewerBytes = await readFile(reviewer!.file);
      await immutable(pausePath(job, plan.version, nextVersion, boundary), {
        schema: "noveltea-blueprint-safe-pause/v1", boundary, nextVersion, pin, nextDraftDigest,
        writerTranscriptBytes: writerBytes.length,
        writerTranscriptDigest: createHash("sha256").update(writerBytes).digest("hex"),
        reviewerTranscriptBytes: reviewerBytes.length,
        reviewerTranscriptDigest: createHash("sha256").update(reviewerBytes).digest("hex"),
      } satisfies BlueprintPause);
    };
    let lastPin: BlueprintPin | undefined = paused?.pin;
    for (let version = paused?.nextVersion ?? 0; ; version++) {
      const resumingDiagnosis = !!paused && version === paused.nextVersion &&
        (paused.boundary === "diagnostic" || paused.boundary === "replacement");
      let blueprint: CausalBlueprint;
      if (resumingDiagnosis) {
        blueprint = paused.blueprint;
      } else if (version === 0) {
        blueprint = initialBlueprint;
      } else if (paused?.boundary === "review" && version === paused.nextVersion) {
        blueprint = paused.nextDraft!;
        sourceChanges = paused.nextPatch;
      } else {
        const parsePatch = () =>
          parseBlueprintPatch(lastText(planner.session), previous!.blueprint, previous!.verdict);
        verifyReadSources(planner.session.messages, planner.project.root, snapshot);
        let result: ReturnType<typeof parsePatch>;
        try { result = parsePatch(); }
        catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown patch failure";
          await promptStorySpecialist(planner.session,
            "Your JSONL patch was rejected for this EXACT controller defect: " + reason +
            " EXACT permitted original reviewer finding-to-target mapping: " +
            JSON.stringify(allowedBlueprintPatchTargets(previous!.blueprint, previous!.verdict)) +
            ". Every findingBeatId MUST equal an ID in this mapping; use the " +
            "ORIGINAL findingBeatId even when modifying one of its descendant " +
            "targetBeatIds. Do not use the target beat's own ID as the findingBeatId " +
            "unless the reviewer actually issued a finding at that beat. " +
            "Do not regenerate the original blueprint. Return the COMPLETE corrected " +
            "JSONL: line one an object with schema,baseDigest,reviewDigest; " +
            "following lines one complete JSON operation per line. " +
            "Use exact old text and reviewed finding IDs; preserve all prior " +
            "observations, choices, lasting effects and immutable source obligations. " +
            "No array, wrapper, markdown, extra braces or blank lines.");
          verifyReadSources(planner.session.messages, planner.project.root, snapshot);
          result = parsePatch();
        }
        await immutable(patchPath(job, plan.version, version), result.patch);
        sourceChanges = result.patch;
        blueprint = result.blueprint;
        await immutable(draftPath(job, plan.version, version), blueprint);
      }
      // An authored correction is complete before a reviewer-budget pause.
      // Its exact patch/draft are immutable and can be inspected on resume.
      if (version > 0 && !resumingDiagnosis) {
        await planner.context.completed(planner.file, planner.session.sessionId);
        try { await reviewer.context.beforeTurn(reviewer.file); }
        catch (error) {
          if (error instanceof PiBudgetPause && lastPin)
            await sealBudgetPause("review", version, lastPin, sha(blueprint));
          throw error;
        }
      }
      let verdict: BlueprintReview;
      let convergence: ReturnType<typeof evaluateReviewConvergence>;
      if (resumingDiagnosis) {
        // The negative verdict was already sealed before the budget pause.
        // Never ask the original reviewer to repeat it or count another round.
        verdict = paused.rounds.at(-1)!.verdict;
        convergence = { review: verdict as ConvergentReview, productive: false,
          stalled, reassess: stalled >= 2, oscillating: false };
      } else {
        if (version === 0) {
          await immutable(initialReviewStartedPath(job, plan.version), {
            schema: "noveltea-blueprint-initial-review-start/v1",
            ...sameLineage(job, plan, snapshot, provider, model, task, head),
            reviewCycleId: cycleId, blueprintDigest: sha(blueprint),
            plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
            reviewerSessionId: reviewer.session.sessionId, reviewerSessionFile: reviewer.file,
          });
        }
        const messageStart = reviewer.session.messages.length;
        await promptStorySpecialist(reviewer.session,
          (version === 0 ? reviewer.context.contextNote :
            "CONTINUING YOUR EXISTING INDEPENDENT REVIEW CYCLE. Your prior analysis " +
            "is context, not authority. Re-read the pinned methodology and current " +
            "Creative Direction before returning a new source-bound verdict. ") +
          reviewPrompt(plan, blueprint, manifest!, task, outline, reviewHistory, sourceChanges));
        const parseReview = () => {
          verifyReadSources(reviewer!.session.messages.slice(messageStart), reviewer!.project.root, snapshot);
          const parsed = parseBlueprintReview(lastText(reviewer!.session), blueprint);
          return evaluateReviewConvergence(parsed, blueprint, reviewHistory, sources, stalled);
        };
        try { convergence = parseReview(); }
        catch (error) {
          const reason = error instanceof Error ? error.message : "Invalid Blueprint review evidence";
          await promptStorySpecialist(reviewer.session,
            "CONTROLLER REJECTED YOUR REVIEW PROTOCOL: " + reason + ". " +
            "This is a response/source-read correction, NOT a semantic review round. " +
            "Read the required pinned skills and Creative Direction NOW if not " +
            "already read in this review turn. Return ONE COMPLETE v2 JSON verdict " +
            "with every previous finding accounted for, current source citations, " +
            "and the same substantive findings; do not omit or invent an approval.");
          convergence = parseReview();
        }
        verdict = convergence.review;
        await reviewer.context.completed(reviewer.file, reviewer.session.sessionId);
        const bytes = await readFile(reviewer.file);
        await immutable(verdictPath(job, plan.version, version), verdict);
        await immutable(reviewSessionPath(job, plan.version, version), {
          schema: "noveltea-blueprint-review-turn/v1", cycleId,
          sessionId: reviewer.session.sessionId, sessionFile: reviewer.file,
          blueprintDigest: sha(blueprint), verdictDigest: sha(verdict),
          transcriptBytes: bytes.length,
          transcriptDigest: createHash("sha256").update(bytes).digest("hex"),
        });
        await immutable(convergencePath(job, plan.version, version), {
          schema: "noveltea-blueprint-convergence/v1", draftDigest: sha(blueprint),
          verdictDigest: sha(verdict), productive: convergence.productive,
          stalled: convergence.stalled, oscillating: convergence.oscillating,
        });
      }
      let pin: BlueprintPin = {
        schema: "noveltea-approved-blueprint/v4", reviewCycleId: cycleId,
        ...sameLineage(job, plan, snapshot, provider, model, task, head),
        draftVersion: version, blueprintDigest: sha(blueprint), reviewDigest: sha(verdict),
        obligationsDigest: sha(manifest), stagesDigest: sha(stagesReceipt),
        plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
        reviewerSessionId: reviewer.session.sessionId, reviewerSessionFile: reviewer.file,
      };
      if (verdict.status !== "pass") {
        const rounds: Array<ReviewRound & { patch?: unknown }> = resumingDiagnosis
          ? [...reviewHistory]
          : [...reviewHistory, { blueprint, verdict,
              ...(version ? { patch: sourceChanges } : {}) }];
        const previouslyDiagnosed = rounds.slice(0, -1).filter((_, i) =>
          existsSync(diagnosticPath(job, plan.version, i))).length;
        const sealedDiagnosis = resumingDiagnosis &&
          existsSync(diagnosticPath(job, plan.version, version))
          ? await readDiagnosis(job, plan, version, cycleId, rounds, sources,
              reviewer.session.sessionId, planner.session.sessionId)
          : null;
        const trigger = sealedDiagnosis?.trigger ??
          diagnosticTrigger(rounds, convergence.stalled, previouslyDiagnosed);
        if (convergence.stalled >= 2 && previouslyDiagnosed >= 2)
          throw Error("Diagnostic review requires author-guided escalation after repeated stagnation.");
        if (trigger) {
          let diagnosis: BlueprintDiagnosticReceipt;
          try {
            diagnosis = await performBlueprintDiagnosis(job, snapshot, plan, provider, model,
              task, cycleId, rounds, sources, trigger,
              { id: planner.session.sessionId, file: planner.file },
              { id: reviewer.session.sessionId, file: reviewer.file },
              rounds.map(round => round.patch ?? null));
          } catch (error) {
            if (error instanceof PiBudgetPause)
              await sealBudgetPause("diagnostic", version, pin, null);
            throw error;
          }
          if (diagnosis.diagnosis.action === "split" ||
              diagnosis.diagnosis.action === "escalate")
            throw Error("Diagnostic review requires author-guided " +
              (diagnosis.diagnosis.action === "split" ? "plan restructuring" : "escalation") +
              "; no automatic scope expansion or review approval.");
          if (diagnosis.diagnosis.action === "replace") {
            let replacement: Awaited<ReturnType<typeof performBlueprintReplacement>>;
            try {
              replacement = await performBlueprintReplacement(job, snapshot, plan,
                provider, model, task, cycleId, rounds, sources, diagnosis,
                { id: planner.session.sessionId, file: planner.file },
                { id: reviewer.session.sessionId, file: reviewer.file },
                manifest!, outline, sourceChanges);
            } catch (error) {
              if (error instanceof PiBudgetPause)
                await sealBudgetPause("replacement", version, pin, null);
              throw error;
            }
            reviewer.session.dispose();
            reviewer = replacement.session;
            verdict = replacement.receipt.verdict;
            pin = { ...pin, reviewDigest: sha(verdict),
              reviewerSessionId: reviewer.session.sessionId,
              reviewerSessionFile: reviewer.file };
          }
          stalled = 0;
        } else {
          stalled = convergence.stalled;
        }
      }
      lastPin = pin;
      if (verdict.status === "pass") {
        await planner.context.completed(planner.file, planner.session.sessionId);
        await immutable(approvedPath(job, plan.version), pin);
        return pin;
      }
      previous = { blueprint, verdict };
      if (resumingDiagnosis) {
        reviewHistory[reviewHistory.length - 1] = { blueprint, verdict,
          ...(version ? { patch: sourceChanges } : {}) };
      } else {
        reviewHistory.push({ blueprint, verdict, ...(version ? { patch: sourceChanges } : {}) });
      }
      await planner.context.completed(planner.file, planner.session.sessionId);
      try { await planner.context.beforeTurn(planner.file); }
      catch (error) {
        if (error instanceof PiBudgetPause)
          await sealBudgetPause("writer", version + 1, pin, null);
        throw error;
      }
      await promptStorySpecialist(planner.session,
        blueprintCorrectionPrompt(blueprint, verdict, outline));
    }
  } finally {
    reviewer?.session.dispose();
    planner.session.dispose();
  }
}
