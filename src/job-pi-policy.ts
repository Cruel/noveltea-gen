import { execFileSync } from "node:child_process";
import { createJobModelRuntime } from "./model-runtime.js";
import { foundationExceptionContext } from "./foundation-conflict.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { StoryProject } from "./project.js";
import { createStoryContextTool, StoryContextReader, type StoryContextRequest } from "./story-context.js";
import { readSandboxContextFile, sandboxToolsRequired } from "./sandbox-pi-tools.js";
import { parseJobLimits, type JobLimits } from "./job-limits.js";
import { observedActiveSeconds } from "./job-active-time.js";
import { readDiscoveryHandoff } from "./discovery-generation-handoff.js";

/** Private, job-local Pi optimization state. The Git Story remains authoritative. */
export interface PiPolicy {
  version: 1;
  profile: { provider: string; model: string; thinking?: "low" | "medium" | "high";
    optionalFallback?: { provider: string; model: string } };
  limits: JobLimits;
}
interface Resolution {
  version: 1;
  requested: { provider: string; model: string };
  selected: { provider: string; model: string };
  source: "required" | "explicit-optional-fallback";
  thinking?: "low" | "medium" | "high";
}
interface ContextReceipt {
  version: 1;
  group: string;
  file: string;
  sessionId: string;
  snapshot: string;
  model: string;
  sources: Record<string, string>;
  nativeRevisions?: Record<string, string>;
  /** Added for crash-safe recognition of an already COMPLETED Pi turn. */
  sessionSha256?: string;
}
interface BudgetState {
  version: 1;
  steps: string[];
  sessions: string[];
  /** Write-ahead external invocation references. Pi creates its transcript
   * with the first user message; until reconciled, absent files are unknown
   * external effects, not permission to dispatch another model call. */
  pendingSessions?: string[];
  pause?: { reason: string; at: string };
}
/** Observed Pi transcript usage, not an estimate of uninstrumented direct-model calls.
 * Missing prices/tokens remain explicit rather than silently being counted as free. */
export type PiTokenUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
};
export type PiBudgetUsage = {
  steps: number; modelCalls: number; costUsd: number; unpricedCalls: number;
  activeSeconds: number;
  tokens: PiTokenUsage; unknownTokenCalls: number;
  pause?: { reason: string; at: string };
};
const emptyTokens = (): PiTokenUsage =>
  ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });


const defaultProfile = { provider: "openai", model: "gpt-6-luna" };
const defaultPolicy = (): PiPolicy => ({ version: 1, profile: { ...defaultProfile }, limits: {} });
const stateDir = (job: JobStartResult) => job.stateDir;
const policyPath = (job: JobStartResult) => join(stateDir(job), "pi-policy.json");
const resolutionPath = (job: JobStartResult) => join(stateDir(job), "pi-resolution.json");
const budgetPath = (job: JobStartResult) => join(stateDir(job), "pi-budget.json");
const contextPath = (job: JobStartResult, group: string) =>
  join(stateDir(job), "pi-contexts", createHash("sha256").update(group).digest("hex") + ".json");

