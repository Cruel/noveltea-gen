/** Private, source-bound causal Architecture planning. This is not canonical Story
 * content, a user approval or a portable completed-Git recovery checkpoint. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
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
import { parseBlueprintPatch, applyBlueprintPatch } from "./architecture-blueprint-patch.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CORRECTIONS = 2;
const MAX_BLUEPRINT_BYTES = 24000;
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
  schema: "noveltea-approved-blueprint/v2";
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
const patchPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-patch-" + iteration + ".json");
const reviewSessionPath = (job: JobStartResult, version: number, iteration: number) =>
  join(root(job), "plan-" + version + "-review-session-" + iteration + ".json");
async function obligationSources(job: JobStartResult, plan: Plan, task: string): Promise<ObligationSources> {
  return { foundation: await readFile(join(job.worktreeStoryRoot, "creative-direction/foundation.md"), "utf8"),
    contract: plan.contract, task };
}
function initialBlueprint(text: string, sources: ObligationSources) {
  const raw = text.trim().replace(/^```(?:json)?\\s*\\n/i, "").replace(/\\n```\\s*$/, "");
  if (Buffer.byteLength(raw) > 32000) throw Error("Causal blueprint and proof obligations exceed their bounded size.");
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw Error("Causal blueprint with obligations is not valid JSON."); }
  if (!strict(value, ["blueprint", "obligations"]))
    throw Error("Causal blueprint must contain both its design and source-derived proof obligations.");
  const blueprint = parseCausalBlueprint(JSON.stringify(value.blueprint));
  return { blueprint, obligations: buildBlueprintObligations(value.obligations, blueprint, sources) };
}
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
  "blueprintDigest" | "reviewDigest" | "obligationsDigest" | "plannerSessionId" | "plannerSessionFile" |
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
  if (!record || record.schema !== "noveltea-approved-blueprint/v2" ||
      Object.entries(expected).some(([key, value]) => record[key as keyof BlueprintPin] !== value) ||
      !Number.isInteger(record.draftVersion) || record.draftVersion < 0 ||
      record.draftVersion > MAX_CORRECTIONS ||
      !HASH.test(record.blueprintDigest) || !HASH.test(record.reviewDigest) ||
      !HASH.test(record.obligationsDigest))
    throw Error("Approved causal blueprint is stale, incomplete or bound to a different scope.");
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
    group: directory, step, paths: [], snapshot: snapshot.id, provider, model,
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
function blueprintPrompt(plan: Plan, task: string) {
  return "You are the NovelTea ARCHITECTURE CAUSAL PLANNER, not the canonical Story writer. " +
    "Read skill://nt-story-architecture/SKILL.md, skill://nt-catalog/SKILL.md and " +
    "creative-direction/foundation.md using the read tool. Do not edit, write or request shell. " +
    "Create a COMPACT source-grounded provisional causal design for a complete Arc, " +
    "not scene prose or canonical records. This is a NEW Story with only Foundation; " +
    "planned future fictional clues are allowed, but clearly identify what each " +
    "clue would actually prove, what it would not, and how the player can inspect it. " +
    "A changed object alone cannot establish when or why it changed, and reaching " +
    "an intermediate location does not settle a promised disappearance. " +
    "Every witness-dependent clue must have an accessible " +
    "route or credible alternative if the player may refuse the witness. " +
    "Protected author choices and welfare restrictions must survive each ending. " +
    "A decision needs alternatives with materially different lasting effects. " +
    "Trace the resolution backwards through named inspectable evidence and " +
    "cause-and-effect turning points. Separate the WHAT, WHEN, WHO, HOW and WHY " +
    "questions the author actually promised. If you claim that evidence shows " +
    "a breach or alteration, identify a direct test of that mechanism, not merely " +
    "a person's access, an object's movement, a custody gap or a later trace. " +
    "Do not claim a disappearance is resolved merely because someone reached " +
    "an intermediate location. Every enabled or refused witness route must " +
    "still support the ending's stated core conclusion using available proof. " +
    "Carry each earlier decision's evidence access, relationships and material " +
    "effects into later beats, including reconverged endings. Before finalizing " +
    "the JSON, audit EACH causal conclusion backwards through the evidence " +
    "under every alternative route; repair all unsupported leaps together. " +
    "Planned evidence is a future design obligation, " +
    "not already-authored World facts, Events or Choices. No invented canonical IDs. " +
    "Keep the scope and approved budgets: " + JSON.stringify(plan.contract) +
    "\nAuthor task: " + JSON.stringify(task) + "\n" +
    "First inventory the concrete causal promises from exact passages in " +
    "approved Creative Direction, the author task and the scope contract. " +
    "Quote at least 8 contiguous characters VERBATIM from the chosen source " +
    "(foundation document, author task, or JSON scope contract). " +
    "Identify story-specific WHAT, WHEN, WHO, HOW, WHY questions only when " +
    "promised; separately track material choices, refusal paths and ending conditions. " +
    "For each promise state the proof the Story must make inspectable, its route " +
    "and the beat IDs tasked with fulfilling it. Do not invent author promises " +
    "or omit a protected requirement. This inventory is immutable through corrections. " +
    "Return ONLY valid JSON with EXACT keys " +
    "{blueprint:{schema:'noveltea-causal-blueprint/v1',premise:string,beats:[{id:slug," +
    "purpose:string,dependsOn:[earlier beat slugs],observations:[{source:string," +
    "observable:string,supports:string,limits:string}],change:string," +
    "decisions:[{question:string,alternatives:[{action:string,lastingEffect:string}]}]}]," +
    "resolution:{question:string,conclusion:string,supportedBy:[evidence beat slugs]," +
    "uncertainty:string}},obligations:[{id:slug,category:'what|when|who|how|why|consequence|route|other', " +
    "source:'foundation|task|contract',quote:string,question:string,proof:string," +
    "route:string,beatIds:[existing beat slugs]}]}. " +
    "Use standard JSON double quotes. 2–16 beats, 1–20 obligations. " +
    "Use decisions:[] when a beat has no player decision; omission of that " +
    "single optional field is equivalent to [], no other fields are optional. " +
    "Keep blueprint JSON under 24000 bytes and the whole response under 32000 bytes. Be concise; " +
    "the one total-size ceiling, not arbitrary paragraph lengths, is enforced. " +
    "Do not omit protected Choices or change their lasting consequences; no filler.";
}
function reviewPrompt(plan: Plan, blueprint: CausalBlueprint,
  obligations: BlueprintObligations, task: string) {
  return "You are an INDEPENDENT, READ-ONLY CAUSAL ARCHITECTURE BLUEPRINT REVIEWER. " +
    "Read skill://nt-story-architecture/SKILL.md, skill://nt-catalog/SKILL.md, " +
    "creative-direction/foundation.md. No writing, shell, approval or expansion of scope. " +
    "Compare the proposed plan with approved author objective and hard constraints. " +
    "Inspect every dependency and what each observation could prove. Specifically " +
    "catch unsupported time/identity/intent inferences, skipped disappearance " +
    "resolution, unreachable evidence when player refuses cooperation, " +
    "decisions with unmodeled alternative consequences, and inconsistencies " +
    "after reconvergence. Planned plausible future evidence need not already " +
    "exist in canonical Event/Fact files. Do not impose generic plot preferences. " +
    "Check every source-quoted obligation against the actual approved Creative " +
    "Direction, author task, the scope and all supported/refused routes. " +
    "An obligation inventory can itself omit a promised outcome: report that " +
    "as a finding on the beat responsible for the missing proof, never approve " +
    "an incomplete inventory as exhaustive. Treat source-anchored obligations " +
    "as immutable during corrections, not as evidence that the fiction is true. " +
    "Report ALL material fixable problems in one verdict (maximum 8). " +
    "Findings reference exact beat IDs and propose bounded changes within " +
    "the approved story premise. Approval only means a coherent provisional plan; " +
    "later authored Story content must pass independent checks separately. " +
    "Source contract: " + JSON.stringify(plan.contract) +
    "\nOriginal author task: " + JSON.stringify(task) +
    "\nIMMUTABLE SOURCE-GROUNDED PROOF OBLIGATIONS:\n" + JSON.stringify(obligations) +
    "\nFULL MERGED BLUEPRINT JSON:\n" + JSON.stringify(blueprint) + "\n" +
    "Return ONLY strict JSON {\"status\":\"pass\",\"findings\":[]} or " +
    "{\"status\":\"revise\",\"findings\":[{\"beatId\":\"exact beat slug\"," +
    "\"reason\":\"concrete causal defect\",\"correction\":\"bounded remedy\"}]}.";
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
  const planner = await sessionFor(job, snapshot, provider, model,
    "blueprint:" + plan.version, "architecture-blueprint-sessions");
  try {
    // Even a crash before the first successful JSON result leaves durable evidence
    // of the begun Pi writer. Its session must not be silently replayed.
    await immutable(join(root(job), "plan-" + plan.version + "-started.json"), {
      ...sameLineage(job, plan, snapshot, provider, model, task, head),
      plannerSessionId: planner.session.sessionId, plannerSessionFile: planner.file,
    });
    await promptStorySpecialist(planner.session, planner.context.contextNote + blueprintPrompt(plan, task));
    let manifest: BlueprintObligations | undefined;
    let previous: { blueprint: CausalBlueprint; verdict: BlueprintReview } | undefined;
    for (let version = 0; version <= MAX_CORRECTIONS; version++) {
      verifyReadSources(planner.session.messages, planner.project.root, snapshot);
      const parseResponse = () => version === 0
        ? { ...initialBlueprint(lastText(planner.session), sources), patch: undefined }
        : { ...parseBlueprintPatch(lastText(planner.session), previous!.blueprint, previous!.verdict),
          obligations: undefined };
      let result: ReturnType<typeof parseResponse>;
      try { result = parseResponse(); }
      catch {
        await promptStorySpecialist(planner.session, version === 0
          ? "The initial JSON is invalid. Return ONE complete {blueprint,obligations} " +
            "object with exact quoted source passages and all original required fields; " +
            "do not write Story files, use double quotes and no markdown fences."
          : "The targeted patch is malformed or unsafe. Do not regenerate the " +
            "blueprint. Return ONLY a corrected patch with the SAME baseDigest " +
            "and reviewDigest, exact old values and bounded operations for the " +
            "reviewed findings. Do not erase or edit unrelated prior evidence, " +
            "decisions, consequences, protected commitments or ending promises.");
        verifyReadSources(planner.session.messages, planner.project.root, snapshot);
        result = parseResponse();
      }
      const blueprint = result.blueprint;
      if (version === 0) {
        manifest = result.obligations;
        await immutable(obligationsPath(job, plan.version), manifest);
      } else {
        if (!result.patch) throw Error("Blueprint correction lacks an authenticated patch.");
        await immutable(patchPath(job, plan.version, version), result.patch);
      }
      await immutable(draftPath(job, plan.version, version), blueprint);
      const reviewer = await sessionFor(job, snapshot, provider, model,
        "blueprint-review:" + plan.version + ":" + version, "architecture-blueprint-review-sessions");
      let verdict: BlueprintReview;
      try {
        await promptStorySpecialist(reviewer.session, reviewer.context.contextNote +
          reviewPrompt(plan, blueprint, manifest!, task));
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
            schema: "noveltea-approved-blueprint/v2",
            ...sameLineage(job, plan, snapshot, provider, model, task, head),
            draftVersion: version, blueprintDigest: sha(blueprint), reviewDigest: sha(verdict),
            obligationsDigest: sha(manifest),
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
          "Return ONLY a JSON patch object with EXACT keys " +
          "{schema:'noveltea-blueprint-patch/v1',baseDigest:string,reviewDigest:string," +
          "operations:array}. Each operation must name findingBeatId, an exact " +
          "beat ID from the review; target only that beat or a causal dependent. " +
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
          "kind. To refine an existing Choice lastingEffect, the new text MUST " +
          "contain the entire old lastingEffect unmodified; no old decision " +
          "or alternative may be erased. New beat IDs must be unique. " +
          "Never replace the premise, original question, decision action, " +
          "protected author outcome, unrelated clue or entire list. " +
          "Fix the causal findings and preserve all prior supported proof " +
          "including under refused routes. The independently reviewed FULL " +
          "merged design must still satisfy every original obligation. " +
          "BASE DIGEST: " + sha(blueprint) + " REVIEW DIGEST: " + sha(verdict) +
          " FINDINGS: " + JSON.stringify(verdict.findings));
      } finally { reviewer.session.dispose(); }
    }
    throw Error("Causal blueprint did not receive independent approval.");
  } finally { planner.session.dispose(); }
}
