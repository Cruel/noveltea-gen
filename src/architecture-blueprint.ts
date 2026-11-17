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
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { buildBlueprintObligations, validateBlueprintObligations,
  type BlueprintObligations, type ObligationSources } from "./architecture-blueprint-obligations.js";
import { parseBlueprintPatch, applyBlueprintPatch,
  allowedBlueprintPatchTargets } from "./architecture-blueprint-patch.js";
import { parseBlueprintWire } from "./architecture-blueprint-wire.js";
import { assembleBlueprintStages, EVIDENCE_BATCH_SIZE, parseBlueprintEvidence,
  parseBlueprintObligationStage, parseBlueprintOutline, parseCurrentBlueprintOutline,
  type BlueprintEvidence, type BlueprintOutline } from "./architecture-blueprint-stages.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CORRECTIONS = 2;

/** Distinguish settled, invalid model output from ambiguous interrupted Pi work.
 * A rejected patch may be inspected/replayed but never resumed as approval. */
export function classifyBlueprintFailure(reason: string):
  "invalid-plan" | "review-rejected" | "interrupted" {
  if (reason.includes("exhausted bounded corrections")) return "review-rejected";
  if (/\b(?:interrupted|cancelled|canceled|aborted|timed out|timeout)\b/i.test(reason))
    return "interrupted";
  if (/^(?:Blueprint patch |Blueprint JSONL |Blueprint model response |Causal blueprint |Causal outline |Causal evidence |Independent blueprint review |Invalid bounded causal blueprint)/.test(reason) ||
      reason.includes("invalid beat relationships"))
    return "invalid-plan";
  return "interrupted";
}