async function json<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid persisted Pi policy/receipt: " + file);
  }
}
async function persist(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}
function checkPolicy(policy: PiPolicy): void {
  if (policy.version !== 1 || !policy.profile.provider || !policy.profile.model ||
      !policy.limits ||
      (policy.profile.optionalFallback && (!policy.profile.optionalFallback.provider ||
        !policy.profile.optionalFallback.model))) throw new Error("Invalid Pi job profile or budget.");
  parseJobLimits(policy.limits);
}
async function initialPolicy(job: JobStartResult): Promise<PiPolicy> {
  const handoff = await readDiscoveryHandoff(job);
  return handoff ? { version: 1, profile: { provider: handoff.model.provider,
    model: handoff.model.id, thinking: handoff.model.thinking }, limits: handoff.limits } : defaultPolicy();
}
export async function inspectPiPolicy(job: JobStartResult) {
  const initial = await initialPolicy(job);
  const resolved = await json<Resolution>(resolutionPath(job));
  const policy = (await json<PiPolicy>(policyPath(job))) ?? {
    ...initial, profile: { ...initial.profile, ...(resolved?.requested ?? {}),
      ...(resolved?.thinking ? { thinking: resolved.thinking } : {}) },
  };
  checkPolicy(policy);
  return { policy, resolved,
    budget: await budgetUsage(job) };
}
/** Configuration is explicit, before first resolution. Increasing budgets does not reset usage. */
export async function configurePiPolicy(job: JobStartResult, next: PiPolicy): Promise<void> {
  checkPolicy(next);
  const handoff = await readDiscoveryHandoff(job);
  if (handoff && (next.profile.provider !== handoff.model.provider ||
      next.profile.model !== handoff.model.id || next.profile.thinking !== handoff.model.thinking ||
      next.profile.optionalFallback)) throw Error("Discovery pinned the original Turn model.");
  if (handoff) {
    const previous = (await json<PiPolicy>(policyPath(job)))?.limits ?? handoff.limits;
    if (Object.entries(previous).some(([key, value]) =>
        next.limits[key as keyof JobLimits] === undefined || next.limits[key as keyof JobLimits]! < value))
      throw Error("The cumulative Turn budget cannot decrease or reset.");
  }
  const old = await json<Resolution>(resolutionPath(job));
  if (old && (old.requested.provider !== next.profile.provider ||
      old.requested.model !== next.profile.model ||
      old.thinking !== next.profile.thinking ||
      (old.source === "explicit-optional-fallback" &&
        (old.selected.provider !== next.profile.optionalFallback?.provider ||
         old.selected.model !== next.profile.optionalFallback?.model)))) {
    throw new Error("Pi model selection is pinned for this job. Do not silently change it.");
  }
  await persist(policyPath(job), next);
}

/** Distinguish unavailable pinned provider/capability from a corrupted or
 * unauthorized model selection. A safe resource pause is not an integrity
 * incident or a license to switch models. */
export class PiModelUnavailableError extends Error {
  readonly code = "provider-unavailable";
  constructor(message: string) { super(message); this.name = "PiModelUnavailableError"; }
}

export async function resolvePiModel(job: JobStartResult, runtime: ModelRuntime,
  requestedProvider: string, requestedModel: string, thinking?: "low" | "medium" | "high"):
  Promise<{ model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; resolution: Resolution }> {
  const configured = await json<PiPolicy>(policyPath(job));
  const handoff = await readDiscoveryHandoff(job);
  const policy = configured ?? (handoff ? await initialPolicy(job) : { ...defaultPolicy(), profile: { provider: requestedProvider, model: requestedModel } });
  checkPolicy(policy);
  // Work-item CLIs still supply the historical default when no override was
  // provided. In that case the configured job profile is authoritative.
  const implicitDefault = !!configured && requestedProvider === defaultProfile.provider &&
    requestedModel === defaultProfile.model;
  const provider = implicitDefault ? policy.profile.provider : requestedProvider;
  const modelId = implicitDefault ? policy.profile.model : requestedModel;
  if (provider !== policy.profile.provider || modelId !== policy.profile.model ||
      (policy.profile.thinking && thinking && policy.profile.thinking !== thinking)) {
    throw new Error("Pi model request differs from the pinned job profile.");
  }
  const effectiveThinking = thinking ?? policy.profile.thinking;
  const available = async (provider: string, modelId: string) => {
    const model = runtime.getModel(provider, modelId);
    if (!model) return undefined;
    try {
      if (!(await runtime.getAvailable(provider)).some(m => m.id === modelId)) return undefined;
    } catch { return undefined; }
    if (effectiveThinking && !model.reasoning) return undefined;
    return model;
  };
  let resolved = await json<Resolution>(resolutionPath(job));
  if (resolved && (resolved.requested.provider !== provider ||
      resolved.requested.model !== modelId || resolved.thinking !== effectiveThinking)) {
    throw new Error("Saved Pi resolution differs from the requested model profile.");
  }
  if (!resolved) {
    const primary = await available(provider, modelId);
    const fallback = !primary && policy.profile.optionalFallback
      ? await available(policy.profile.optionalFallback.provider, policy.profile.optionalFallback.model)
      : undefined;
    if (!primary && !fallback) {
      throw new PiModelUnavailableError("Required Pi model/capabilities unavailable: " + provider + "/" +
        modelId + (policy.profile.optionalFallback ? " (explicit optional fallback also unavailable)" : "") +
        ". No implicit model fallback is permitted.");
    }
    resolved = { version: 1, requested: { provider, model: modelId },
      selected: primary ? { provider, model: modelId } :
        { ...policy.profile.optionalFallback! },
      source: primary ? "required" : "explicit-optional-fallback", thinking: effectiveThinking };
    await persist(resolutionPath(job), resolved);
  }
  const model = await available(resolved.selected.provider, resolved.selected.model);
  if (!model) throw new PiModelUnavailableError("Pinned Pi model/capabilities no longer available: " +
    resolved.selected.provider + "/" + resolved.selected.model);
  return { model, resolution: resolved };
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
async function sourceVersions(root: string, paths: string[]): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    const abs = resolve(root, path);
    if (!within(root, abs) || path.startsWith(".story-inbox/") || path === ".story-inbox") {
      throw new Error("Unsafe or private Pi context source: " + path);
    }
    const rel = relative(root, abs).split(sep).join("/");
    try {
      const info = await stat(abs);
      const canonical = await realpath(abs);
      const actualRel = relative(root, canonical).split(sep).join("/");
      if (!info.isFile() || !within(root, canonical) ||
          actualRel === ".story-inbox" || actualRel.startsWith(".story-inbox/"))
        throw new Error("Unsafe or non-file Pi context source: " + rel);
      versions[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      versions[rel] = "absent";
    }
  }
  return versions;
}

