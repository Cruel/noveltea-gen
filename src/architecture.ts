import { execFileSync } from "./git-read-cache.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { parseCarryForward, verifyCarryForwardCandidates } from "./plan-continuity.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { verifyJobPiSession } from "./job-session.js";
import { preflightPiAssignment } from "./job-pi-policy.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { readAuthorApproval, verifyAuthorEvidence, type AuthorApprovalEvidence } from "./author-evidence.js";
import { isFocusedScope, resolveFocusedScope } from "./focused-scope.js";
import { validateFocusedCreationGrants } from "./creation-grants.js";
import { authorizedArchitectureRecordPath } from "./architecture-record-path.js";

/** Exact additions to a focused Turn, never a general record-type write grant. */
export interface PlannedFocusCreate {
  id: string;
  path: string;
  title: string;
  /** Typed canonical references that must appear in the resulting record. */
  references: string[];
  /** Newly created prerequisites that must be committed before this assignment. */
  dependsOn: string[];
}
export interface CompletionContract {
  scope: { kind: "full-story" | "partial"; depth: "architecture" | "interactive" | "composition";
    targets: string[]; branches: string[]; supportingTargets?: string[];
    creates?: PlannedFocusCreate[];
    preset?: "architecture-outline" | "interactive-development" | "full-composition" };
  constraints: string[];
  envelope: { presentation: string; hardLimits: string[]; preferences: string[] };
}
export interface WorkItem {
  id: string;
  kind: "architecture" | "realization" | "composition" | "review";
  targetIds: string[];
  dependencies: string[];
  skills: string[];
  checks: string[];
  authorization: { source: "explicit-author-cli" | "trusted-controller"; planVersion: number; paths: string[] };
  planVersion: number;
  status: "pending" | "writing" | "verified" | "blocked";
  blockingReason?: string;
  verifiedSha?: string;
}
export interface Plan {
  version: number;
  contract: CompletionContract;
  items: WorkItem[];
}
interface Receipt {
  format: 1;
  jobId: string;
  baseSha: string;
  expectedHead: string;
  /** Current verified work boundary after an approved downstream replan. */
  executionHead?: string;
  /** Saved worktree and thread identities cannot be silently repointed. */
  branch?: string;
  worktreeRoot?: string;
  threadId?: string;
  mode: "autonomous" | "collaborative";
  worker: "fixture" | "pi";
  provider: string;
  model: string;
  snapshot?: SkillSnapshot;
  plan?: Plan;
  history: Array<{ plan: Plan; proposal: string; approvedContract: CompletionContract;
    verifiedHead: string; carryForward?: string[]; reason: string; source: "trusted-controller"; signed: AuthorApprovalEvidence }>;
  proposal?: { digest: string; contract: CompletionContract; version: number; baselineHead?: string; carryForward?: string[] };
  manuallyReconciled?: { paths: string[]; digest: string };
  phase: "awaiting-author" | "ready" | "writing" | "authored" | "committed";
  paths?: string[];
  contentDigest?: string;
  piSessionFile?: string;
  piSessionId?: string;
  skillReads?: string[];
  /** Source-bound authoring metadata, not a permission or a gameplay prerequisite. */
  milestoneOrder?: string[];
  outstanding?: Obligation[];
}
interface Obligation { id: string; path: string; field: string; requiredBy: string; code: string; message: string }
interface CatalogRecord { path: string; metadata: { id: string; type: string; status: string; arcs?: string[] } }
interface CatalogReport {
  records: CatalogRecord[];
  diagnostics: unknown[];
  outstanding: Obligation[];
  readiness: { design: { stages: Record<string, { minimum: string }> } };
  protection: { status: string; changes: unknown[]; warnings: unknown[] };
}
export interface ArchitectureOptions {
  story: string; job: string; action: "run" | "inspect" | "propose" | "approve" | "reconcile";
  contract?: unknown; task?: string; mode?: "autonomous" | "collaborative";
  skillsSource?: string; validatorSource?: string; fixture?: boolean; provider?: string; model?: string;
  proposal?: string; approvalFile?: string; recoveryDigest?: string; carryForward?: string[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
}
const repoPath = (job: JobStartResult, path: string) => job.storyRelativePath ? `${job.storyRelativePath}/${path}` : path;
async function persist(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
export function parseContract(value: unknown): CompletionContract {
  const c = value as CompletionContract;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string" && x.trim());
  const presets = { "architecture-outline": "architecture", "interactive-development": "interactive",
    "full-composition": "composition" } as const;
  const preset = c?.scope?.preset;
  const depth = preset && Object.hasOwn(presets, preset) ? presets[preset as keyof typeof presets] : c?.scope?.depth;
  const targetPattern = /^(arc|milestone|event|character|world-entity|relationship|fact|revelation|choice-point|puzzle|authored-content)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (!c || !["full-story", "partial"].includes(c.scope?.kind) ||
      !["architecture", "interactive", "composition"].includes(depth) ||
      (preset !== undefined && (typeof preset !== "string" || !Object.hasOwn(presets, preset))) ||
      (c.scope.depth !== undefined && c.scope.depth !== depth) ||
      !strings(c.scope.targets) || !strings(c.scope.branches) || !strings(c.constraints) ||
      (c.scope.supportingTargets !== undefined && !strings(c.scope.supportingTargets)) ||
      typeof c.envelope?.presentation !== "string" || !c.envelope.presentation.trim() ||
      !strings(c.envelope.hardLimits) || !strings(c.envelope.preferences) ||
      !c.scope.targets.every(id => targetPattern.test(id)) ||
      !(c.scope.supportingTargets ?? []).every(id => targetPattern.test(id)) ||
      c.scope.supportingTargets?.some(id => c.scope.targets.includes(id))) {
    throw new Error("Invalid completion contract: specify typed targets, depth/preset, branches, constraints, and a production envelope.");
  }
  validateFocusedCreationGrants(c.scope.creates ?? [], c.scope.targets, c.scope.kind);
  if (c.scope.kind === "partial" && c.scope.targets.some(id => /^(arc|milestone)\./.test(id)) &&
      c.scope.targets.some(id => !/^(arc|milestone)\./.test(id))) {
    throw new Error("Mixed Arc/Milestone cluster and individual record targets require separately authorized contracts; no automatic scope expansion.");
  }
  if (c.scope.targets.some(id =>
    (depth === "architecture" && /^(event|choice-point|puzzle|authored-content)\./.test(id)) ||
    (depth === "interactive" && id.startsWith("authored-content.")))) {
    throw new Error("Focused target requires a compatible narrative depth: Events/interactive branches need interactive, Authored Content needs composition.");
  }
  if (c.scope.kind === "full-story" && (depth !== "composition" || c.scope.targets.length || c.scope.branches.length || c.scope.supportingTargets?.length)) {
    throw new Error("Full-Story scope requires composition depth and cannot exclude targets or branches; use partial scope for an outline.");
  }
  const { preset: _preset, ...rest } = c.scope;
  return { scope: { ...rest, depth: depth!, targets: [...new Set(c.scope.targets)], branches: [...new Set(c.scope.branches)],
      ...(c.scope.supportingTargets ? { supportingTargets: [...new Set(c.scope.supportingTargets)] } : {}),
      ...(c.scope.creates ? { creates: c.scope.creates.map(item => ({ ...item,
        references: [...item.references], dependsOn: [...item.dependsOn] })) } : {}) },
    constraints: c.constraints, envelope: c.envelope };
}
/** Check every authorized scope revision, including when a later work item
 * consumes the plan without invoking the architecture writer again. */
export function verifyPlanHistory(job: JobStartResult, state: Pick<Receipt, "history" | "plan">) {
  if (!Array.isArray(state.history)) throw new Error("Invalid architecture plan history.");
  for (const [i, entry] of state.history.entries()) {
    const signed = verifyAuthorEvidence(job, entry.signed);
    const payload = signed.payload;
    if (payload.kind !== "plan" || entry.source !== "trusted-controller" ||
        entry.reason !== payload.reason || entry.proposal !== payload.proposalSha256 ||
        entry.verifiedHead !== payload.verifiedHead ||
        payload.planVersion !== entry.plan.version + 1 ||
        entry.proposal !== hash(JSON.stringify({
          plan: entry.plan, head: entry.verifiedHead, contract: entry.approvedContract,
          ...(entry.carryForward !== undefined ? { carryForward: parseCarryForward(entry.carryForward) } : {}),
        })) ||
        (i > 0 && (entry.plan.version !== state.history[i - 1]!.plan.version + 1 ||
          JSON.stringify(entry.plan.contract) !== JSON.stringify(state.history[i - 1]!.approvedContract)))) {
      throw new Error("Architecture plan history lacks matching controller authorization.");
    }
  }
  const last = state.history.at(-1);
  if (last && (state.plan?.version !== last.plan.version + 1 ||
      JSON.stringify(state.plan.contract) !== JSON.stringify(last.approvedContract))) {
    throw new Error("Current architecture completion contract differs from the approved plan revision.");
  }
}
function workItem(id: string, kind: WorkItem["kind"], targetIds: string[], dependencies: string[], version: number): WorkItem {
  const skills = { architecture: ["nt-story-architecture", "nt-catalog"], realization: ["nt-event-design", "nt-interactive-narrative", "nt-catalog"],
    composition: ["nt-narrative-composition", "nt-catalog"], review: ["nt-narrative-review", "nt-catalog"] };
  return { id, kind, targetIds, dependencies, skills: skills[kind],
    checks: kind === "architecture" ? ["canonical-structure", "protected-decisions", "scope-architecture-coverage"] :
      kind === "review" ? ["independent-editorial-review", "constraints-and-envelope", "branch-coverage"] : ["canonical-structure", "realize-in-scope-obligations"],
    authorization: { source: version === 1 ? "explicit-author-cli" : "trusted-controller", planVersion: version, paths: kind === "architecture" ? ["arcs/*.md", "milestones/*.md"] : [] },
    planVersion: version, status: "pending" };
}
function newPlan(contract: CompletionContract, version = 1): Plan {
  return { version, contract, items: [workItem("global-architecture", "architecture", contract.scope.targets, [], version)] };
}
function reportOf(result: ValidationResult): CatalogReport {
  const report = result.report as unknown as CatalogReport;
  if (!report || !Array.isArray(report.records) || !Array.isArray(report.outstanding) || !Array.isArray(report.diagnostics)) {
    throw new Error("Pinned validator lacks the canonical incomplete-record contract; do not invent a generator schema or silently replace its pin.");
  }
  if (report.diagnostics.length || result.status === "error" || result.status === "rejected") {
    throw new Error("Canonical architecture validation failed: " + JSON.stringify(result).slice(0, 6000));
  }
  return report;
}
function selectRecords(report: CatalogReport, contract: CompletionContract) {
  const current = report.records.filter(r => r.metadata.status !== "superseded");
  if (isFocusedScope(contract)) return resolveFocusedScope(current, contract).context as CatalogRecord[];
  const targets = contract.scope.targets;
  return current.filter(r => !targets.length || targets.includes(r.metadata.id) ||
    r.metadata.arcs?.some(id => targets.includes(id)) || current.some(m => targets.includes(m.metadata.id) && m.metadata.arcs?.includes(r.metadata.id)));
}
function checkArchitecture(report: CatalogReport, contract: CompletionContract) {
  if (report.readiness.design.stages.foundation?.minimum !== "passed") throw new Error("Canonical Creative Direction is not ready.");
  const records = selectRecords(report, contract);
  const ids = new Set(records.map(r => r.metadata.id));
  if (contract.scope.targets.some(id => !ids.has(id))) throw new Error("Architecture did not deliver every authorized target ID.");
  const arcs = records.filter(r => r.metadata.type === "arc");
  const milestones = records.filter(r => r.metadata.type === "milestone");
  if ((!isFocusedScope(contract) && (!arcs.length || !milestones.length || arcs.some(a => !milestones.some(m => m.metadata.arcs?.includes(a.metadata.id))))) ||
      report.outstanding.some(o => ids.has(o.id) && ["foundation", "architecture"].includes(o.requiredBy) &&
        (!isFocusedScope(contract) || ![...contract.scope.targets, ...(contract.scope.supportingTargets ?? [])].includes(o.id)))) {
    throw new Error("Scope architecture coverage is incomplete.");
  }
  if (!contract.scope.targets.length && report.readiness.design.stages.architecture?.minimum !== "passed") {
    throw new Error("Global architecture readiness has not passed.");
  }
  return records;
}
function dirty(job: JobStartResult) { return git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean); }
function assertHead(job: JobStartResult, head: string) {
  if (git(job, "rev-parse", "HEAD").trim() !== head || git(job, "symbolic-ref", "--short", "HEAD").trim() !== job.branch) {
    throw new Error("Architecture job HEAD/branch changed unexpectedly; reconcile without overwriting it.");
  }
}
async function changedPaths(job: JobStartResult) {
  const paths: string[] = [];
  for (const entry of dirty(job)) {
    if (!["??", " M"].includes(entry.slice(0, 2))) throw new Error("Unexpected staged/deleted/renamed changes; architecture commit refused.");
    const path = entry.slice(3);
    const local = job.storyRelativePath ? path.slice(job.storyRelativePath.length + 1) : path;
    if (repoPath(job, local) !== path || !authorizedArchitectureRecordPath(local)) {
      throw new Error("Architecture changed an unauthorized path: " + path);
    }
    const full = join(job.worktreeStoryRoot, local);
    if (await realpath(full) !== full || !(await lstat(full)).isFile()) throw new Error("Unsafe architecture path.");
    paths.push(local);
  }
  if (!paths.length) throw new Error("Architecture specialist produced no changes.");
  return paths.sort();
}
async function contentDigest(job: JobStartResult, paths: string[]) {
  return hash(JSON.stringify(await Promise.all(paths.map(async path => [path, hash(await readFile(join(job.worktreeStoryRoot, path), "utf8"))]))));
}
type Reconciliation = {
  status: "ready" | "recoverable-commit" | "blocked";
  actualHead: string;
  changes: string[];
  reason?: string;
  candidate?: { paths: string[]; digest: string };
};

/** Reconcile the receipt with Git, not merely with the last graph node. */
async function reconcile(job: JobStartResult, state: Receipt): Promise<Reconciliation> {
  const actualHead = git(job, "rev-parse", "HEAD").trim();
  const workingHead = state.executionHead ?? state.expectedHead;
  const changes = dirty(job);
  const blocked = (reason: string): Reconciliation =>
    ({ status: "blocked", actualHead, changes, reason });
  try {
    assertHead(job, actualHead);
    if (state.worker === "pi" && ["writing", "authored"].includes(state.phase)) {
      await verifyJobPiSession(job, "architecture", state.piSessionFile, state.piSessionId);
    }
    if (state.phase === "writing") {
      const result = blocked("Interrupted architecture writer: review the preserved files; use job architecture reconcile with the exact candidate digest to accept them without replaying the writer.");
      if (actualHead === workingHead) {
        try {
          const paths = await changedPaths(job);
          result.candidate = { paths, digest: await contentDigest(job, paths) };
        } catch { /* No safe candidate: preserve the changes and report their Git status. */ }
      }
      return result;
    }
    if (state.phase === "authored") {
      const paths = state.paths;
      if (!paths?.length || paths.some(p => !authorizedArchitectureRecordPath(p)) ||
          !state.contentDigest || !/^[a-f0-9]{64}$/.test(state.contentDigest)) {
        return blocked("Authored work-item inventory is missing or corrupt; inspect the Story before recovery.");
      }
      if (state.manuallyReconciled &&
          (state.manuallyReconciled.digest !== state.contentDigest ||
           JSON.stringify(state.manuallyReconciled.paths) !== JSON.stringify(paths))) {
        return blocked("Manually reviewed recovery differs from the persisted authored inventory.");
      }
      if (actualHead === workingHead) {
        if (JSON.stringify(await changedPaths(job)) !== JSON.stringify(paths) ||
            await contentDigest(job, paths) !== state.contentDigest) {
          return blocked("Uncommitted architecture changes differ from the recorded authored work item. Preserve edits and reconcile manually.");
        }
        return { status: "ready", actualHead, changes };
      }
      if (changes.length) return blocked("Uncommitted or staged changes accompany an interrupted commit. Inspect before continuing.");
      const parents = git(job, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ");
      if (parents.length !== 2 || parents[1] !== workingHead) {
        return blocked("Unexpected Git history after work-item crash; expected exactly one child of the verified head.");
      }
      const message = git(job, "log", "-1", "--format=%B");
      const trailers = [
        `NovelTea-Job: ${job.jobId}`,
        "NovelTea-Work-Item: global-architecture",
        `NovelTea-Plan-Version: ${state.plan?.version}`,
        `NovelTea-Architecture: ${state.contentDigest}`,
        ...(state.manuallyReconciled ? [`NovelTea-Reviewed-Recovery: ${state.manuallyReconciled.digest}`] : []),
      ];
      if (trailers.some(t => !message.split("\n").includes(t))) {
        return blocked("Interrupted Git commit lacks exact work-item provenance.");
      }
      const committed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
        .trim().split("\n").filter(Boolean).sort();
      if (JSON.stringify(committed) !== JSON.stringify(paths.map(p => repoPath(job, p)).sort()) ||
          await contentDigest(job, paths) !== state.contentDigest) {
        return blocked("Interrupted commit paths or committed bytes differ from the authorized work item.");
      }
      return { status: "recoverable-commit", actualHead, changes };
    }
    if (state.phase === "committed" && actualHead !== state.expectedHead && !changes.length) {
      // A later, separately verified work unit may have advanced the same job.
      // The architecture receipt remains pinned to its own completed commit.
      if (await trustedHead(job) === actualHead) {
        git(job, "merge-base", "--is-ancestor", state.expectedHead, actualHead);
        return { status: "ready", actualHead, changes };
      }
    }
    if (actualHead !== workingHead || changes.length) {
      return blocked("Story job HEAD, staged content or worktree differs from the saved safe boundary; review manual changes.");
    }
    return { status: "ready", actualHead, changes };
  } catch (cause) {
    return blocked("Unable to reconcile actual Git/Pi state: " + (cause instanceof Error ? cause.message : String(cause)));
  }
}
async function fixtureAuthor(job: JobStartResult, state: Receipt) {
  const targets = state.plan!.contract.scope.targets;
  const arcs = targets.filter(id => id.startsWith("arc."));
  if (!arcs.length) arcs.push("arc.truth");
  const milestones = targets.filter(id => id.startsWith("milestone."));
  if (!milestones.length) milestones.push(...arcs.map((_, i) => i === 0 ? "milestone.disclosure" : "milestone.reckoning"));
  const records = [
    ...arcs.map(arc => ({ folder: "arcs", id: arc, type: "arc", fields: 'dramatic_question: "Can truth survive loyalty?"\ncharacters: []',
      body: "The inquiry puts a friendship under pressure. Each admission makes concealment harder, until loyalty must mean either silence or accountability." })),
    ...milestones.map((milestone, i) => ({ folder: "milestones", id: milestone, type: "milestone", fields: `completeness: partial\nchange: "${process.env.NT_ARCHITECTURE_FIXTURE_CASE === "event-only" ? "Ada learns that Neri concealed the missing witness transfer ledger" : "The hidden evidence becomes a shared responsibility"}"\narcs: [${arcs[i % arcs.length]}]\nfulfillment: {any_of: []}`,
      body: process.env.NT_ARCHITECTURE_FIXTURE_CASE === "event-only"
        ? "In the archive, Neri presents Ada with the signed transfer ledger for the missing witness. Ada verifies the entry against the register and learns Neri hid this record. This is a single observational discovery, not a promise of player-selectable branches; its causal evidence and trust shift must be demonstrated within the Event before player-facing prose is composed."
        : "The investigator can no longer act alone once the witness discloses the evidence. A future conversation could earn this disclosure through trust; an evidence-led confrontation is another possible route. Event design must establish the prerequisites and consequences before either route is bound. Reuse the inquiry setting and express the revelation through dialogue." })),
  ];
  for (const r of records) {
    const path = join(job.worktreeStoryRoot, r.folder, r.id.split(".")[1] + ".md");
    if (existsSync(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nschema: '0.1'\ntype: ${r.type}\nid: ${r.id}\ntitle: "${r.id}"\nstatus: draft\ndecisions: []\n${r.fields}\n---\n\n${r.body}\n`, { flag: "wx" });
  }
}
async function publishVerifiedHead(job: JobStartResult, previous: string, commit: string) {
  const file = join(job.stateDir, "revisions", "verified-head.json");
  await mkdir(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      version?: number; jobId?: string; headSha?: string; workItemId?: string;
    };
    if (saved.version !== 1 || saved.jobId !== job.jobId ||
        (saved.headSha !== previous && saved.headSha !== commit)) {
      throw new Error("A different verified-head record exists; preserve the architecture commit for reconciliation.");
    }
    if (saved.headSha === commit) return;
  }
  await persist(file, { version: 1, jobId: job.jobId, headSha: commit,
    workItemId: "global-architecture" });
}

function checkOriginalProtection(job: JobStartResult, result: ValidationResult, expectedHead: string) {
  const baseSha = job.baseSha;
  const report = result.report as unknown as CatalogReport | undefined;
  if (!report || !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      !report.protection || !Array.isArray(report.protection.warnings) ||
      result.status === "error") {
    throw new Error("Original trusted-base architecture validation is invalid.");
  }
  // Revisions can lawfully have altered protected decisions since the original
  // baseline. Their trusted verified-head receipt was checked at job entry;
  // latest-head strict protection above must independently pass as well.
  const advanced = expectedHead !== baseSha;
  if (result.status === "passed" && report.protection.status === "checked") return;
  if (advanced && result.status === "rejected" && report.protection.status === "checked") return;
  // A new foundation may have been written after an initially empty Git Story
  // baseline, which the canonical validator explicitly cannot compare.
  if (advanced && result.status === "unverified" &&
      !git(job, "ls-tree", "-r", "--name-only", baseSha, "--", job.storyRelativePath || ".")
        .split("\n").some(path => path.endsWith(".md")) &&
      (report.protection.status === "no-baseline" ||
        (report.protection.status === "checked" &&
          (report.protection as CatalogReport["protection"] & { base?: string }).base === git(job, "rev-parse", "HEAD").trim()))) return;
  throw new Error("Original baseline cannot certify architecture authorization.");
}

/** A source-bound milestone scheduling preference must cover the exact
 * controller-validated canonical set. Never infer order from filename sorting,
 * let the writer add unknown targets, or treat preference as a new grant. */
export function verifiedArchitectureMilestoneOrder(
  ordered: readonly string[] | undefined, canonical: readonly string[],
): string[] {
  if (!ordered || ordered.length !== canonical.length ||
      new Set(ordered).size !== ordered.length ||
      ordered.some(id => !canonical.includes(id)))
    throw new Error('Architecture milestone execution order differs from the verified canonical scope.');
  return [...ordered];
}

function finishPlan(state: Receipt, report: CatalogReport, commit: string) {
  const plan = state.plan!;
  const selected = checkArchitecture(report, plan.contract);
  const ids = new Set(selected.map(r => r.metadata.id));
  plan.items[0] = { ...plan.items[0]!, targetIds: selected.filter(r => ["arc", "milestone"].includes(r.metadata.type)).map(r => r.metadata.id), status: "verified", verifiedSha: commit };
  const obligations = report.outstanding.filter(o => ids.has(o.id) &&
    (!isFocusedScope(plan.contract) || plan.contract.scope.targets.includes(o.id)));
  if (isFocusedScope(plan.contract)) {
    const focused = plan.contract.scope.targets.map(id => {
      const kind = id.startsWith("authored-content.") ? "composition" as const : "realization" as const;
      const item = workItem("focus-" + id.replace(".", "-"), kind, [id], ["global-architecture"], plan.version);
      const skill = id.startsWith("character.") || id.startsWith("relationship.") ? "nt-character-development" :
        id.startsWith("event.") ? "nt-event-design" :
        id.startsWith("authored-content.") ? "nt-narrative-composition" :
        id.startsWith("choice-point.") || id.startsWith("puzzle.") ? "nt-interactive-narrative" : "nt-worldbuilding";
      item.skills = [skill, "nt-catalog"];
      item.checks = ["exact-target-files", "canonical-structure", "protected-decisions", "scoped-review"];
      item.authorization.paths = selected.filter(r => r.metadata.id === id ||
        id === plan.contract.scope.targets[0] && plan.contract.scope.supportingTargets?.includes(r.metadata.id))
        .map(r => r.path);
      return item;
    });
    plan.items = [plan.items[0]!, ...focused, workItem("review-scope", "review", [...ids],
      focused.map(item => item.id), plan.version)];
    state.outstanding = obligations;
    state.phase = "committed";
    state.expectedHead = commit;
    return;
  }
  const clusterIds = [...new Set(obligations.map(o => o.id))];
  // Fixture plans retain the historical obligation order; already certified
  // carry-forward hashes must not drift due to test scaffolding. Real Pi plans
  // use the verified causal order supplied by the source-bound author.
  const ordered = state.worker === 'pi'
    ? verifiedArchitectureMilestoneOrder(state.milestoneOrder,
        selected.filter(r => r.metadata.type === 'milestone').map(r => r.metadata.id))
    : clusterIds;
  const clusters = [...ordered.filter(id => clusterIds.includes(id)),
    ...clusterIds.filter(id => !ordered.includes(id))].map(id =>
    workItem("realize-" + id.replace(".", "-"), "realization", [id], ["global-architecture"], plan.version));
  for (const item of clusters) { item.status = "blocked"; item.blockingReason = "Tracked downstream obligation; execute with the Event/interactive specialist in a later work unit."; }
  plan.items = [plan.items[0], ...clusters];
  if (plan.contract.scope.depth !== "architecture") {
    plan.items.push(workItem("compose-scope", "composition", [...ids], clusters.length ? clusters.map(c => c.id) : ["global-architecture"], plan.version));
  }
  const reviewDependencies = plan.contract.scope.depth !== "architecture"
    ? ["compose-scope"]
    : clusters.length ? clusters.map(item => item.id) : ["global-architecture"];
  plan.items.push(workItem("review-scope", "review", [...ids], reviewDependencies, plan.version));
  state.outstanding = obligations;
  state.phase = "committed";
  state.expectedHead = commit;
}
function output(job: JobStartResult, state: Receipt, recovery?: Reconciliation) {
  const complete = state.phase === "committed" && state.plan?.contract.scope.kind === "partial" &&
    state.plan.contract.scope.depth === "architecture" && state.plan.contract.scope.branches.length === 0;
  return { status: recovery?.status === "blocked" ? "blocked" : state.phase === "awaiting-author" ? "awaiting-author" : complete ? "complete-in-scope" : state.phase === "committed" ? "architecture-committed" : state.phase,
    jobId: job.jobId, branch: job.branch, worktreeStoryRoot: job.worktreeStoryRoot, headSha: state.expectedHead,
    recovery,
    plan: state.plan, proposal: state.proposal, history: state.history, outstanding: state.outstanding ?? [],
    authorSigningRequest: state.proposal ? {
      version: 1, kind: "plan", jobId: job.jobId, threadId: job.threadId,
      workItemId: "global-architecture", baseSha: job.baseSha,
      verifiedHead: state.proposal.baselineHead ?? state.expectedHead, proposalSha256: state.proposal.digest,
      planVersion: state.proposal.version, reason: "(Replace with substantive author rationale)",
    } : undefined,
    completionEvidence: { structuralArchitecture: state.phase === "committed", editorial: "unverified",
      constraintsAndEnvelope: "unverified", branchExecution: state.plan?.contract.scope.branches.length ? "unverified" : "not-requested",
      fullStory: false },
    questions: state.phase === "awaiting-author" ? "Supply --contract with kind, depth, target IDs, branch constraints and production envelope; no Story writes have occurred." : undefined,
    piSessionId: state.piSessionId, piSessionFile: state.piSessionFile,
    skillReads: state.skillReads, skillSnapshot: state.snapshot?.id };
}
export async function runArchitectureJob(input: ArchitectureOptions, alreadyLocked = false) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const file = join(job.stateDir, "architecture.json");
  // Initial validator pinning updates job.json; reopen the durable manifest before each validation.
  const validate = async (source?: string, view?: { worktreeRoot: string; worktreeStoryRoot: string; baseSha: string }) =>
    validateStoryJob(await startStoryJob({ story: input.story, job: input.job }, false), source, view);
  const execute = async () => {
    let state: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    if (state && (state.format !== 1 || state.jobId !== job.jobId || state.baseSha !== job.baseSha ||
      (state.branch !== undefined && state.branch !== job.branch) ||
      (state.worktreeRoot !== undefined && state.worktreeRoot !== job.worktreeRoot) ||
      (state.threadId !== undefined && state.threadId !== job.threadId))) {
      throw new Error("Invalid architecture receipt worktree, branch, thread or base identity.");
    }
    if (state) verifyPlanHistory(job, state);
    if (input.action === "run" && (!state || ["awaiting-author", "ready", "committed"].includes(state.phase))) {
      await processAuthorUpdatesAtBoundary(job);
    }
    if (!state) {
      if (input.action !== "run") throw new Error("Start architecture run before inspecting or revising its plan.");
      if (!input.contract && input.mode !== "collaborative") throw new Error("Autonomous architecture requires explicit --contract scope.");
      const head = await trustedHead(job);
      if (dirty(job).length) throw new Error("Architecture requires a clean job worktree.");
      state = { format: 1, jobId: job.jobId, baseSha: job.baseSha, expectedHead: head,
        branch: job.branch, worktreeRoot: job.worktreeRoot, threadId: job.threadId,
        mode: input.mode ?? "autonomous",
        worker: input.fixture ? "fixture" : "pi", provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        history: [], phase: input.contract ? "ready" : "awaiting-author",
        plan: input.contract ? newPlan(parseContract(input.contract)) : undefined };
      await persist(file, state);
    }
    if (input.action === "inspect") return output(job, state, await reconcile(job, state));
    if (input.action === "reconcile") {
      if (!["writing", "authored"].includes(state.phase) ||
          !input.recoveryDigest || !/^[a-f0-9]{64}$/.test(input.recoveryDigest)) {
        throw new Error("Manual reconciliation requires a writing/authored work item and the exact --digest <sha256> of the reviewed files.");
      }
      // This author-initiated transition deliberately does not authorize
      // protected changes. The canonical validator and independent Git gate
      // must still accept the exact reviewed content on the next run.
      assertHead(job, state.expectedHead);
      if (state.worker === "pi") await verifyJobPiSession(job, "architecture", state.piSessionFile, state.piSessionId);
      const paths = await changedPaths(job);
      const digest = await contentDigest(job, paths);
      if (digest !== input.recoveryDigest) throw new Error("Review digest differs from current Story bytes. Inspect again; nothing was adopted.");
      state.paths = paths;
      state.contentDigest = digest;
      state.manuallyReconciled = { paths, digest };
      state.phase = "authored";
      await persist(file, state);
      return output(job, state, await reconcile(job, state));
    }
    if (state.phase === "awaiting-author") {
      if (!input.contract) return output(job, state);
      state.plan = newPlan(parseContract(input.contract)); state.phase = "ready";
      await persist(file, state);
    } else if (input.contract && input.action === "run" && JSON.stringify(parseContract(input.contract)) !== JSON.stringify(state.plan!.contract)) {
      throw new Error("Unauthorized scope/contract change. Propose and explicitly approve an exact versioned plan revision.");
    }
    if (input.action === "propose" || input.action === "approve") {
      const baselineHead = await trustedHead(job);
      if (dirty(job).length || !["ready", "committed"].includes(state.phase)) throw new Error("Replanning requires a clean safe work-item boundary.");
      const recovery = await reconcile(job, state);
      if (recovery.status !== "ready") throw new Error("Replanning requires reconciled verified source: " + recovery.reason);
      if (input.action === "propose") {
        const contract = parseContract(input.contract);
        const carryForward = input.carryForward === undefined ? undefined : parseCarryForward(input.carryForward);
        if (carryForward) verifyCarryForwardCandidates(job, state.plan!.version, baselineHead, carryForward);
        state.proposal = { contract, version: state.plan!.version + 1, baselineHead, carryForward,
          digest: hash(JSON.stringify({ plan: state.plan, head: baselineHead, contract,
            ...(carryForward !== undefined ? { carryForward } : {}) })) };
      } else {
        if (!state.proposal || input.proposal !== state.proposal.digest || !input.approvalFile) {
          throw new Error("Plan approval requires the exact proposal digest and a recorded controller reference.");
        }
        const signed = await readAuthorApproval(job, input.approvalFile);
        const payload = signed.payload;
        if (payload.kind !== "plan" || payload.verifiedHead !== (state.proposal.baselineHead ?? state.expectedHead) ||
            baselineHead !== (state.proposal.baselineHead ?? state.expectedHead) ||
            payload.proposalSha256 !== state.proposal.digest ||
            payload.planVersion !== state.proposal.version) {
          throw new Error("Controller plan approval does not match the exact proposed contract, plan version and verified head.");
        }
        state.history.push({ plan: state.plan!, proposal: state.proposal.digest,
          approvedContract: state.proposal.contract, verifiedHead: baselineHead,
          carryForward: state.proposal.carryForward,
          reason: payload.reason, source: "trusted-controller", signed });
        const prior = state.plan!;
        state.plan = newPlan(state.proposal.contract, state.proposal.version);
        // Accepted architecture remains evidence, not a fresh authorization to rewrite canon.
        if (state.phase === "committed") {
          state.plan.items = prior.items.map(item => ({ ...item, planVersion: state.plan!.version,
            authorization: { ...item.authorization, source: "trusted-controller", planVersion: state.plan!.version } }));
          state.phase = "ready";
          state.executionHead = baselineHead;
          // A newly approved work boundary must never reuse the previous commit's
          // uncommitted file inventory or content digest.
          delete state.paths;
          delete state.contentDigest;
          delete state.manuallyReconciled;
        }
        delete state.proposal;
      }
      await persist(file, state);
      return output(job, state);
    }
    if (input.action !== "run") throw new Error("Unknown architecture action.");
    const recovery = await reconcile(job, state);
    if (recovery.status === "blocked") throw new Error("Architecture recovery blocked: " + recovery.reason);
    if ((input.fixture === true) !== (state.worker === "fixture") || input.mode && input.mode !== state.mode ||
        input.provider && input.provider !== state.provider || input.model && input.model !== state.model) throw new Error("Architecture worker configuration differs from the persisted assignment.");
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : state.snapshot
        ? { discovery: "explicit-only" as const, novelteaSkills: undefined, skillDirs: [], requiredSkills: [] }
        : await loadSkillConfig(undefined, false);
    const source = input.validatorSource ?? input.skillsSource ?? config.novelteaSkills;
    if (!state.snapshot) {
      const snapshot = await createSkillSnapshot({ ...config, novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-story-architecture", "nt-catalog"] });
      if (!snapshot) throw new Error("Architecture requires pinned NovelTea skills.");
      state.snapshot = snapshot; await persist(file, state);
    }
    if (await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path) throw new Error("Architecture skill snapshot identity mismatch.");
    if (state.phase === "committed") {
      if (recovery.actualHead !== state.expectedHead) return output(job, state, recovery);
      assertHead(job, state.expectedHead);
      if (dirty(job).length) throw new Error("Unexpected edits after architecture commit.");
      // The architecture receipt is durable before the shared verified-head
      // marker. Repair a crash in that narrow publication window only when
      // the actual commit still bears the exact recorded provenance.
      if (state.paths?.length && state.contentDigest &&
          state.plan?.items[0]?.verifiedSha === state.expectedHead) {
        if (!git(job, "log", "-1", "--format=%B").includes(`NovelTea-Architecture: ${state.contentDigest}`)) {
          throw new Error("Committed architecture provenance changed; refusing verified-head repair.");
        }
        await publishVerifiedHead(job, git(job, "rev-parse", "HEAD^").trim(), state.expectedHead);
      }
      return output(job, state);
    }
    const Channels = Annotation.Root({ receipt: Annotation<Receipt>() });
    const graph = new StateGraph(Channels)
      .addNode("architecture_specialist", async ({ receipt }) => {
        if (receipt.phase === "authored") return {};
        assertHead(job, receipt.executionHead ?? receipt.expectedHead);
        if (dirty(job).length || receipt.phase === "writing") throw new Error("Interrupted architecture edits/session require inspection; never blindly rerun a writer.");
        const before = reportOf(await validate(source, { ...job, baseSha: receipt.executionHead ?? receipt.expectedHead }));
        if (before.readiness.design.stages.foundation?.minimum !== "passed") throw new Error("Architecture requires a canonical ready Creative Direction.");
        // A focused existing-record request adopts only verified canonical context;
        // it MUST NOT launch the whole-Story architecture writer to invent context.
        if (isFocusedScope(receipt.plan!.contract)) {
          checkArchitecture(before, receipt.plan!.contract);
          receipt.plan!.items[0] = { ...receipt.plan!.items[0]!, status: "verified",
            verifiedSha: receipt.executionHead ?? receipt.expectedHead };
          return {};
        }
        // Reuse verified architecture when it already satisfies the exact newly
        // approved scope; otherwise write an additional coherent architecture unit.
        if (receipt.plan!.items[0]?.status === "verified") {
          try {
            checkArchitecture(before, receipt.plan!.contract);
            return {};
          } catch {
            receipt.plan!.items[0] = workItem("global-architecture", "architecture",
              receipt.plan!.contract.scope.targets, [], receipt.plan!.version);
          }
        }
        await preflightPiAssignment(job, "architecture:" + receipt.plan!.version, receipt.worker === "pi"
          ? { provider: receipt.provider, model: receipt.model } : undefined);
        receipt.phase = "writing"; receipt.plan!.items[0]!.status = "writing";
        await persist(file, receipt);
        if (receipt.worker === "fixture") await fixtureAuthor(job, receipt);
        else {
          const { authorArchitecture } = await import("./architecture-specialist.js");
          Object.assign(receipt, await authorArchitecture(job, receipt.snapshot!, receipt.plan!, receipt.provider, receipt.model,
            async (piSessionId, piSessionFile) => {
              receipt.piSessionId = piSessionId;
              receipt.piSessionFile = piSessionFile;
              await persist(file, receipt);
            }, input.task));
        }
        assertHead(job, receipt.executionHead ?? receipt.expectedHead);
        receipt.paths = await changedPaths(job);
        receipt.contentDigest = await contentDigest(job, receipt.paths);
        receipt.phase = "authored"; await persist(file, receipt);
        return { receipt };
      })
      .addNode("validate_and_commit_architecture", async ({ receipt }) => {
        const head = git(job, "rev-parse", "HEAD").trim();
        const workingHead = receipt.executionHead ?? receipt.expectedHead;
        const recovering = head !== workingHead;
        const verified = await reconcile(job, receipt);
        if (verified.status === "blocked" || (recovering && verified.status !== "recoverable-commit")) {
          throw new Error("Unexpected architecture commit; preserve it for reconciliation: " + verified.reason);
        }
        const latest = await validate(source, { ...job, baseSha: workingHead });
        const report = reportOf(latest);
        if (latest.status !== "passed" || report.protection.status !== "checked" || report.protection.changes.length || report.protection.warnings.length) throw new Error("Architecture cannot revise protected decisions; use scoped revision authorization.");
        // Original baseline is also checked. Existing approved revisions are already
        // trusted at expectedHead; architecture cannot change any existing record outside its scope.
        const original = await validate(source);
        checkOriginalProtection(job, original, workingHead);
        const selected = checkArchitecture(report, receipt.plan!.contract);
        if (receipt.worker === 'pi' && !isFocusedScope(receipt.plan!.contract)) {
          // Reject a stale or invented order BEFORE committing any Story bytes.
          verifiedArchitectureMilestoneOrder(receipt.milestoneOrder,
            selected.filter(record => record.metadata.type === 'milestone').map(record => record.metadata.id));
        }
        if (receipt.paths) {
          if (await contentDigest(job, receipt.paths) !== receipt.contentDigest) throw new Error("Authored architecture bytes changed; do not reuse acceptance.");
          if (receipt.paths.some(path => !selected.some(r => r.path === path))) throw new Error("Architecture wrote records outside the accepted scope.");
          if (!recovering) {
            assertHead(job, workingHead);
            if (JSON.stringify(await changedPaths(job)) !== JSON.stringify(receipt.paths)) throw new Error("Architecture paths changed before commit.");
            git(job, "add", "--", ...receipt.paths.map(p => repoPath(job, p)));
            git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m",
              `Generate Story architecture [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: global-architecture\nNovelTea-Plan-Version: ${receipt.plan!.version}\nNovelTea-Architecture: ${receipt.contentDigest}` +
              (receipt.manuallyReconciled ? `\nNovelTea-Reviewed-Recovery: ${receipt.manuallyReconciled.digest}` : ""));
          }
        }
        if (!receipt.paths && !recovering && receipt.plan!.items[0]?.status !== "verified") {
          throw new Error("Architecture cannot be accepted without a verified existing work item or authored changes.");
        }
        if (dirty(job).length) throw new Error("Architecture commit left unexpected edits.");
        const commit = git(job, "rev-parse", "HEAD").trim();
        const previousHead = workingHead;
        const previousArchitectureHead = receipt.expectedHead;
        const didWriteArchitecture = Boolean(receipt.paths?.length);
        finishPlan(receipt, report, didWriteArchitecture ? commit : previousArchitectureHead);
        if (!didWriteArchitecture) receipt.expectedHead = previousArchitectureHead;
        delete receipt.executionHead;
        await persist(file, receipt);
        if (didWriteArchitecture && commit !== previousHead) {
          await publishVerifiedHead(job, previousHead, commit);
          await finalizeRecoveryCheckpoint(job, "global-architecture", previousHead, commit);
        }
        return { receipt };
      })
      .addEdge(START, "architecture_specialist").addEdge("architecture_specialist", "validate_and_commit_architecture")
      .addEdge("validate_and_commit_architecture", END).compile();
    const result = await graph.invoke({ receipt: state });
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    const { scheduleIdeasAtBoundary } = await import("./idea-placement.js");
    await scheduleIdeasAtBoundary(job, "architecture");
    return { ...output(job, result.receipt), authorUpdates };
  };
  return alreadyLocked ? execute() : withStoryJobLock(job, "global-architecture", execute);
}