// Real independent reviews add concrete evidence/route consequences to ~23 KB
// initial drafts. Leave correction headroom without weakening causal validation.
const MAX_BLUEPRINT_BYTES = 40000;
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
export interface BlueprintReview {
  status: "pass" | "revise";
  findings: Array<{ beatId: string; reason: string; correction: string }>;
}
export interface BlueprintPin {
  schema: "noveltea-approved-blueprint/v2" | "noveltea-approved-blueprint/v3";
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
  if (!strict(value, ["status", "findings"]) ||
      !["pass", "revise"].includes(String(value.status)) || !Array.isArray(value.findings) ||
      value.findings.length > 8 || (value.status === "pass" ? value.findings.length !== 0 : !value.findings.length))
    throw Error("Independent blueprint review has malformed verdict or findings.");
  const ids = new Set(blueprint.beats.map(b => b.id));
  for (const finding of value.findings) {
    if (!strict(finding, ["beatId", "reason", "correction"]) || !ids.has(finding.beatId as string) ||
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
const evidencePath = (job: JobStartResult, version: number, first: number) =>
  join(root(job), "plan-" + version + "-evidence-" + first + ".json");
const stagesPath = (job: JobStartResult, version: number) =>
  join(root(job), "plan-" + version + "-stages.json");
const patchPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-patch-" + iteration + ".json");
const reviewSessionPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-review-session-" + iteration + ".json");
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
  "reviewerSessionId" | "reviewerSessionFile"> {
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
export async function readApprovedBlueprint(job: JobStartResult, plan: Plan, snapshot: SkillSnapshot,
  provider: string, model: string, task: string, head: string): Promise<{ blueprint: CausalBlueprint; pin: BlueprintPin } | null> {
  const path = approvedPath(job, plan.version);
  if (!existsSync(path)) return null;
  const record = await safeRead(path, root(job)) as BlueprintPin;
  const expected = sameLineage(job, plan, snapshot, provider, model, task, head);
  if (!record || !["noveltea-approved-blueprint/v2", "noveltea-approved-blueprint/v3"].includes(record.schema) ||
      (record.schema === "noveltea-approved-blueprint/v3"
        ? !record.stagesDigest || !HASH.test(record.stagesDigest)
        : record.stagesDigest !== undefined) ||
      Object.entries(expected).some(([key, value]) => record[key as keyof BlueprintPin] !== value) ||
      !Number.isInteger(record.draftVersion) || record.draftVersion < 0 ||
      record.draftVersion > MAX_CORRECTIONS ||
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
  const initial = parseCausalBlueprint(JSON.stringify(await safeRead(
    draftPath(job, plan.version, 0), root(job))));
  if (record.schema === "noveltea-approved-blueprint/v3") {
    const receipt = await safeRead(stagesPath(job, plan.version), root(job));
    if (!strict(receipt, ["schema", "outlineDigest", "evidenceDigests"]) ||
        receipt.schema !== "noveltea-blueprint-stages/v1" ||
        !Array.isArray(receipt.evidenceDigests) ||
        sha(receipt) !== record.stagesDigest)
      throw Error("Approved causal blueprint stage receipt changed or is missing.");
    const outline = parseBlueprintOutline(JSON.stringify(
      await safeRead(outlinePath(job, plan.version), root(job))));
    if (sha(outline) !== receipt.outlineDigest)
      throw Error("Approved causal outline changed after admission.");
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
  validateBlueprintObligations(manifest, initial, sources);
  if (sha(manifest) !== record.obligationsDigest)
    throw Error("Approved causal proof obligations changed after review.");
  let blueprint = initial;
  const reviewers = new Set<string>();
  for (let i = 0; i <= record.draftVersion; i++) {
    const stored = await safeRead(draftPath(job, plan.version, i), root(job));
    if (sha(blueprint) !== sha(stored))
      throw Error("Causal blueprint patch history is stale or was rewritten.");
    const verdict = await safeRead(verdictPath(job, plan.version, i), root(job));
    const review = parseBlueprintReview(JSON.stringify(verdict), blueprint);
    const reviewSession = await safeRead(reviewSessionPath(job, plan.version, i), root(job)) as {
      sessionId: string; sessionFile: string; verdictDigest: string; blueprintDigest: string };
    if (!strict(reviewSession, ["sessionId", "sessionFile", "verdictDigest", "blueprintDigest"]) ||
        reviewSession.verdictDigest !== sha(verdict) ||
        reviewSession.blueprintDigest !== sha(blueprint) ||
        reviewSession.sessionId === record.plannerSessionId ||
        reviewers.has(reviewSession.sessionId) || reviewers.has(reviewSession.sessionFile))
      throw Error("Causal blueprint independent review provenance changed.");
    reviewers.add(reviewSession.sessionId);
    reviewers.add(reviewSession.sessionFile);
    await transcript(job, reviewSession.sessionFile, reviewSession.sessionId,
      "architecture-blueprint-review-sessions");
    if (i === record.draftVersion) {
      if (review.status !== "pass" || sha(blueprint) !== record.blueprintDigest ||
          sha(verdict) !== record.reviewDigest ||
          reviewSession.sessionId !== record.reviewerSessionId ||
          reviewSession.sessionFile !== record.reviewerSessionFile)
        throw Error("Approved causal blueprint or independent verdict changed after review.");
    } else {
      const patch = await safeRead(patchPath(job, plan.version, i + 1), root(job));
      blueprint = applyBlueprintPatch(blueprint, review, patch).blueprint;
    }
  }
  await transcript(job, record.plannerSessionFile, record.plannerSessionId, "architecture-blueprint-sessions");
  await transcript(job, record.reviewerSessionFile, record.reviewerSessionId, "architecture-blueprint-review-sessions");
  return { blueprint, pin: record };
}

/** Reserve one new independent reviewer identity before issuing ANY model call.
 * Review independence must fail at the actual expensive boundary, not only
 * after a passing blueprint has been persisted and reopened. */
export function reserveIndependentBlueprintReviewer(
  planner: { id: string; file: string },
  reviewer: { id: string; file: string },
  prior: Set<string>,
) {
  if (!reviewer.id || !reviewer.file || !planner.id || !planner.file ||
      reviewer.id === planner.id || reviewer.file === planner.file ||
      prior.has(reviewer.id) || prior.has(reviewer.file))
    throw Error("Independent causal blueprint reviewer reused a prior Pi session or transcript.");
  prior.add(reviewer.id);
  prior.add(reviewer.file);
}

/** A reviewer must be a separate read-only Pi session. All prompts and source
 * readers use the pinned sandbox; no model has authority to write Story bytes. */
async function sessionFor(
  job: JobStartResult, snapshot: SkillSnapshot, provider: string, model: string,
  step: string, directory: string,
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
    directory: join(job.stateDir, directory),
    // Planning and review happen before canonical writing: each model call
    // must honor normal job budget gates rather than the in-writer exemption.
  }, runtime);
  const safeTools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "specialist");
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
  await context.beforeTurn(file);
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
    "Only the outline is requested NOW: evidence observations and proof obligations " +
    "will be collected in SEPARATE smaller prompts, without changing this outline. " +
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
    "with EXACT root keys schema,premise,beats,resolution. " +
    "schema is noveltea-causal-outline/v2. Every beat has EXACT keys " +
    "id (unique lowercase slug), purpose (string), dependsOn (array of " +
    "EARLIER beat ids), change (string), decisions (array). " +
    "Each decision has question and alternatives, each alternative has " +
    "action and lastingEffect (at least two materially distinct outcomes). " +
    "Use decisions:[] for narrative-only beats. DO NOT emit observations yet. " +
    "Resolution has question,conclusion,supportedBy (beat ids),uncertainty. " +
    "Use EXACT additional root keys " +
    "causalAnswer and routeConsequences (NO other root fields). " +
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
    "routeConsequences is an array with EXACTLY ONE entry for EVERY " +
    "decision alternative, including all alternatives at ending beats. " +
    "Each entry has EXACT keys beatId,decisionIndex,alternativeIndex," +
    "laterBeatId,preserved,foregone,persistentEffect. Indexes are zero based, " +
    "laterBeatId is an actual LATER beat ID or 'resolution'; preserved and " +
    "foregone name SPECIFIC earned/withheld facts, access, trust or identity " +
    "protection ('none: reason' where genuinely none), and persistentEffect " +
    "names what the named later beat or ending MUST acknowledge. Entries " +
    "for two alternatives cannot describe identical states. Avoid generic " +
    "'may affect relationships' or 'will track outcomes' statements. " +
    "Keep complete compact JSON under 24KB. " +
    "The final proof is not approved until independent review. " +
    "Check every string and closing brace before responding."
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
    "\n" +
    'Return ONLY strict JSON {"status":"pass","findings":[]} or ' +
    '{"status":"revise","findings":[{"beatId":"exact beat slug",' +
    '"reason":"concrete causal defect","correction":"bounded remedy"}]}.'
  );
}

/** A fail-closed, checkpointed original planner session, with independently
 * reviewed immutable versions and a final approved pin published last. */
export async function createReviewedBlueprint(job: JobStartResult, snapshot: SkillSnapshot,
  plan: Plan, provider: string, model: string, task: string, head: string): Promise<BlueprintPin> {
  const approved = await readApprovedBlueprint(job, plan, snapshot, provider, model, task, head);
  if (approved) return approved.pin;
  // Never quietly replay a partially executed planner or reviewer after crash.
  if (existsSync(root(job))) {
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(root(job))).some(name => name.startsWith("plan-" + plan.version + "-")))
      throw Error("Unfinished causal blueprint sessions/evidence exist; inspect rather than replay an ambiguous Pi plan.");
  }
  const sources = await obligationSources(job, plan, task);
  // Durable admission precedes the Pi SDK session creation. A process crash
  // in the sessionFor/started-receipt gap must never re-enter a new planner.
  await immutable(admittedPath(job, plan.version),
    sameLineage(job, plan, snapshot, provider, model, task, head));
  const planner = await sessionFor(job, snapshot, provider, model,
    "blueprint:" + plan.version, "architecture-blueprint-sessions");
  try {
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
    const outline = await validatedStage(
      "outline",
      parseCurrentBlueprintOutline,
      "Return ONE valid v2 JSON outline object with the concrete causalAnswer " +
        "and every indexed routeConsequences entry; no evidence observations, " +
        "code fences or extra closing brace.",
    );
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
    const initialBlueprint = assembleBlueprintStages(outline, evidence);
    await promptStorySpecialist(planner.session,
      blueprintObligationsPrompt(plan, task, initialBlueprint, sources));
    const manifest = await validatedStage("source obligations",
      text => parseBlueprintObligationStage(text, initialBlueprint, sources),
      "Return ONLY 1–20 standalone valid JSON obligation lines. " +
      "Every quote MUST be copied EXACTLY as a contiguous 8–40-character " +
      "substring of its corresponding source text from the previous prompt; " +
      "never fabricate or combine quotations, and reference existing beat IDs.");
    await immutable(obligationsPath(job, plan.version), manifest);
    await immutable(draftPath(job, plan.version, 0), initialBlueprint);
    const stagesReceipt = {
      schema: "noveltea-blueprint-stages/v1",
      outlineDigest: sha(outline), evidenceDigests,
    };
    await immutable(stagesPath(job, plan.version), stagesReceipt);
    let previous: { blueprint: CausalBlueprint; verdict: BlueprintReview } | undefined;
    const reviewedSessions = new Set<string>();
    for (let version = 0; version <= MAX_CORRECTIONS; version++) {
      let blueprint: CausalBlueprint;
      if (version === 0) {
        blueprint = initialBlueprint;
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
        blueprint = result.blueprint;
        await immutable(draftPath(job, plan.version, version), blueprint);
      }
      const reviewer = await sessionFor(job, snapshot, provider, model,
        "blueprint-review:" + plan.version + ":" + version, "architecture-blueprint-review-sessions");
      let verdict: BlueprintReview;
      try {
        reserveIndependentBlueprintReviewer(
          { id: planner.session.sessionId, file: planner.file },
          { id: reviewer.session.sessionId, file: reviewer.file },
          reviewedSessions,
        );
        await promptStorySpecialist(reviewer.session, reviewer.context.contextNote +
          reviewPrompt(plan, blueprint, manifest!, task, outline));
        verifyReadSources(reviewer.session.messages, reviewer.project.root, snapshot);
        try { verdict = parseBlueprintReview(lastText(reviewer.session), blueprint); }
        catch {
          await promptStorySpecialist(reviewer.session, "Your verdict was malformed. " +
            "No file or source is changed. Return the same COMPLETE independent findings " +
            "with exact valid JSON keys and exact beat IDs; no fences or explanations. " +
            "Only status pass with [] or revise with 1–8 findings is allowed.");
          verifyReadSources(reviewer.session.messages, reviewer.project.root, snapshot);
          verdict = parseBlueprintReview(lastText(reviewer.session), blueprint);
        }
        await reviewer.context.completed(reviewer.file, reviewer.session.sessionId);
        await immutable(verdictPath(job, plan.version, version), verdict);
        await immutable(reviewSessionPath(job, plan.version, version), {
          sessionId: reviewer.session.sessionId, sessionFile: reviewer.file,
          blueprintDigest: sha(blueprint), verdictDigest: sha(verdict),
        });
        if (verdict.status === "pass") {
          await planner.context.completed(planner.file, planner.session.sessionId);
          const pin: BlueprintPin = {
            schema: "noveltea-approved-blueprint/v3",
            ...sameLineage(job, plan, snapshot, provider, model, task, head),
            draftVersion: version, blueprintDigest: sha(blueprint), reviewDigest: sha(verdict),
            obligationsDigest: sha(manifest), stagesDigest: sha(stagesReceipt),
            plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
            reviewerSessionId: reviewer.session.sessionId, reviewerSessionFile: reviewer.file,
          };
          await immutable(approvedPath(job, plan.version), pin);
          return pin;
        }
        if (version === MAX_CORRECTIONS)
          throw Error("Independent causal blueprint review exhausted bounded corrections: " +
            JSON.stringify(verdict.findings) + ". Preserve original private evidence.");
        previous = { blueprint, verdict };
        await promptStorySpecialist(planner.session,
          "INDEPENDENT CAUSAL REVIEW. The original blueprint and immutable " +
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
          " FINDINGS: " + JSON.stringify(verdict.findings));
      } finally { reviewer.session.dispose(); }
    }
    throw Error("Causal blueprint did not receive independent approval.");
  } finally { planner.session.dispose(); }
}