/** Detect successful Pi reads from the actual persisted conversation, not only
 * the scheduler's initial manifest. Excludes skill files and private inboxes. */
async function loadedStoryPaths(file: string, root: string): Promise<string[]> {
  const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as {
      type?: string; message?: { role?: string; content?: Array<{
        type?: string; id?: string; toolCallId?: string; name?: string;
        arguments?: { path?: unknown }; isError?: boolean;
      }> | unknown; toolCallId?: string; isError?: boolean };
    });
  const successful = new Set(entries.filter(e => e.type === "message" &&
    e.message?.role === "toolResult" && !e.message.isError)
    .map(e => e.message!.toolCallId));
  const reads: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant" ||
        !Array.isArray(entry.message.content)) continue;
    for (const call of entry.message.content) {
      if (call.type !== "toolCall" || call.name !== "read" ||
          !successful.has(call.id) || typeof call.arguments?.path !== "string") continue;
      const abs = resolve(root, call.arguments.path);
      if (!within(root, abs)) continue;
      const rel = relative(root, abs).split(sep).join("/");
      if (rel.startsWith(".") || rel.split("/").some(p => p.startsWith("."))) continue;
      reads.push(rel);
    }
  }
  return [...new Set(reads)].sort();
}
/** Shared transcript meter. A Discovery receipt can provide a verified prefix
 * rather than allowing later appends to alter the sealed phase's usage. */
