import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { renderFoundation, type FoundationDraft } from "./demo.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { loadSkillConfig, type SkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { validateStoryJob, type ValidationResult } from "./validator.js";

type Mode = "autonomous" | "collaborative";
type Stage = "awaiting-author" | "writing" | "committed";
const REQUIRED = [
  "nt-story-discovery/SKILL.md",
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
] as const;
const WORK_ITEM = "foundation";
const AGENT_NAME = "NovelTea Generator";
const AGENT_EMAIL = "noveltea-gen@users.noreply.github.com";

interface FoundationState {
  version: 1;
  jobId: string;
  baseSha: string;
  mode: Mode;
  workerMode: "pi" | "fixture";
  provider: string;
  model: string;
  task: string;
  envelope: string;
  authorInput?: string;
  questions?: string;
  discoverySessionId?: string;
  discoverySessionFile?: string;
  snapshot: SkillSnapshot;
  stage: Stage;
  target?: string;
  piSessionId?: string;
  piSessionFile?: string;
  skillReads?: string[];
  commitSha?: string;
  validation?: "passed" | "unverified-empty-baseline";
}

export interface FoundationJobOptions {
  story: string;
  job: string;
  task?: string;
  envelope?: string;
  mode?: Mode;
  authorInput?: string;
  skillsSource?: string;
  validatorSource?: string;
  provider?: string;
  model?: string;
  fixture?: boolean;
}

function gitRaw(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  try {
    return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    const error = cause as Error & { stderr?: string | Buffer };
    throw new Error(`Foundation Git operation failed (${args[0]}): ${String(error.stderr || error.message).trim()}`);
  }
}

function git(job: JobStartResult, ...args: string[]): string {
  return gitRaw(job, ...args).trim();
}

function storyPath(job: JobStartResult, file: string) {
  return job.storyRelativePath ? `${job.storyRelativePath}/${file}` : file;
}
function assertHead(job: JobStartResult, sha: string) {
  if (git(job, "rev-parse", "HEAD") !== sha || git(job, "symbolic-ref", "--short", "HEAD") !== job.branch) {
    throw new Error("Job HEAD or branch changed unexpectedly; do not overwrite or advance external Git work.");
  }
}
function changedPaths(job: JobStartResult): string[] {
  // -z avoids Git quoting/whitespace ambiguities. Rename/copy entries are
  // rejected, not interpreted as ordinary authorized additions or edits.
  const output = gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const entries = output.split("\0").filter(Boolean);
  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    if (status !== "??" && status !== " M") {
      throw new Error(`Unexpected staged, renamed, deleted or conflicted Git change: ${entry.slice(3)}`);
    }
    result.push(entry.slice(3));
  }
  return result;
}
function assertOnlyTarget(job: JobStartResult, target: string) {
  const observed = changedPaths(job);
  const expected = storyPath(job, target);
  if (observed.length !== 1 || observed[0] !== expected) {
    throw new Error(`Foundation work item may change only ${expected}; observed: ${observed.join(", ") || "(none)"}`);
  }
}
async function assertSafeTarget(job: JobStartResult, target: string) {
  const full = join(job.worktreeStoryRoot, target);
  const folder = dirname(full);
  if (await realpath(folder) !== folder || await realpath(full) !== full ||
      !(await lstat(full)).isFile()) {
    throw new Error("Foundation authoring target is not a regular file under a real Story directory.");
  }
  if (!relative(job.worktreeStoryRoot, full).startsWith("creative-direction" + sep)) {
    throw new Error("Foundation target is outside Creative Direction.");
  }
}
async function selectTarget(job: JobStartResult): Promise<string> {
  const files = git(job, "ls-files", "--", storyPath(job, "creative-direction"))
    .split("\n").filter(Boolean).map(path =>
      job.storyRelativePath ? path.slice(job.storyRelativePath.length + 1) : path);
  if (files.some(path => !/^creative-direction\/[A-Za-z0-9._-]+\.md$/.test(path)) || files.length > 1) {
    throw new Error("Ambiguous existing Creative Direction: select a Story with at most one tracked foundation record.");
  }
  return files[0] || "creative-direction/foundation.md";
}
function freshDraft(task: string, envelope: string, authorInput?: string): FoundationDraft {
  return {
    id: "foundation", title: "The Unwritten Mystery",
    premise: "A missing librarian's final message draws an archivist into a town where memories are traded.",
    central_conflict: "The archivist must decide whether to recover the truth or protect the people who concealed it.",
    genre: "Mystery", tone: "Intimate and suspenseful",
    player_experience: "Explore a contained visual novel through consequential conversations and revelations.",
    scope: envelope || "A compact dialogue-led narrative with a bounded cast and reusable locations.",
    decisions: [
      { id: "author-brief", statement: `Author brief: ${task}`, origin: "user", authority: "user-protected" },
      ...(envelope ? [{ id: "presentation-envelope", statement: envelope, origin: "user" as const, authority: "user-protected" as const }] : []),
      ...(authorInput ? [{ id: "author-discovery", statement: authorInput, origin: "user" as const, authority: "user-protected" as const }] : []),
      { id: "story-hook", statement: "The mystery centers on an archive of exchanged memories.", origin: "agent", authority: "delegated" },
    ],
    body: "# Foundation\n\nThe player follows the archivist into a small community united by a secret. Every interview reveals both a clue and a reason to preserve the lie. The climax tests whether knowledge is always worth its human cost.",
  };
}
async function fixtureAuthor(job: JobStartResult, state: FoundationState, target: string) {
  const path = join(job.worktreeStoryRoot, target);
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    // Existing material is deliberately preserved, including all protected decisions.
    await writeFile(path, (await readFile(path, "utf8")).trimEnd() +
      "\n\n## Foundation development\n\nThe central conflict will be realized through dialogue, stakes, and meaningful player choice.\n");
  } else {
    await writeFile(path, renderFoundation(freshDraft(state.task, state.envelope, state.authorInput)), { flag: "wx" });
  }
  return { skillReads: REQUIRED.map(path => join(state.snapshot.path, "skills", path)),
    piSessionId: undefined, piSessionFile: undefined };
}

