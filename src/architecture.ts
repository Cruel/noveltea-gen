import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startStoryJob, type JobStartResult } from "./job.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { trustedHead } from "./revision.js";

export interface CompletionContract {
  scope: { kind: "full-story" | "partial"; depth: "architecture" | "interactive" | "composition";
    targets: string[]; branches: string[] };
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
  authorization: { source: "explicit-author-cli"; planVersion: number; paths: string[] };
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
  mode: "autonomous" | "collaborative";
  worker: "fixture" | "pi";
  provider: string;
  model: string;
  snapshot?: SkillSnapshot;
  plan?: Plan;
  history: Array<{ plan: Plan; proposal: string; reason: string; source: "explicit-author-cli" }>;
  proposal?: { digest: string; contract: CompletionContract; version: number };
  phase: "awaiting-author" | "ready" | "writing" | "authored" | "committed";
  paths?: string[];
  contentDigest?: string;
  piSessionFile?: string;
  skillReads?: string[];
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
  story: string; job: string; action: "run" | "inspect" | "propose" | "approve";
  contract?: unknown; mode?: "autonomous" | "collaborative";
  skillsSource?: string; validatorSource?: string; fixture?: boolean; provider?: string; model?: string;
  proposal?: string; reason?: string;
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
function parseContract(value: unknown): CompletionContract {
  const c = value as CompletionContract;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string" && x.trim());
  if (!c || !["full-story", "partial"].includes(c.scope?.kind) ||
      !["architecture", "interactive", "composition"].includes(c.scope?.depth) ||
      !strings(c.scope.targets) || !strings(c.scope.branches) || !strings(c.constraints) ||
      typeof c.envelope?.presentation !== "string" || !c.envelope.presentation.trim() ||
      !strings(c.envelope.hardLimits) || !strings(c.envelope.preferences) ||
      !c.scope.targets.every(id => /^(arc|milestone)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id))) {
    throw new Error("Invalid completion contract: specify scope kind/depth/targets/branches, constraints, and a production envelope.");
  }
  if (c.scope.kind === "full-story" && (c.scope.depth !== "composition" || c.scope.targets.length || c.scope.branches.length)) {
    throw new Error("Full-Story scope requires composition depth and cannot exclude targets or branches; use partial scope for an outline.");
  }
  return { scope: { ...c.scope, targets: [...new Set(c.scope.targets)], branches: [...new Set(c.scope.branches)] },
    constraints: c.constraints, envelope: c.envelope };
}
function workItem(id: string, kind: WorkItem["kind"], targetIds: string[], dependencies: string[], version: number): WorkItem {
  const skills = { architecture: ["nt-story-architecture", "nt-catalog"], realization: ["nt-event-design", "nt-interactive-narrative", "nt-catalog"],
    composition: ["nt-narrative-composition", "nt-catalog"], review: ["nt-narrative-review", "nt-catalog"] };
  return { id, kind, targetIds, dependencies, skills: skills[kind],
    checks: kind === "architecture" ? ["canonical-structure", "protected-decisions", "scope-architecture-coverage"] :
      kind === "review" ? ["independent-editorial-review", "constraints-and-envelope", "branch-coverage"] : ["canonical-structure", "realize-in-scope-obligations"],
    authorization: { source: "explicit-author-cli", planVersion: version, paths: kind === "architecture" ? ["arcs/*.md", "milestones/*.md"] : [] },
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
  if (!arcs.length || !milestones.length || arcs.some(a => !milestones.some(m => m.metadata.arcs?.includes(a.metadata.id))) ||
      report.outstanding.some(o => ids.has(o.id) && ["foundation", "architecture"].includes(o.requiredBy))) {
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
    if (repoPath(job, local) !== path || !/^(arcs|milestones)\/[a-z][a-z0-9-]*\.md$/.test(local)) {
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
async function fixtureAuthor(job: JobStartResult, state: Receipt) {
  const targets = state.plan!.contract.scope.targets;
  const arc = targets.find(id => id.startsWith("arc.")) ?? "arc.truth";
  const milestone = targets.find(id => id.startsWith("milestone.")) ?? "milestone.disclosure";
  const records = [
    { folder: "arcs", id: arc, type: "arc", fields: 'dramatic_question: "Can truth survive loyalty?"\ncharacters: []',
      body: "The inquiry puts a friendship under pressure. Each admission makes concealment harder, until loyalty must mean either silence or accountability." },
    { folder: "milestones", id: milestone, type: "milestone", fields: `completeness: partial\nchange: "The hidden evidence becomes a shared responsibility"\narcs: [${arc}]\nfulfillment: {any_of: []}`,
      body: "The investigator can no longer act alone once the witness discloses the evidence. A future conversation could earn this disclosure through trust; an evidence-led confrontation is another possible route. Event design must establish the prerequisites and consequences before either route is bound. Reuse the inquiry setting and express the revelation through dialogue." },
  ];
  for (const r of records) {
    const path = join(job.worktreeStoryRoot, r.folder, r.id.split(".")[1] + ".md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nschema: '0.1'\ntype: ${r.type}\nid: ${r.id}\ntitle: "${r.id}"\nstatus: draft\ndecisions: []\n${r.fields}\n---\n\n${r.body}\n`, { flag: "wx" });
  }
}
async function publishVerifiedHead(job: JobStartResult, previous: string, commit: string) {
  const file = join(dirname(job.worktreeRoot), "revisions", "verified-head.json");
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

function finishPlan(state: Receipt, report: CatalogReport, commit: string) {
  const plan = state.plan!;
  const selected = checkArchitecture(report, plan.contract);
  const ids = new Set(selected.map(r => r.metadata.id));
  plan.items[0] = { ...plan.items[0]!, targetIds: selected.filter(r => ["arc", "milestone"].includes(r.metadata.type)).map(r => r.metadata.id), status: "verified", verifiedSha: commit };
  const obligations = report.outstanding.filter(o => ids.has(o.id));
  const clusters = [...new Set(obligations.map(o => o.id))].map(id => workItem("realize-" + id.replace(".", "-"), "realization", [id], ["global-architecture"], plan.version));
  for (const item of clusters) { item.status = "blocked"; item.blockingReason = "Tracked downstream obligation; execute with the Event/interactive specialist in a later work unit."; }
  plan.items = [plan.items[0], ...clusters];
  if (plan.contract.scope.depth !== "architecture") {
    plan.items.push(workItem("compose-scope", "composition", [...ids], clusters.length ? clusters.map(c => c.id) : ["global-architecture"], plan.version));
  }
  const reviewDependencies = plan.contract.scope.depth !== "architecture"
    ? ["compose-scope"]
    : clusters.length ? clusters.map(item => item.id) : ["global-architecture"];
  plan.items.push(workItem("review-scope", "review", [...ids], reviewDependencies, plan.version));
  state.outstanding = report.outstanding;
  state.phase = "committed";
  state.expectedHead = commit;
}
function output(job: JobStartResult, state: Receipt) {
  const complete = state.phase === "committed" && state.plan?.contract.scope.kind === "partial" && state.plan.contract.scope.depth === "architecture";
  return { status: state.phase === "awaiting-author" ? "awaiting-author" : complete ? "complete-in-scope" : state.phase === "committed" ? "architecture-committed" : state.phase,
    jobId: job.jobId, branch: job.branch, worktreeStoryRoot: job.worktreeStoryRoot, headSha: state.expectedHead,
    plan: state.plan, proposal: state.proposal, history: state.history, outstanding: state.outstanding ?? [],
    completionEvidence: { structuralArchitecture: state.phase === "committed", editorial: "unverified",
      constraintsAndEnvelope: "unverified", branchExecution: state.plan?.contract.scope.branches.length ? "unverified" : "not-requested",
      fullStory: false },
    questions: state.phase === "awaiting-author" ? "Supply --contract with kind, depth, target IDs, branch constraints and production envelope; no Story writes have occurred." : undefined,
    piSessionFile: state.piSessionFile, skillReads: state.skillReads, skillSnapshot: state.snapshot?.id };
}
export async function runArchitectureJob(input: ArchitectureOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const file = join(dirname(job.worktreeRoot), "architecture.json");
  const lock = join(dirname(job.worktreeRoot), ".story-writing");
  // Initial validator pinning updates job.json; reopen the durable manifest before each validation.
  const validate = async (source?: string, view?: { worktreeRoot: string; worktreeStoryRoot: string; baseSha: string }) =>
    validateStoryJob(await startStoryJob({ story: input.story, job: input.job }, false), source, view);
  try { await mkdir(lock); } catch { throw new Error("Story writer is running or interrupted; inspect its lock and worktree."); }
  try {
    let state: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    if (state && (state.format !== 1 || state.jobId !== job.jobId || state.baseSha !== job.baseSha)) throw new Error("Invalid architecture receipt identity.");
    if (!state) {
      if (input.action !== "run") throw new Error("Start architecture run before inspecting or revising its plan.");
      if (!input.contract && input.mode !== "collaborative") throw new Error("Autonomous architecture requires explicit --contract scope.");
      const head = await trustedHead(job);
      if (dirty(job).length) throw new Error("Architecture requires a clean job worktree.");
      state = { format: 1, jobId: job.jobId, baseSha: job.baseSha, expectedHead: head, mode: input.mode ?? "autonomous",
        worker: input.fixture ? "fixture" : "pi", provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        history: [], phase: input.contract ? "ready" : "awaiting-author",
        plan: input.contract ? newPlan(parseContract(input.contract)) : undefined };
      await persist(file, state);
    }
    if (input.action === "inspect") return output(job, state);
    if (state.phase === "awaiting-author") {
      if (!input.contract) return output(job, state);
      state.plan = newPlan(parseContract(input.contract)); state.phase = "ready";
      await persist(file, state);
    } else if (input.contract && input.action === "run" && JSON.stringify(parseContract(input.contract)) !== JSON.stringify(state.plan!.contract)) {
      throw new Error("Unauthorized scope/contract change. Propose and explicitly approve an exact versioned plan revision.");
    }
    if (input.action === "propose" || input.action === "approve") {
      assertHead(job, state.expectedHead);
      if (dirty(job).length || !["ready", "committed"].includes(state.phase)) throw new Error("Replanning requires a clean safe work-item boundary.");
      if (input.action === "propose") {
        const contract = parseContract(input.contract);
        state.proposal = { contract, version: state.plan!.version + 1,
          digest: hash(JSON.stringify({ plan: state.plan, head: state.expectedHead, contract })) };
      } else {
        if (!state.proposal || input.proposal !== state.proposal.digest || !input.reason?.trim()) throw new Error("Plan approval requires the exact proposal digest and explicit author reason.");
        state.history.push({ plan: state.plan!, proposal: state.proposal.digest, reason: input.reason, source: "explicit-author-cli" });
        const prior = state.plan!;
        state.plan = newPlan(state.proposal.contract, state.proposal.version);
        // Accepted architecture remains evidence, not a fresh authorization to rewrite canon.
        if (state.phase === "committed") {
          state.plan.items = prior.items.map(item => ({ ...item, planVersion: state.plan!.version,
            authorization: { ...item.authorization, planVersion: state.plan!.version } }));
          state.phase = "ready";
          // A newly approved work boundary must never reuse the previous commit's
          // uncommitted file inventory or content digest.
          delete state.paths;
          delete state.contentDigest;
        }
        delete state.proposal;
      }
      await persist(file, state);
      return output(job, state);
    }
    if (input.action !== "run") throw new Error("Unknown architecture action.");
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
        assertHead(job, receipt.expectedHead);
        if (dirty(job).length || receipt.phase === "writing") throw new Error("Interrupted architecture edits/session require inspection; never blindly rerun a writer.");
        const before = reportOf(await validate(source, { ...job, baseSha: receipt.expectedHead }));
        if (before.readiness.design.stages.foundation?.minimum !== "passed") throw new Error("Architecture requires a canonical ready Creative Direction.");
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
        receipt.phase = "writing"; receipt.plan!.items[0]!.status = "writing";
        await persist(file, receipt);
        if (receipt.worker === "fixture") await fixtureAuthor(job, receipt);
        else {
          const { authorArchitecture } = await import("./architecture-specialist.js");
          Object.assign(receipt, await authorArchitecture(job, receipt.snapshot!, receipt.plan!, receipt.provider, receipt.model,
            async piSessionFile => { receipt.piSessionFile = piSessionFile; await persist(file, receipt); }));
        }
        assertHead(job, receipt.expectedHead);
        receipt.paths = await changedPaths(job);
        receipt.contentDigest = await contentDigest(job, receipt.paths);
        receipt.phase = "authored"; await persist(file, receipt);
        return { receipt };
      })
      .addNode("validate_and_commit_architecture", async ({ receipt }) => {
        const head = git(job, "rev-parse", "HEAD").trim();
        const recovering = head !== receipt.expectedHead;
        if (recovering && (git(job, "rev-parse", "HEAD^").trim() !== receipt.expectedHead ||
            !git(job, "log", "-1", "--format=%B").includes(`NovelTea-Architecture: ${receipt.contentDigest}`) || dirty(job).length)) {
          throw new Error("Unexpected architecture commit; preserve it for reconciliation.");
        }
        const latest = await validate(source, { ...job, baseSha: receipt.expectedHead });
        const report = reportOf(latest);
        if (latest.status !== "passed" || report.protection.status !== "checked" || report.protection.changes.length || report.protection.warnings.length) throw new Error("Architecture cannot revise protected decisions; use scoped revision authorization.");
        // Original baseline is also checked. Existing approved revisions are already
        // trusted at expectedHead; architecture cannot change any existing record outside its scope.
        const original = await validate(source);
        checkOriginalProtection(job, original, receipt.expectedHead);
        const selected = checkArchitecture(report, receipt.plan!.contract);
        if (receipt.paths) {
          if (await contentDigest(job, receipt.paths) !== receipt.contentDigest) throw new Error("Authored architecture bytes changed; do not reuse acceptance.");
          if (receipt.paths.some(path => !selected.some(r => r.path === path))) throw new Error("Architecture wrote records outside the accepted scope.");
          if (!recovering) {
            assertHead(job, receipt.expectedHead);
            if (JSON.stringify(await changedPaths(job)) !== JSON.stringify(receipt.paths)) throw new Error("Architecture paths changed before commit.");
            git(job, "add", "--", ...receipt.paths.map(p => repoPath(job, p)));
            git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com", "commit", "-m",
              `Generate Story architecture [${job.jobId}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: global-architecture\nNovelTea-Plan-Version: ${receipt.plan!.version}\nNovelTea-Architecture: ${receipt.contentDigest}`);
          }
        }
        if (!receipt.paths && !recovering && receipt.plan!.items[0]?.status !== "verified") {
          throw new Error("Architecture cannot be accepted without a verified existing work item or authored changes.");
        }
        if (dirty(job).length) throw new Error("Architecture commit left unexpected edits.");
        const commit = git(job, "rev-parse", "HEAD").trim();
        const previousHead = receipt.expectedHead;
        finishPlan(receipt, report, commit);
        await persist(file, receipt);
        if (commit !== previousHead) await publishVerifiedHead(job, previousHead, commit);
        return { receipt };
      })
      .addEdge(START, "architecture_specialist").addEdge("architecture_specialist", "validate_and_commit_architecture")
      .addEdge("validate_and_commit_architecture", END).compile();
    const result = await graph.invoke({ receipt: state });
    return output(job, result.receipt);
  } finally { await rmdir(lock).catch(() => undefined); }
}