export function accumulatePiUsage(content: string, file: string, seen: Set<string>, summary: PiBudgetUsage) {
  let index = 0;
  for (const line of content.split("\n").filter(Boolean)) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { throw new Error("Corrupt Pi usage transcript: " + file); }
    const assistant = entry.type === "message" && entry.message?.role === "assistant" ? entry.message : undefined;
    const usage = assistant?.usage ?? (entry.type === "usage" ? entry.usage : undefined);
    if (!usage) continue;
    // A fork carries previous Pi messages into its scoped transcript. Stable
    // IDs are the deduplication identity across parallel sessions in this run.
    const key = typeof entry.id === "string" ? entry.id : file + ":" + index;
    index++;
    if (seen.has(key)) continue;
    seen.add(key);
    summary.modelCalls++;
    if (typeof usage.cost?.total !== "number" || !Number.isFinite(usage.cost.total) ||
        usage.cost.total < 0) summary.unpricedCalls++;
    else summary.costUsd += usage.cost.total;
    const amount = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    for (const name of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (amount(usage[name])) summary.tokens[name] += usage[name];
    }
    if (amount(usage.totalTokens)) summary.tokens.total += usage.totalTokens;
    else summary.unknownTokenCalls++;
  }
}
export function emptyPiUsage(): PiBudgetUsage {
  return { steps: 0, modelCalls: 0, costUsd: 0, unpricedCalls: 0,
    activeSeconds: 0, tokens: emptyTokens(), unknownTokenCalls: 0 };
}
async function sessionUsage(job: JobStartResult, state: BudgetState): Promise<PiBudgetUsage> {
  const inherited = await readDiscoveryHandoff(job);
  const summary: PiBudgetUsage = inherited ? structuredClone(inherited.usage) : emptyPiUsage();
  summary.steps += state.steps.length;
  if (state.pause) summary.pause = state.pause;
  const seen = new Set<string>();
  for (const file of new Set([...state.sessions, ...(state.pendingSessions ?? [])])) {
    if (!file.startsWith(stateDir(job) + sep) || !file.endsWith(".jsonl"))
      throw new Error("Unsafe Pi budget session path.");
    if (!existsSync(file)) {
      if (state.pendingSessions?.includes(file) && !state.sessions.includes(file)) continue;
      throw new Error("Missing registered Pi budget transcript.");
    }
    if (await realpath(file) !== file) throw new Error("Unsafe Pi budget session path.");
    accumulatePiUsage(await readFile(file, "utf8"), file, seen, summary);
  }
  return summary;
}
async function budgetUsage(job: JobStartResult): Promise<PiBudgetUsage> {
  const state = (await json<BudgetState>(budgetPath(job))) ??
    { version: 1 as const, steps: [], sessions: [] };
  const usage = await sessionUsage(job, state);
  return { ...usage, activeSeconds: usage.activeSeconds + await observedActiveSeconds(job) };
}
export class PiBudgetPause extends Error {
  constructor(readonly reason: string, readonly usage: Awaited<ReturnType<typeof budgetUsage>>) {
    super("Pi budget exhausted at safe boundary: " + reason + ". Increase the job budget and resume.");
    this.name = "PiBudgetPause";
  }
}
export async function guardPiBudget(job: JobStartResult, step: string, sessionFile?: string): Promise<void> {
  const policy = (await json<PiPolicy>(policyPath(job))) ?? await initialPolicy(job);
  checkPolicy(policy);
  const state: BudgetState = (await json<BudgetState>(budgetPath(job))) ??
    { version: 1, steps: [], sessions: [] };
  if (sessionFile && existsSync(sessionFile) && !state.sessions.includes(sessionFile)) state.sessions.push(sessionFile);
  // The same transcript meter powers UI reports and admission; counters are
  // scoped to the job, not its Story or parent Thread.
  const observed = await sessionUsage(job, state);
  const { modelCalls, costUsd, unpricedCalls } = observed;
  const activeSeconds = observed.activeSeconds + await observedActiveSeconds(job);
  // An interrupted external Pi call may have unreported usage. The original
  // operation must reconcile its exact session first; never spend another
  // invocation from an unsettled budget registration.
  if (state.pendingSessions?.length)
    throw Error("Unsettled original Pi invocation usage; reconcile its transcript before another model call.");
  const freshStep = !state.steps.includes(step);
  const reason = freshStep && policy.limits.steps !== undefined && observed.steps >= policy.limits.steps
    ? "steps" : policy.limits.modelCalls !== undefined && modelCalls >= policy.limits.modelCalls
    ? "modelCalls" : policy.limits.costUsd !== undefined && unpricedCalls > 0
    ? "cost-unavailable" : policy.limits.costUsd !== undefined && costUsd >= policy.limits.costUsd
    ? "costUsd" : policy.limits.activeSeconds !== undefined &&
      activeSeconds >= policy.limits.activeSeconds ? "activeSeconds" : undefined;
  if (reason) {
    state.pause = { reason, at: new Date().toISOString() };
    await persist(budgetPath(job), state);
    throw new PiBudgetPause(reason, { ...observed, activeSeconds, pause: state.pause });
  }
  if (freshStep) state.steps.push(step);
  delete state.pause;
  await persist(budgetPath(job), state);
}

/** Safe-boundary admission happens before a job receipt records a writer as
 * started. Failures to resolve credentials, requirements, or budgets cannot
 * masquerade as interrupted filesystem edits. Fixtures also count steps. */
export async function preflightPiAssignment(job: JobStartResult, step: string,
  profile?: { provider: string; model: string; thinking?: "low" | "medium" | "high" }): Promise<void> {
  await guardPiBudget(job, step);
  if (profile) {
    const runtime = await createJobModelRuntime();
    await resolvePiModel(job, runtime, profile.provider, profile.model, profile.thinking);
  }
}

/** A durable reservation for a Pi transcript that may not exist until its
 * first user message. Called AFTER the original invocation fence is persisted,
 * but BEFORE the first external model prompt. */