async function piAuthor(job: JobStartResult, state: FoundationState, target: string, provider: string, modelId: string) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: state.snapshot.path,
    skillDirs: [], requiredSkills: ["nt-story-discovery", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error(`Pi skill discovery: ${diag.message}`);
  for (const name of ["nt-catalog", "nt-story-discovery"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(state.snapshot.path, "skills") + sep))) {
      throw new Error(`Missing pinned NovelTea skill: ${name}`);
    }
  }
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(candidate => candidate.id === modelId)) {
    throw new Error(`Unavailable Pi model or credentials for ${provider}/${modelId}; use pi /login or an API key.`);
  }
  const sessionDir = join(dirname(job.worktreeRoot), "foundation-sessions");
  await mkdir(sessionDir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(project.root, sessionDir),
    // Standard tools remain available, including grep/rg and Git inspection
    // through bash. No structured-record writer or Git commit tool exists.
    noTools: "all", tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  let reads: string[] = [];
  let wrote = false;
  try {
    await session.prompt(
      "You are the NovelTea foundation writing specialist in an isolated Git Story worktree. " +
      "Use ordinary Pi read/edit/write and inspection tools to AUTHOR MARKDOWN DIRECTLY, never a structured record authoring tool. " +
      "Before editing, actually READ these five pinned files with the read tool (absolute paths):\n" +
      REQUIRED.map(name => join(state.snapshot.path, "skills", name)).join("\n") +
      "\nFollow the pinned nt-story-discovery and nt-catalog instructions. " +
      `Only edit the canonical Story file ${target}, within cwd ${project.root}. ` +
      "Never run git add, commit, reset, checkout, or alter Git history. Do not touch other files or any NovelTea engine records. " +
      "You may inspect with grep, rg, Git diff, status and history. " +
      "Preserve every existing user-protected decision verbatim; do not invent author approvals. " +
      "Attribute actual author constraints individually as origin:user/authority:user-protected; " +
      "agent-chosen decisions as origin:agent/authority:delegated. Mark status draft or proposed, not approved. " +
      "For YAML frontmatter, DOUBLE-QUOTE every free-text scalar (title, premise, central_conflict, genre, tone, " +
      "player_experience, scope and decision statements); escape embedded quote characters as needed. " +
      "Plain unquoted prose with colons is INVALID YAML. Verify your frontmatter is parseable before finishing. " +
      "Honor the requested narrative/presentation envelope as constraints rather than universal plot counts. " +
      "Do not claim validation, approval or a commit; the graph performs those independently. " +
      `Collaboration mode: ${state.mode}.\nAuthor brief: ${state.task}\n` +
      `Presentation/narrative envelope: ${state.envelope || "(unspecified)"}\n` +
      `Author's explicit discovery response: ${state.authorInput || "(none; autonomous choice of unspecified matters authorized)"}\n` +
      "Produce a substantive foundation, then briefly describe what you wrote.",
    );
    const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!assistant || assistant.role !== "assistant" ||
        assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error("Pi foundation specialist failed to finish a successful turn.");
    }
    const calls = session.messages.flatMap(message => message.role === "assistant"
      ? message.content.filter((item): item is Extract<typeof item, { type: "toolCall" }> => item.type === "toolCall")
      : []);
    const completedCalls = new Set(session.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> =>
      message.role === "toolResult" && !message.isError).map(message => message.toolCallId));
    reads = calls.filter(call => completedCalls.has(call.id) && call.name === "read" &&
      typeof call.arguments?.path === "string")
      .map(call => resolve(project.root, call.arguments.path as string));
    const requiredPaths = REQUIRED.map(name => join(state.snapshot.path, "skills", name));
    if (requiredPaths.some(path => !reads.includes(path))) {
      throw new Error("Pi did not actually read every required pinned NovelTea skill reference.");
    }
    wrote = calls.some(call => completedCalls.has(call.id) &&
      (call.name === "write" || call.name === "edit") &&
      typeof call.arguments?.path === "string" &&
      resolve(project.root, call.arguments.path as string) === join(project.root, target));
    if (!wrote) throw new Error("Pi did not author the canonical Markdown through a standard write/edit tool.");
    return { skillReads: reads.filter(path => requiredPaths.includes(path)),
      piSessionId: session.sessionId,
      piSessionFile: session.sessionManager.getSessionFile() ?? undefined };
  } finally {
    session.dispose();
  }
}

