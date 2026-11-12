import { createPiStatusTool } from "./pi-work-status.js";
import { execFileSync } from "./git-read-cache.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { CompletionContract, PlannedFocusCreate } from "./architecture.js";
import { withStoryJobLock } from "./job-lock.js";
import { startStoryJob } from "./job.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";
import { loadSkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { preparePiContext, piNarrativeGroup, preflightPiAssignment } from "./job-pi-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { selectSandboxPiTools } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { resolveFocusedScope, type CanonicalScopeRecord } from "./focused-scope.js";
import { readTurnEvidence, assertFocusedTurnAssignment } from "./turn-plan-evidence.js";
import { creativePolicyInstruction, DEFAULT_CREATIVE_POLICY, type CreativePolicy } from "./creative-policy.js";

interface Receipt {
  version: 1; jobId: string; workItemId: string; planVersion: number; contractDigest: string;
  expectedHead: string; phase: "pending" | "writing" | "authored" | "committed";
  target: string; paths: string[]; context: string[]; worker: "fixture" | "pi";
  provider: string; model: string; snapshot?: SkillSnapshot; piSessionFile?: string;
  sha256?: string; commitSha?: string; assignmentDigest?: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const repoPath = (job: JobStartResult, p: string) => job.storyRelativePath ? job.storyRelativePath + "/" + p : p;
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}
async function save(path: string, value: Receipt) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
function changes(job: JobStartResult) {
  return git(job, "status", "--porcelain=v1", "-z", "--untracked-files=all").toString()
    .split("\0").filter(Boolean);
}
function reportOf(result: ValidationResult, head: string) {
  const report = result.report as { records?: CanonicalScopeRecord[]; diagnostics?: unknown[];
    protection?: { status?: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (result.status !== "passed" || !Array.isArray(report?.records) ||
      report.diagnostics?.length || report.protection?.status !== "checked" ||
      report.protection.base !== head || report.protection.changes?.length ||
      report.protection.warnings?.length)
    throw new Error("Focused scope requires complete canonical structure/protected-decision verification: " +
      JSON.stringify(result).slice(0, 3500));
  return report.records;
}
function skillFor(target: string) {
  const type = target.split(".")[0];
  if (type === "character" || type === "relationship") return "nt-character-development";
  if (type === "world-entity" || type === "fact" || type === "revelation") return "nt-worldbuilding";
  if (type === "event") return "nt-event-design";
  if (type === "authored-content") return "nt-narrative-composition";
  if (type === "choice-point" || type === "puzzle") return "nt-interactive-narrative";
  throw new Error("A direct focus specialist is not available for " + target + "; select an Arc or Milestone scope.");
}
/** Deterministic fixture output exercises the same canonical/native/Git gates.
 * It is never evidence of model-authored literary quality. */
function fixtureCreatedRecord(create: PlannedFocusCreate, contract: CompletionContract,
  catalog: CanonicalScopeRecord[]): string {
  const type = create.id.split(".")[0]!;
  const base = ["---", "schema: '0.1'", "type: " + type, "id: " + create.id,
    "title: " + JSON.stringify(create.title), "status: draft", "decisions: []"];
  const list = (values: string[]) => "[" + values.join(", ") + "]";
  const title = (id: string) => {
    const record = catalog.find(item => item.metadata.id === id);
    const planned = contract.scope.creates?.find(item => item.id === id);
    return String(record?.metadata.title ?? planned?.title ?? id.split(".")[1]);
  };
  if (type === "character") return [...base, "motivation: Seek an honest, consequential exchange.",
    "---", "# " + create.title,
    "This Character wants to be heard without sacrificing trust. They enter the conversation with a concrete reason to listen.\n"].join("\n");
  if (type === "relationship") return [...base,
    "characters: " + list(create.references), "initial: estranged", "---", "# " + create.title,
    "The speakers must negotiate trust rather than assume it. Their conversation can establish mutual understanding.\n"].join("\n");
  if (type === "event") return [...base,
    "participants: " + list(create.references.filter(id => id.startsWith("character."))),
    "arcs: " + list(create.references.filter(id => id.startsWith("arc."))),
    "after: []", "prerequisites:", "  any_of:", "    - completed: []", "      not_completed: []",
    "consequences:", "  - Both speakers confront what they have withheld.",
    "steps:", "  - id: exchange", "    branches:", "      - id: continue",
    "        conditions: []",
    "        effects: " + (create.references.some(id => id.startsWith("relationship."))
      ? "[{kind: relationship, relationship: " +
        create.references.find(id => id.startsWith("relationship.")) + ", value: trusting}]"
      : "[]"), "---", "# The conversation",
    "Both Characters choose to meet and trade information. The encounter has a discernible beginning and consequence.\n"].join("\n");
  if (type === "authored-content") {
    const event = contract.scope.creates?.find(item => item.id === create.references[0]);
    const eventRecord = catalog.find(item => item.metadata.id === create.references[0]);
    const speakers = (event?.references.filter(id => id.startsWith("character.")) ??
      (Array.isArray(eventRecord?.metadata.participants)
        ? eventRecord.metadata.participants.filter((id): id is string => typeof id === "string") : []))
      .slice(0, 2).map(title);
    const first = speakers[0] ?? "First speaker", second = speakers[1] ?? "Second speaker";
    return [...base, "events: " + list(create.references), "revelations: []", "---",
      "# " + create.title,
      "A quiet moment settles between " + first + " and " + second + " before either speaks.",
      "", "**" + first + ":** “I wanted to ask what you really knew.”",
      "", "**" + second + ":** “I was waiting for someone willing to listen.”",
      "", "**" + first + ":** “Then we should begin with the truth.”",
      "", "The silence that follows is different from the one that came before.\n"].join("\n");
  }
  throw Error("No focused creation fixture for " + create.id);
}

async function writeWithPi(job: JobStartResult, receipt: Receipt, task: string,
  outcome?: string, policy: CreativePolicy = DEFAULT_CREATIVE_POLICY,
  create?: PlannedFocusCreate) {
  const skill = skillFor(receipt.target);
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config = { discovery: "explicit-only" as const, novelteaSkills: receipt.snapshot!.path,
    skillDirs: [], requiredSkills: [skill, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  if (loader.getSkills().diagnostics.some(d => d.type === "error") ||
      [skill, "nt-catalog"].some(s => !loader.getSkills().skills.some(v =>
        v.name === s && v.filePath.startsWith(join(receipt.snapshot!.path, "skills") + sep))))
    throw new Error("Focused specialist lacks pinned, verifiable skill instructions.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: piNarrativeGroup("focused", receipt.context, receipt.target),
    step: receipt.workItemId + ":" + receipt.planVersion,
    paths: receipt.context, snapshot: receipt.snapshot!.id, provider: receipt.provider,
    model: receipt.model, directory: join(job.stateDir, "focused-sessions", receipt.target),
    task: { kind: receipt.target.startsWith("event.") ? "event" :
      receipt.target.startsWith("puzzle.") || receipt.target.startsWith("choice-point.") ? "puzzle" :
      receipt.target.startsWith("authored-content.") ? "dialogue" : "character",
      ids: [receipt.target], scope: "focused" },
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, receipt.snapshot!, loader.getSkills().skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: [...(sandboxTools ?? []), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: [...(create ? ["write"] : []),
      "read", "edit", "grep", "find", "ls", "story_context", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw new Error("Focused specialist did not honor the pinned reasoning profile.");
    const file = session.sessionManager.getSessionFile();
    if (file) { receipt.piSessionFile = file; await save(join(job.stateDir,
      "focused-items", receipt.target + ".json"), receipt); }
    await context.beforeTurn(file ?? undefined);
    const required = [join(receipt.snapshot!.path, "skills", skill, "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "SKILL.md"),
      join(receipt.snapshot!.path, "skills", "nt-catalog", "references", "records.md")];
    await promptStorySpecialist(session, context.contextNote +
      "You are a narrowly scoped NovelTea " + skill + " revision specialist. FIRST read all pinned guidance using read:\n" +
      required.join("\n") + "\nBegin with these relevant Story sources:\n" +
      receipt.context.join("\n") + "\nYou may use read, grep, find, ls and story_context to inspect " +
      "additional canonical Story records and discover typed dependencies. Discovery is READ-ONLY, " +
      "never write authority; do not inspect private inboxes.\n" +
      (create ? "Create ONLY this new canonical Markdown file with schema 0.1, exact type/id/title and typed references:\n" +
        JSON.stringify(create) + "\nDo not alter any preexisting files. Write substantive narrative content, " +
        "not a placeholder, including actual in-scene character dialogue for Authored Content. " :
        "Only edit these PREEXISTING canonical Markdown files:\n" + receipt.paths.join("\n")) +
      "\nAll other files are READ-ONLY context (including upstream prerequisites, milestones, Arcs, and all sibling records). " +
      "Do not create any other files, use git commands, invoke untrusted shell commands, or change protected author decisions. " +
      "Preserve typed references and branch behavior. If a requested change requires additional records or upstream decisions, " +
      "report that obstacle and stop without touching unauthorized files. Do not claim incomplete/delegated work is finished. " +
      "The parent independently checks your precise Git diff and protected canonical validation.\n" +
      creativePolicyInstruction(policy) +
      "Original Turn goal: " + task + "\nSpecialist assignment outcome: " +
      (outcome ?? "Revise only the authorized record against the user request."));
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw new Error("Focused Pi specialist failed or was interrupted.");
    const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const reads = session.messages.flatMap(m => m.role === "assistant" ?
      m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
        c.type === "toolCall" && c.name === "read" && completed.has(c.id)) : [])
      .map(c => canonicalPinnedReadPath(String(c.arguments.path ?? ""), project.root, receipt.snapshot!.path));
    if (required.some(path => !reads.includes(path)))
      throw new Error("Focused Pi specialist failed to read pinned skill guidance.");
  } finally { session.dispose(); }
}
export interface FocusedWorkOptions {
  story: string; job: string; target: string; task: string; contract: CompletionContract;
  fixture: boolean; skillsSource?: string; validatorSource?: string; provider?: string; model?: string;
  turnPlanDigest?: string;
}
export async function runFocusedWorkItem(input: FocusedWorkOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  return withStoryJobLock(job, "focus:" + input.target, async () => {
    const archPath = join(job.stateDir, "architecture.json");
    if (!existsSync(archPath)) throw new Error("Focused work requires a versioned canonical completion contract.");
    const arch = JSON.parse(await readFile(archPath, "utf8")) as {
      jobId: string; phase: string; plan?: { version: number; contract: CompletionContract } };
    if (arch.jobId !== job.jobId || arch.phase !== "committed" || !arch.plan ||
        JSON.stringify(arch.plan.contract) !== JSON.stringify(input.contract))
      throw new Error("Focused work is not authorized by the pinned versioned completion contract.");
    const plan = arch.plan;
    if (!input.contract.scope.targets.includes(input.target))
      throw new Error("Focused target is outside the explicit completion contract.");
    const file = join(job.stateDir, "focused-items", input.target + ".json");
    const current = await trustedHead(job);
    const actual = git(job, "rev-parse", "HEAD").toString().trim();
    if (changes(job).length || actual !== current) throw new Error("Focused worktree has changes requiring explicit reconciliation.");
    const validation = await validateStoryJob(job, input.validatorSource ?? input.skillsSource, { ...job, baseSha: current });
    const selection = resolveFocusedScope(reportOf(validation, current), input.contract);
    const create = input.contract.scope.creates?.find(item => item.id === input.target);
    const own = selection.selected.find(r => r.metadata.id === input.target);
    if (!own) throw new Error("Unknown focused target: " + input.target);
    // Shared supporting targets are authorized exactly once, with the first target.
    const paths = [own.path, ...(input.target === input.contract.scope.targets[0] ? selection.selected
      .filter(r => input.contract.scope.supportingTargets?.includes(r.metadata.id)).map(r => r.path) : [])].sort();
    const types = [...new Set(paths.map(path => selection.selected.find(r => r.path === path)?.metadata.type))];
    if (types.some(type => !type)) throw new Error("A specialist path has no canonical record type.");
    const turnPlan = await readTurnEvidence(job, input.contract, input.task, input.turnPlanDigest);
    if (create && (!turnPlan || !input.turnPlanDigest))
      throw new Error("Focused creation requires the original source-bound authenticated Turn assignment.");
    const turnAssignment = turnPlan ? assertFocusedTurnAssignment(turnPlan, input.target, paths,
      types as string[]) : null;
    const turnAssignmentDigest = turnPlan?.digest;
    // Refuse symlinked / substituted records BEFORE Pi receives editing tools.
    for (const path of paths) {
      if (create && path === create.path) continue;
      const full = join(job.worktreeStoryRoot, path);
      if (await realpath(full) !== full || !(await lstat(full)).isFile())
        throw new Error("Focused record is not a safe regular canonical file: " + path);
    }
    const contractDigest = digest(JSON.stringify(plan.contract));
    let receipt: Receipt | undefined = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
    if (receipt) {
      if (receipt.jobId !== job.jobId || receipt.target !== input.target ||
          receipt.contractDigest !== contractDigest || receipt.planVersion !== plan.version ||
          JSON.stringify(receipt.paths) !== JSON.stringify(paths) ||
          receipt.worker !== (input.fixture ? "fixture" : "pi") ||
          receipt.assignmentDigest !== turnAssignmentDigest)
        throw new Error("Focused work-item provenance differs from the original authorization.");
      if (receipt.phase === "committed") {
        if (!receipt.commitSha || !receipt.sha256) throw new Error("Missing focused commit verification evidence.");
        git(job, "merge-base", "--is-ancestor", receipt.commitSha, current);
        const message = git(job, "log", "-1", "--format=%B", receipt.commitSha).toString();
        if (!message.split("\n").includes("NovelTea-Work-Item: " + receipt.workItemId))
          throw new Error("Committed focused work has invalid provenance.");
        return { status: "focused-committed", headSha: receipt.commitSha, paths };
      }
      if (receipt.phase === "writing" || receipt.phase === "authored")
        throw new Error("Interrupted focused writer: inspect preserved session and Git worktree; do not automatically replay.");
    } else {
      receipt = { version: 1, jobId: job.jobId, workItemId: "focus:" + input.target,
        planVersion: plan.version, contractDigest, expectedHead: current,
        phase: "pending", target: input.target, paths,
        context: selection.context.filter(r => r.metadata.status !== "planned")
          .map(r => r.path).sort(), worker: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        ...(turnAssignmentDigest ? { assignmentDigest: turnAssignmentDigest } : {}) };
      await save(file, receipt);
    }
    if (receipt.expectedHead !== current)
      throw new Error("Focused work was initialized against a different verified HEAD; inspect before writing.");
    if (create) {
      const full = join(job.worktreeStoryRoot, create.path);
      if (existsSync(full))
        throw new Error("Focused creation path already exists; never overwrite canonical Story bytes.");
      // Only the preauthorized canonical record directory may be materialized.
      await mkdir(dirname(full), { recursive: true });
      if (await realpath(dirname(full)) !== dirname(full))
        throw new Error("Focused creation directory is a symlink or unsafe path.");
    }
    const config = input.skillsSource
      ? { discovery: "explicit-only" as const, novelteaSkills: input.skillsSource, skillDirs: [], requiredSkills: [] }
      : await loadSkillConfig(undefined, false);
    if (!receipt.snapshot) {
      const requiredSkills = [skillFor(input.target), "nt-catalog"];
      const snapshot = await createSkillSnapshot({ ...config, requiredSkills });
      if (!snapshot) throw new Error("Focused work requires pinned canonical skills.");
      receipt.snapshot = snapshot; await save(file, receipt);
    }
    if (await openSkillSnapshot(receipt.snapshot.id) !== receipt.snapshot.path)
      throw new Error("Focused skill snapshot changed.");
    await preflightPiAssignment(job, receipt.workItemId + ":" + plan.version,
      input.fixture ? undefined : { provider: receipt.provider, model: receipt.model });
    receipt.phase = "writing"; await save(file, receipt);
    if (input.fixture) {
      for (const path of paths) {
        if (create && path === create.path) {
          await writeFile(join(job.worktreeStoryRoot, path),
            fixtureCreatedRecord(create, input.contract, selection.context), { flag: "wx" });
        } else {
          const original = await readFile(join(job.worktreeStoryRoot, path), "utf8");
          await writeFile(join(job.worktreeStoryRoot, path), original + "\nFocused revision: " + input.task + "\n");
        }
      }
      if (process.env.NT_FOCUS_FIXTURE_CASE === "unauthorized-edit") {
        const outside = selection.context.find(r => !paths.includes(r.path));
        if (!outside) throw new Error("Unauthorized-edit fixture requires an upstream context record.");
        const path = join(job.worktreeStoryRoot, outside.path);
        await writeFile(path, await readFile(path, "utf8") + "\nUnauthorized fixture change\n");
      }
    } else await writeWithPi(job, receipt, input.task, turnAssignment?.outcome,
      turnPlan?.creativePolicy ?? DEFAULT_CREATIVE_POLICY, create);
    const edited = changes(job);
    const statusPath = (entry: string) => entry.slice(3).replace(
      job.storyRelativePath ? job.storyRelativePath + "/" : "", "");
    if (!edited.length || edited.some(entry =>
      !paths.includes(statusPath(entry)) ||
      entry.slice(0, 2) !== (create && statusPath(entry) === create.path ? "??" : " M")) ||
      (create && !edited.some(entry => statusPath(entry) === create.path && entry.startsWith("??"))))
      throw new Error("Focused work changed a file outside its explicit authority; preserve edits for manual reconciliation.");
    if (git(job, "rev-parse", "HEAD").toString().trim() !== current)
      throw new Error("Focused Story HEAD changed during writer execution.");
    for (const entry of edited) {
      const path = entry.slice(3).replace(job.storyRelativePath ? job.storyRelativePath + "/" : "", "");
      const full = join(job.worktreeStoryRoot, path);
      if ((await realpath(full)) !== full || !(await lstat(full)).isFile())
        throw new Error("Unsafe focused record path; preserve changes for inspection.");
    }
    const after = await validateStoryJob(job, input.validatorSource ?? input.skillsSource, { ...job, baseSha: current });
    const accepted = reportOf(after, current);
    if (create && !accepted.some(item => item.metadata.id === create.id &&
        item.metadata.type === create.id.split(".")[0] && item.path === create.path &&
        item.metadata.status !== "superseded"))
      throw new Error("Native canonical validation did not recognize the exact new focused record.");
    resolveFocusedScope(accepted, input.contract);
    receipt.sha256 = digest(JSON.stringify(await Promise.all(paths.map(async path =>
      [path, digest(await readFile(join(job.worktreeStoryRoot, path), "utf8"))]))));
    receipt.phase = "authored"; await save(file, receipt);
    git(job, "add", "--", ...paths.map(path => repoPath(job, path)));
    git(job, "-c", "user.name=NovelTea Generator", "-c", "user.email=noveltea-gen@users.noreply.github.com",
      "commit", "-m", (create ? "Create" : "Revise") + " focused Story record " + input.target + "\n\n" +
      "NovelTea-Job: " + job.jobId + "\nNovelTea-Work-Item: " + receipt.workItemId +
      "\nNovelTea-Plan-Version: " + plan.version + "\nNovelTea-Focused-Digest: " + receipt.sha256);
    if (changes(job).length) throw new Error("Focused commit left unexpected dirty worktree.");
    receipt.commitSha = git(job, "rev-parse", "HEAD").toString().trim();
    receipt.phase = "committed"; await save(file, receipt);
    const headFile = join(job.stateDir, "revisions", "verified-head.json");
    const previous = existsSync(headFile) ? JSON.parse(await readFile(headFile, "utf8")) as {
      jobId: string; headSha: string; version: number } : undefined;
    if (previous && (previous.jobId !== job.jobId || previous.headSha !== current))
      throw new Error("Verified HEAD changed during focused commit; manual reconciliation required.");
    await mkdir(dirname(headFile), { recursive: true });
    const headTemp = headFile + "." + randomUUID() + ".tmp";
    await writeFile(headTemp, JSON.stringify({ version: 1, jobId: job.jobId, headSha: receipt.commitSha,
      workItemId: receipt.workItemId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(headTemp, headFile);
    await finalizeRecoveryCheckpoint(job, receipt.workItemId, current, receipt.commitSha!);
    return { status: "focused-committed", headSha: receipt.commitSha, paths };
  });
}