export async function registerPendingPiSession(job: JobStartResult, file: string) {
  if (!file.startsWith(stateDir(job) + sep) || !file.endsWith(".jsonl"))
    throw Error("Unsafe pending Pi session registration.");
  const state: BudgetState = (await json<BudgetState>(budgetPath(job))) ??
    { version: 1, steps: [], sessions: [] };
  if (!state.sessions.includes(file) && !state.pendingSessions?.includes(file)) {
    state.pendingSessions = [...(state.pendingSessions ?? []), file];
    await persist(budgetPath(job), state);
  }
}

/** Record the just-completed session without imposing a new budget gate after
 * edits. The next safe boundary will inspect its actual usage and pause. */
export async function recordPiSession(job: JobStartResult, sessionFile: string): Promise<void> {
  if (!sessionFile.startsWith(stateDir(job) + sep) || !existsSync(sessionFile) ||
      await realpath(sessionFile) !== sessionFile) {
    throw new Error("Cannot record missing or unsafe Pi session usage.");
  }
  const state: BudgetState = (await json<BudgetState>(budgetPath(job))) ??
    { version: 1, steps: [], sessions: [] };
  const pending = state.pendingSessions?.filter(file => file !== sessionFile) ?? [];
  if (!state.sessions.includes(sessionFile) || pending.length !== (state.pendingSessions?.length ?? 0)) {
    if (!state.sessions.includes(sessionFile)) state.sessions.push(sessionFile);
    if (pending.length) state.pendingSessions = pending;
    else delete state.pendingSessions;
    await persist(budgetPath(job), state);
  }
}

/** Read-only proof of an already COMPLETED reviewer invocation.
 * The normal Pi context writer records this only after the model response,
 * independent verdict checks, and required source reads have all succeeded.
 * A reviewer session path/started marker alone never qualifies. */
export async function inspectCompletedPiReviewContext(job: JobStartResult, input: {
  group: string; sessionFile: string; snapshotId: string;
  requested: { provider: string; model: string };
}): Promise<{ sessionId: string; sessionSha256: string }> {
  const folder = join(job.stateDir, "review-sessions",
    input.group.startsWith("assignment-fidelity:") ? "assignment-fidelity" : "review") + sep;
  const file = input.sessionFile;
  if (!file.startsWith(folder) || !file.endsWith(".jsonl") ||
      !existsSync(file) || await realpath(file) !== file ||
      !(await stat(file)).isFile())
    throw Error("Completed reviewer session is missing or outside the pinned review folder.");
  const receipt = await json<ContextReceipt>(contextPath(job, input.group));
  const resolved = await json<Resolution>(resolutionPath(job));
  const budget = await json<BudgetState>(budgetPath(job));
  const configured = await json<PiPolicy>(policyPath(job));
  const requested = configured && input.requested.provider === defaultProfile.provider &&
    input.requested.model === defaultProfile.model ? configured.profile : input.requested;
  const expectedModel = resolved?.selected.provider + "/" + resolved?.selected.model +
    ":" + (resolved?.thinking ?? "pi-default");
  if (!receipt || receipt.version !== 1 || receipt.group !== input.group ||
      receipt.file !== file || !receipt.sessionId?.trim() ||
      receipt.snapshot !== input.snapshotId ||
      !resolved || resolved.version !== 1 ||
      resolved.requested.provider !== requested.provider ||
      resolved.requested.model !== requested.model ||
      receipt.model !== expectedModel ||
      !budget || budget.version !== 1 || !budget.sessions.includes(file) ||
      budget.pendingSessions?.includes(file) ||
      !/^[a-f0-9]{64}$/.test(receipt.sessionSha256 ?? ""))
    throw Error("Original closeout reviewer has no authenticated completed Pi context.");
  const content = await readFile(file, "utf8");
  const records = content.trimEnd().split("\n").map(line => JSON.parse(line)) as
    Array<{ type?: string; id?: string; message?: { role?: string; stopReason?: string } }>;
  if (records[0]?.type !== "session" || records[0].id !== receipt.sessionId ||
      !records.some(r => r.type === "message" && r.message?.role === "assistant" &&
        r.message.stopReason === "stop") ||
      createHash("sha256").update(content).digest("hex") !== receipt.sessionSha256)
    throw Error("Completed reviewer transcript changed after the original accepted Pi turn.");
  return { sessionId: receipt.sessionId, sessionSha256: receipt.sessionSha256 };
}