/** Read-only Pi discovery pass, distinct from the subsequent writing specialist.
 * No write or shell tools are exposed at this author-input boundary. */
async function discoverQuestions(job: JobStartResult, state: FoundationState,
  provider: string, modelId: string, fixture: boolean) {
  if (fixture) return {
    questions: "Which central conflict, theme and protagonist details must be fixed by you? " +
      "What branching, production, or presentation constraints are binding? " +
      "You can answer partially and delegate any remaining creative decisions.\n" +
      "Original brief: " + state.task,
    discoverySessionId: undefined, discoverySessionFile: undefined,
  };
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: state.snapshot.path,
    skillDirs: [], requiredSkills: ["nt-story-discovery", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  for (const diag of loader.getSkills().diagnostics) {
    if (diag.type === "error") throw new Error(`Pi discovery skill error: ${diag.message}`);
  }
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(candidate => candidate.id === modelId)) {
    throw new Error(`Unavailable Pi model or credentials for ${provider}/${modelId}.`);
  }
  const sessions = join(dirname(job.worktreeRoot), "foundation-discovery-sessions");
  await mkdir(sessions, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, resourceLoader: loader,
    settingsManager, sessionManager: SessionManager.create(project.root, sessions),
    noTools: "all", tools: ["read", "grep", "find", "ls"],
  });
  try {
    await session.prompt("Collaborative foundation discovery only: DO NOT edit any file. " +
      "Actually read the pinned nt-story-discovery and nt-catalog guidance and references using read:\n" +
      REQUIRED.map(name => join(state.snapshot.path, "skills", name)).join("\n") +
      "\nInspect the existing Creative Direction if relevant. Following the discovery guidance, " +
      "ask the author all currently answerable consequential creative, branching and production questions " +
      "in one concise round. State that partial answers and delegation of remaining choices are allowed. " +
      "Do not falsely treat a question or proposed decision as approved. " +
      `Brief: ${state.task}\nEnvelope: ${state.envelope || "(not specified)"}`);
    const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!assistant || assistant.role !== "assistant" ||
        ["aborted", "error"].includes(assistant.stopReason)) {
      throw new Error("Pi discovery did not complete.");
    }
    const questions = session.getLastAssistantText();
    if (!questions?.trim()) throw new Error("Pi discovery returned no author questions.");
    const completedCalls = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const reads = session.messages.flatMap(m => m.role === "assistant"
      ? m.content.filter((c): c is Extract<typeof c, {type: "toolCall"}> => c.type === "toolCall")
      : []).filter(c => completedCalls.has(c.id) && c.name === "read" && typeof c.arguments?.path === "string")
      .map(c => resolve(project.root, c.arguments.path as string));
    if (REQUIRED.some(name => !reads.includes(join(state.snapshot.path, "skills", name)))) {
      throw new Error("Pi collaborative discovery did not read the pinned narrative skill guidance.");
    }
    return { questions, discoverySessionId: session.sessionId,
      discoverySessionFile: session.sessionManager.getSessionFile() ?? undefined };
  } finally {
    session.dispose();
  }
}