/** Share a prefix only when assignments reference the same actual Arc scope.
 * Different domains/roles remain isolated even within that Arc. */
export function piNarrativeGroup(role: string, paths: string[], fallback: string): string {
  const arcs = [...new Set(paths.filter(path => path.startsWith("arcs/") && path.endsWith(".md")))].sort();
  return role + ":" + (arcs.length ? arcs.join("|") : fallback);
}


/** Reconcile a protocol-fresh assignment reviewer accepted by the authenticated
 * response-contract controller but interrupted before context.completed().
 * The caller must first verify the exhausted-original/accepted-fresh handoff
 * and pinned methodology reads. No model turn is started here. */
export async function restoreAcceptedPiReviewContext(
  job: JobStartResult, project: StoryProject, args: {
    cycleId: string; snapshot: string; session: { id: string; file: string };
  }): Promise<void> {
  const group = "assignment-fidelity:" + args.cycleId + ":protocol-fresh";
  const directory = join(job.stateDir, "review-sessions", "assignment-fidelity", "protocol-fresh");
  const { id, file } = args.session;
  if (!/^[a-f0-9]{64}$/.test(args.cycleId) || !args.snapshot ||
      !id || !within(resolve(directory), file) || resolve(directory) === file ||
      !existsSync(file) || await realpath(file) !== file ||
      !(await stat(file)).isFile())
    throw new Error("Accepted fallback Pi context has an unsafe identity or transcript.");
  const transcript = await readFile(file, "utf8");
  let header: { type?: string; id?: string };
  try { header = JSON.parse(transcript.split("\n")[0] ?? "{}"); }
  catch { throw new Error("Accepted fallback Pi context has an invalid transcript header."); }
  if (header.type !== "session" || header.id !== id)
    throw new Error("Accepted fallback Pi context transcript identity differs.");
  const resolution = await json<Resolution>(resolutionPath(job));
  if (!resolution || resolution.version !== 1 ||
      !resolution.selected?.provider || !resolution.selected?.model)
    throw new Error("Accepted fallback Pi context has no pinned model resolution.");
  const model = resolution.selected.provider + "/" + resolution.selected.model +
    ":" + (resolution.thinking ?? "pi-default");
  const path = contextPath(job, group);
  const previous = await json<ContextReceipt>(path);
  if (previous) {
    if (previous.version !== 1 || previous.group !== group ||
        previous.file !== file || previous.sessionId !== id ||
        previous.snapshot !== args.snapshot || previous.model !== model)
      throw new Error("Accepted fallback conflicts with an existing Pi context identity.");
    return;
  }
  // Assignment fidelity is a pinned-skills-only reviewer. Its context has no
  // native Story reads or task paths to infer from an interrupted reader.
  // Preserve exactly the read-tool source tracking that completed() would save.
  const sources = await sourceVersions(project.root, await loadedStoryPaths(file, project.root));
  await recordPiSession(job, file);
  await persist(path, { version: 1, group, file, sessionId: id,
    snapshot: args.snapshot, model, sources, nativeRevisions: {} } satisfies ContextReceipt);
}

/** Reconstruct only the completed original adaptive context after a crash
 * between Pi's terminal transcript and completed(). No new session, turn,
 * budget step or model selection may be created by reconciliation. */
export async function restoreCompletedAdaptivePiContext(
  job: JobStartResult, project: StoryProject, args: {
    signature: string; snapshot: string; session: { id: string; file: string };
    provider: string; model: string;
  }): Promise<void> {
  const group = "orchestrator:adaptive:" + args.signature;
  const directory = join(job.stateDir, "adaptive-planning-sessions");
  const { file, id } = args.session;
  if (!/^[a-f0-9]{64}$/.test(args.signature) ||
      !/^[a-f0-9]{64}$/.test(args.snapshot) || !id ||
      !within(directory, file) || dirname(file) !== directory ||
      !existsSync(file) || await realpath(file) !== file || !(await stat(file)).isFile())
    throw Error("Original adaptive Pi context has an unsafe transcript reference.");
  const resolution = await json<Resolution>(resolutionPath(job));
  const configured = await json<PiPolicy>(policyPath(job));
  if (configured) checkPolicy(configured);
  // CLI's historical default is an alias for an explicitly configured job
  // profile, just as resolvePiModel() treats it on the original dispatch.
  const implicitDefault = !!configured && args.provider === defaultProfile.provider &&
    args.model === defaultProfile.model;
  const requested = implicitDefault ? configured!.profile :
    { provider: args.provider, model: args.model };
  if (!resolution || resolution.version !== 1 ||
      resolution.requested.provider !== requested.provider ||
      resolution.requested.model !== requested.model)
    throw Error("Original adaptive Pi model resolution differs; no replay.");
  const model = resolution.selected.provider + "/" + resolution.selected.model +
    ":" + (resolution.thinking ?? "pi-default");
  const path = contextPath(job, group);
  const previous = await json<ContextReceipt>(path);
  if (previous) {
    if (previous.version !== 1 || previous.group !== group ||
        previous.file !== file || previous.sessionId !== id ||
        previous.snapshot !== args.snapshot || previous.model !== model)
      throw Error("Original adaptive Pi context receipt differs.");
    return;
  }
  await recordPiSession(job, file);
  await persist(path, { version: 1, group, file, sessionId: id,
    snapshot: args.snapshot, model,
    sources: await sourceVersions(project.root, await loadedStoryPaths(file, project.root)),
    nativeRevisions: {} } satisfies ContextReceipt);
}