function stateFile(job: JobStartResult) { return join(dirname(job.worktreeRoot), "foundation.json"); }
async function saveState(file: string, state: FoundationState) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { await rename(tmp, file); } catch (error) { throw error; }
}
async function existingState(job: JobStartResult): Promise<FoundationState | undefined> {
  if (!existsSync(stateFile(job))) return undefined;
  const state = JSON.parse(await readFile(stateFile(job), "utf8")) as FoundationState;
  if (state.version !== 1 || state.jobId !== job.jobId || state.baseSha !== job.baseSha ||
      !["awaiting-author", "writing", "committed"].includes(state.stage) ||
      !["autonomous", "collaborative"].includes(state.mode) ||
      !["pi", "fixture"].includes(state.workerMode) ||
      typeof state.provider !== "string" || !state.provider.trim() ||
      typeof state.model !== "string" || !state.model.trim() || !state.snapshot?.id) {
    throw new Error("Saved foundation state has invalid identity or format.");
  }
  const verifiedPath = await openSkillSnapshot(state.snapshot.id);
  if (state.snapshot.path !== verifiedPath || state.snapshot.digest !== state.snapshot.id) {
    throw new Error("Persisted foundation skill snapshot identity does not match its pinned bytes.");
  }
  return state;
}
function recoveryCommit(job: JobStartResult, state: FoundationState): string | undefined {
  const head = git(job, "rev-parse", "HEAD");
  if (head === job.baseSha) return undefined;
  if (git(job, "rev-parse", "HEAD^") !== job.baseSha ||
      !git(job, "log", "-1", "--format=%B").includes(`NovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${WORK_ITEM}`)) {
    throw new Error("Job branch has an unexpected commit. Preserve it for inspection; no new commit made.");
  }
  const changed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
  if (changed.length !== 1 || changed[0] !== storyPath(job, state.target!)) {
    throw new Error("Job commit changes files outside the authorized foundation work item.");
  }
  return head;
}
function assertValidation(job: JobStartResult, result: ValidationResult): "passed" | "unverified-empty-baseline" {
  const report = result.report as { diagnostics?: unknown[]; readiness?: { design?: { stages?: { foundation?: { minimum?: string } } } }; protection?: { status?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (!report || report.diagnostics?.length || report.readiness?.design?.stages?.foundation?.minimum !== "passed") {
    throw new Error("Canonical foundation validation failed: " + JSON.stringify({
      diagnostics: report?.diagnostics, foundation: report?.readiness?.design?.stages?.foundation?.minimum,
      status: result.status, error: result.error,
    }).slice(0, 6000));
  }
  if (result.status === "passed" && result.exitCode === 0 &&
      report.protection?.status === "checked" && !report.protection.changes?.length &&
      !report.protection.warnings?.length) return "passed";
  // Canonical validator #14 reports no checked protection when the trusted
  // base contains *zero* Story Markdown. Check this independently in Git;
  // do NOT misrepresent the result as a protected-decision verification.
  if (result.status === "unverified" && result.exitCode === 2 &&
      (report.protection?.status === "no-baseline" ||
       (report.protection?.status === "checked" &&
        (report.protection as { base?: string }).base === git(job, "rev-parse", "HEAD"))) &&
      !git(job, "ls-tree", "-r", "--name-only", job.baseSha, "--", job.storyRelativePath || ".")
        .split("\n").some(path => path.endsWith(".md"))) return "unverified-empty-baseline";
  throw new Error(`Canonical validation did not authorize a foundation commit (status: ${result.status}; protection: ${report.protection?.status}).`);
}
function output(job: JobStartResult, state: FoundationState) {
  return {
    status: state.stage === "committed" ? "committed" : "awaiting-author",
    jobId: job.jobId, workItemId: WORK_ITEM, mode: state.mode,
    workerMode: state.workerMode, provider: state.provider, model: state.model,
    branch: job.branch,
    baseSha: job.baseSha, headSha: state.commitSha ?? job.baseSha,
    worktreeStoryRoot: job.worktreeStoryRoot, target: state.target,
    commitSha: state.commitSha, validation: state.validation,
    skillSnapshot: { id: state.snapshot.id, commit: state.snapshot.commit },
    piSessionId: state.piSessionId, piSessionFile: state.piSessionFile,
    skillReads: state.skillReads ?? [],
    ...(state.stage === "awaiting-author" ? {
      handoff: "Provide author decisions, constraints, or delegate remaining choices via --author-input; no Story files have been modified.",
      questions: state.questions,
      discoverySessionId: state.discoverySessionId,
      discoverySessionFile: state.discoverySessionFile,
    } : {}),
  };
}

export async function runFoundationJob(input: FoundationJobOptions) {
  const job = await startStoryJob({ story: input.story, job: input.job }, false);
  const lock = join(dirname(job.worktreeRoot), ".foundation-running");
  try { await mkdir(lock); }
  catch { throw new Error("Foundation work item is already running or was interrupted; inspect the lock and worktree."); }
  try {
    let state = await existingState(job);
    if (!state) {
      if (!input.task?.trim()) throw new Error("New foundation work item requires --task.");
      if (input.authorInput) throw new Error("Start collaborative discovery before supplying --author-input.");
      assertHead(job, job.baseSha);
      if (changedPaths(job).length) throw new Error("Job worktree contains unexpected preexisting changes.");
      const config = await loadSkillConfig();
      const snapshot = await createSkillSnapshot({ ...config, novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-story-discovery", "nt-catalog"] });
      if (!snapshot) throw new Error("Foundation generation requires configured pinned NovelTea skills (--skills-source or .local/config.json).");
      state = {
        version: 1, jobId: job.jobId, baseSha: job.baseSha,
        task: input.task, envelope: input.envelope ?? "",
        mode: input.mode ?? "autonomous", snapshot,
        workerMode: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        stage: input.mode === "collaborative" ? "awaiting-author" : "writing",
      };
      await saveState(stateFile(job), state);
    } else {
      if ((input.task !== undefined && input.task !== state.task) ||
          (input.envelope !== undefined && input.envelope !== state.envelope) ||
          (input.mode !== undefined && input.mode !== state.mode) ||
          (input.fixture === true) !== (state.workerMode === "fixture") ||
          (input.provider !== undefined && input.provider !== state.provider) ||
          (input.model !== undefined && input.model !== state.model)) {
        throw new Error("Foundation job inputs differ from its persisted brief; start another job for a new assignment.");
      }
    }
    if (state.stage === "awaiting-author") {
      if (!state.questions) {
        const discovery = await discoverQuestions(job, state,
          state.provider, state.model, state.workerMode === "fixture");
        assertHead(job, job.baseSha);
        if (changedPaths(job).length) throw new Error("Discovery unexpectedly modified the job worktree.");
        Object.assign(state, discovery);
        await saveState(stateFile(job), state);
      }
      if (!input.authorInput?.trim()) return output(job, state);
      if (state.authorInput) throw new Error("Author discovery response has already been recorded.");
      state.authorInput = input.authorInput;
      state.stage = "writing";
      await saveState(stateFile(job), state);
    } else if (input.authorInput) {
      throw new Error("An author response can only be provided at a collaborative discovery handoff.");
    }
    if (!state.target) {
      state.target = await selectTarget(job);
      await saveState(stateFile(job), state);
    }
    const target = state.target;
    const recovered = recoveryCommit(job, state);
    if (recovered && changedPaths(job).length) {
      throw new Error("Job has unexpected uncommitted changes after its foundation commit.");
    }
    if (state.stage === "committed") {
      if (recovered !== state.commitSha) throw new Error("Saved foundation commit differs from job HEAD.");
      return output(job, state);
    }
    state = await executeFoundationGraph(job, state, input, recovered);
    return output(job, state);
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}
/**
 * Work-item graph: Pi authors Markdown in one node; a separate LangGraph
 * transition inspects, validates and advances Git. The external job receipt
 * provides crash reconciliation until broader checkpointing lands.
 */
async function executeFoundationGraph(job: JobStartResult, initial: FoundationState,
  input: FoundationJobOptions, recovered?: string): Promise<FoundationState> {
  const Channels = Annotation.Root({
    foundation: Annotation<FoundationState>(),
    recovered: Annotation<string | undefined>(),
  });
  const graph = new StateGraph(Channels)
    .addNode("write_foundation", async ({ foundation, recovered }) => {
      if (recovered) return {};
      const target = foundation.target!;
      assertHead(job, job.baseSha);
      if (changedPaths(job).length) {
        throw new Error("Unfinished foundation edits exist. Inspect and reconcile them; the specialist will not blindly rerun.");
      }
      const authored = foundation.workerMode === "fixture"
        ? await fixtureAuthor(job, foundation, target)
        : await piAuthor(job, foundation, target, foundation.provider, foundation.model);
      const next = { ...foundation, ...authored };
      await saveState(stateFile(job), next);
      assertHead(job, job.baseSha);
      assertOnlyTarget(job, target);
      await assertSafeTarget(job, target);
      return { foundation: next };
    })
    .addNode("validate_and_commit_foundation", async ({ foundation, recovered }) => {
      const target = foundation.target!;
      const config = await loadSkillConfig(undefined, false);
      const validation = await validateStoryJob(job, input.validatorSource ?? input.skillsSource ?? config.novelteaSkills);
      const verified = assertValidation(job, validation);
      assertOnlyTargetForCommit(job, target, recovered);
      if (!recovered) {
        assertHead(job, job.baseSha);
        git(job, "add", "--", storyPath(job, target));
        if (git(job, "diff", "--cached", "--name-only") !== storyPath(job, target)) {
          throw new Error("Git staging contains unexpected files; commit refused.");
        }
        git(job, "-c", `user.name=${AGENT_NAME}`, "-c", `user.email=${AGENT_EMAIL}`,
          "commit", "--only", "-m",
          `Generate Creative Direction [${job.jobId}/${WORK_ITEM}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${WORK_ITEM}\nNovelTea-Validation: ${verified}`,
          "--", storyPath(job, target));
      }
      if (changedPaths(job).length) {
        throw new Error("Git commit left unexpected worktree changes; keep the commit for inspection.");
      }
      const next: FoundationState = {
        ...foundation, stage: "committed", validation: verified,
        commitSha: git(job, "rev-parse", "HEAD"),
      };
      await saveState(stateFile(job), next);
      return { foundation: next };
    })
    .addEdge(START, "write_foundation")
    .addEdge("write_foundation", "validate_and_commit_foundation")
    .addEdge("validate_and_commit_foundation", END)
    .compile();
  const result = await graph.invoke({ foundation: initial, recovered });
  return result.foundation;
}

function assertOnlyTargetForCommit(job: JobStartResult, target: string, recovered?: string) {
  if (!recovered) assertOnlyTarget(job, target);
  else if (changedPaths(job).length) throw new Error("Cannot recover commit with unexpected worktree changes.");
}