/** Each completed, clean specialist turn may be reused within its scoped narrative group. */
export async function preparePiContext(job: JobStartResult, project: StoryProject, options: {
  group: string; step: string; paths: string[]; snapshot: string;
  provider: string; model: string; thinking?: "low" | "medium" | "high";
  directory: string;
  /** Sealed safe-boundary resume: reopen this exact original Pi session, even
   * beyond the normal opportunistic 1.5 MB context-fork threshold. */
  resumeSession?: { file: string; id: string; formatOnly?: boolean;
    /** Exact paths independently verified by the trusted supporting-work controller. */
    changedPaths?: readonly string[] };
  /** Public native task-scoped Context Manifest query. Omit for discovery-only work. */
  task?: StoryContextRequest;
  /** An independent review nested inside an active writer must not pause mid-edit. */
  insideWriter?: boolean;
}, runtime: ModelRuntime): Promise<{
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  thinking?: "low" | "medium" | "high";
  manager: SessionManager;
  contextNote: string;
  contextTool: ReturnType<typeof createStoryContextTool>;
  beforeTurn: (file?: string) => Promise<void>;
  completed: (file: string, id: string) => Promise<void>;
}> {
  if (!options.insideWriter) await guardPiBudget(job, options.step);
  const { model, resolution } = await resolvePiModel(job, runtime, options.provider, options.model, options.thinking);
  const file = contextPath(job, options.group);
  const previous = await json<ContextReceipt>(file);
  // Include previously read Story records, not just the new assignment manifest.
  const versions = await sourceVersions(project.root,
    [...options.paths, ...Object.keys(previous?.sources ?? {})]);
  const oldSources = previous?.sources ?? {};
  const changed = Object.keys(versions).filter(p => versions[p] !== oldSources[p]);
  const superseded = Object.keys(oldSources).filter(p => !options.paths.includes(p));
  // A format-only continuation deliberately requests no source tools. Its
  // historical reads are not superseded assignments. Require *all* original
  // source versions unchanged instead of applying the new-assignment heuristic.
  const redesigned = options.resumeSession?.changedPaths ?
    changed.some(p => !options.resumeSession!.changedPaths!.includes(p)) :
    options.resumeSession?.formatOnly ? changed.length !== 0 :
    changed.some(p => /^(creative-direction|arcs|milestones)\//.test(p)) ||
    changed.length + superseded.length > 12;
  const clean = !execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
    { cwd: job.worktreeRoot, encoding: "utf8" }).trim();
  const expectedModel = resolution.selected.provider + "/" + resolution.selected.model +
    ":" + (resolution.thinking ?? "pi-default");
  let manager: SessionManager | undefined;
  let reused = false;
  await mkdir(options.directory, { recursive: true });
  if (options.resumeSession && (!previous || previous.snapshot !== options.snapshot ||
      previous.model !== expectedModel || previous.group !== options.group ||
      previous.file !== options.resumeSession.file ||
      previous.sessionId !== options.resumeSession.id || redesigned || !clean ||
      !within(resolve(options.directory), previous.file)))
    throw new Error("Cannot resume sealed Pi session: original context, sources or identity changed.");
  if (previous && previous.snapshot === options.snapshot && previous.model === expectedModel &&
      previous.group === options.group && !redesigned && clean) {
    const base = stateDir(job);
    if (!within(base, previous.file) || !existsSync(previous.file) ||
        await realpath(previous.file) !== previous.file) {
      throw new Error("Cannot reuse Pi context: pinned conversation file is missing or unsafe.");
    }
    // A new work item must retain its own receipt-directory identity for crash
    // recovery and editorial repair. Pi's supported fork carries the same cache
    // prefix forward without rewriting the original transcript.
    if (options.resumeSession?.changedPaths && (!previous.sessionSha256 ||
        createHash("sha256").update(await readFile(previous.file)).digest("hex") !== previous.sessionSha256))
      throw Error("Cannot continue after supporting work: original completed Pi transcript changed.");
    const verified = SessionManager.open(previous.file, dirname(previous.file), project.root);
    if (verified.getSessionId() !== previous.sessionId) {
      throw new Error("Cannot reuse Pi context: session identity mismatch.");
    }
    if (options.resumeSession || (await stat(previous.file)).size < 1_500_000) {
      manager = within(resolve(options.directory), previous.file)
        ? SessionManager.open(previous.file, dirname(previous.file), project.root)
        : SessionManager.forkFrom(previous.file, project.root, options.directory);
      reused = true;
    }
  }
  manager ??= SessionManager.create(project.root, options.directory);
  const storyReader = new StoryContextReader({ root: project.root, initialPaths: options.paths,
    task: options.task, previouslyRead: reused ? previous?.nativeRevisions : undefined,
    // The trusted native CLI produces typed manifest metadata on the worker.
    // Every model-requested Story content read goes through the registered
    // container; never use the local reader in a hosted session.
    readContent: sandboxToolsRequired() ? path => readSandboxContextFile(job, path) : undefined });
  const contextTool = createStoryContextTool(storyReader);
  // Stable instructions precede this delta. Prior source text is explicitly nonauthoritative.
  const contextNote = (await foundationExceptionContext(job)) +
    "CONTEXT VERSION POLICY: Canonical Story files currently on disk supersede " +
    "any older Pi conversation content. Never rely on remembered file contents for edits. " +
    (options.paths.length || options.task ?
      "Use story_context with {} before writing to batch-read the public native Context Manifest " +
      "and the source text missing or changed in this Pi session. Reinvoke after edits or for " +
      "justified typed-ID/position lookups; no Story lookup grants write permission. " +
      "If native CLI is absent, the tool offers ONLY a temporary scoped direct-file fallback. " : "") +
    "Re-read all task-required files, especially changed records. " +
    (reused ? "Continuing a related specialist conversation. " : "Starting a fresh scoped specialist conversation. ") +
    "Changed/new source paths and SHA-256: " +
    JSON.stringify(Object.fromEntries(changed.map(p => [p, versions[p]]))) +
    "; sources no longer relevant (superseded): " + JSON.stringify(superseded) +
    "; unchanged source versions: " +
    JSON.stringify(Object.fromEntries(Object.entries(versions).filter(([p]) => !changed.includes(p)))) +
    "; model provenance: " + resolution.source + " (" + expectedModel + ").\n\n";
  return {
    model, thinking: resolution.thinking, manager, contextNote, contextTool,
    async beforeTurn(sessionFile) {
      if (!options.insideWriter) await guardPiBudget(job, options.step, sessionFile);
    },
    async completed(sessionFile, id) {
      await recordPiSession(job, sessionFile);
      await persist(file, { version: 1, group: options.group, file: sessionFile, sessionId: id,
        snapshot: options.snapshot, model: expectedModel,
        sources: await sourceVersions(project.root,
          [...Object.keys(versions), ...Object.keys(storyReader.loadedRevisions()),
            ...await loadedStoryPaths(sessionFile, project.root)]),
        nativeRevisions: storyReader.loadedRevisions(),
        sessionSha256: createHash("sha256").update(await readFile(sessionFile)).digest("hex"),
      } satisfies ContextReceipt);
    },
  };
}
