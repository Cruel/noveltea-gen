import { createPiStatusTool } from "./pi-work-status.js";
import { execFileSync } from "./git-read-cache.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { renderFoundation, type FoundationDraft } from "./demo.js";
import { hasUserProtectedDecision } from "./foundation-record.js";
import { readChatApprovedFoundation } from "./chat-approved-foundation.js";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { promptStorySpecialist, StoryCancelledError } from "./story-interruption.js";
import { readJobControl } from "./job-control.js";
import { processAuthorUpdatesAtBoundary, processAuthorUpdatesAfterWork } from "./author-updates.js";
import { verifyJobPiSession } from "./job-session.js";
import { FoundationAuthorRequiredError, authorizedFoundationException, consumeFoundationRetry, foundationExceptionContext, recordFoundationConflict } from "./foundation-conflict.js";
import { trustedHead } from "./revision.js";
import { finalizeRecoveryCheckpoint } from "./recovery-checkpoints.js";
import { createProjectResourceLoader } from "./pi.js";
import { preparePiContext, preflightPiAssignment, guardPiBudget, recordPiSession, registerPendingPiSession, inspectPiPolicy } from "./job-pi-policy.js";
import { ASSIGNMENT_REPORT, nativeMetadataDefects, recoverSubmittedAssignment, verifySettledAssignment, inspectAssignmentFailure, AssignmentAuthorPauseError, type AssignmentInvocationProof } from "./assignment-metadata-recovery.js";
import { openStoryProject } from "./project.js";
import { loadSkillConfig, type SkillConfig } from "./skills.js";
import { createSkillSnapshot, openSkillSnapshot, type SkillSnapshot } from "./snapshot.js";
import { createStoryValidateTool, validateStoryJob, type ValidationResult } from "./validator.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";

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
  /** Trusted HEAD when this work item began (may include inbox capture commits). */
  workHead?: string;
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
  /** Persisted before giving the writer tools; never restart it blindly after a crash. */
  writerStarted?: boolean;
  /** Current-format original writer invocation receipts. */
  invocationVersion?: 1;
  invocationProof?: AssignmentInvocationProof;
  /** Exact authored bytes pinned before validation/commit, for safe commit recovery. */
  authoredSha256?: string;
  reviewedRecoverySha256?: string;
  target?: string;
  piSessionId?: string;
  piSessionFile?: string;
  skillReads?: string[];
  commitSha?: string;
  validation?: "passed" | "unverified-empty-baseline";
  /** Exact immutable Chat baseline approval; no additional Pi writer is allowed. */
  chatApprovalDigest?: string;
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
  inspect?: boolean;
  recoveryDigest?: string;
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

async function piAuthor(job: JobStartResult, state: FoundationState, target: string, provider: string, modelId: string,
  onSession: (id: string, path: string) => Promise<void>, validatorSource?: string) {
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
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "foundation-sessions");
  const authoredFile = join(project.root, target);
  const context = await preparePiContext(job, project, {
    group: "foundation:write", step: "foundation:write",
    // An initial Foundation has no source file to read. Including a missing
    // target in the Context Manifest leads Pi to fail before it ever writes.
    paths: existsSync(authoredFile) ? [target] : [],
    snapshot: state.snapshot.id, provider, model: modelId, directory: sessionDir,
    // Reconciliation and native verification do not spend a model call.
    // Admission is checked below only before an actual prompt.
    insideWriter: true,
  }, runtime);
  const scope = () => foundationSourceDigest(job, state, target);
  const sourceDigest = await scope();
  const authorize = async () => {
    assertHead(job, workHead(state));
    if (await scope() !== sourceDigest || await openSkillSnapshot(state.snapshot.id) !== state.snapshot.path)
      throw Error("Foundation assignment source or permission changed.");
    const paths = changedPaths(job);
    if (paths.some(path => path !== storyPath(job, target)))
      throw Error("Foundation corrective writer cannot touch a different Story path.");
    if (existsSync(authoredFile)) await assertSafeTarget(job, target);
  };
  const sandboxTools = (await selectSandboxPiTools(job, state.snapshot, skills))!
    .filter(tool => tool.name !== "bash")
    .map(tool => {
      if (tool.name !== "write" && tool.name !== "edit") return tool;
      return { ...tool, async execute(...args: Parameters<typeof tool.execute>) {
        const input = args[1] as { path?: unknown };
        await authorize();
        if (typeof input.path !== "string" || resolve(project.root, input.path) !== authoredFile)
          throw Error("Foundation writer has no permission to edit that Story path.");
        return tool.execute(...args);
      } };
    });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: state.piSessionFile && existsSync(state.piSessionFile)
      ? SessionManager.open(state.piSessionFile, dirname(state.piSessionFile), project.root)
      : context.manager,
    customTools: [...sandboxTools, createStoryValidateTool(job), context.contextTool, createPiStatusTool()],
    // All Pi file/search tools use the isolated controller adapter,
    // including standalone CLI jobs. No local host-tool fallback is permitted.
    // Neither a structured-record writer nor a Git commit tool is exposed.
    noTools: "all", tools: [...SANDBOX_TOOLS.filter(name => name !== "bash"), "story_context", "story_validate", "report_status"],
  });
  let reads: string[] = [];
  let wrote = false;
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi foundation writer did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Foundation Pi transcript cannot be persisted; writer will not start.");
    if (state.piSessionId && state.piSessionId !== session.sessionId)
      throw Error("Foundation recovery opened a different Pi session.");
    await onSession(session.sessionId, sessionFile);
    const granted = await authorizedFoundationException(job);
    const invocationProof = await recoverSubmittedAssignment({
      session, directory: foundationInvocationDirectory(job, session.sessionId),
      sourceDigest, sessionRoots: [sessionDir], authorize,
      effect: async () => existsSync(authoredFile) ? foundationDigest(job, target) : null,
      beforeTurn: async () => {
        const checkControl = async () => {
          const control = await readJobControl(job);
          if (control === "cancelled") throw new StoryCancelledError(WORK_ITEM);
          if (control !== "running") throw new AssignmentAuthorPauseError();
        };
        await checkControl();
        await guardPiBudget(job, "foundation:write", sessionFile);
        await checkControl();
      },
      prompt: async text => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, text);
        await recordPiSession(job, sessionFile);
      },
      initialPrompt: context.contextNote + "You are the NovelTea foundation writing specialist in an isolated Git Story worktree. " +
      (granted?.retryUsed && granted.authorization
        ? "The authenticated author explicitly granted this exact job a one-time exception to the following existing protected discovery-only restriction. Preserve its existing statement verbatim; the exception authorizes continued composition for this pinned job only, NOT changing, deleting or weakening the decision. Original: " +
          "SHA-256 " + granted.fileSha256 +
          (granted.authorization.reason ? ". Additional author direction: " + granted.authorization.reason : "") + "\n"
        : "") +
      "Use ordinary Pi read/edit/write and inspection tools to AUTHOR MARKDOWN DIRECTLY, never a structured record authoring tool. " +
      "Before editing, actually READ these five pinned files with the read tool (absolute paths):\n" +
      REQUIRED.map(name => join(state.snapshot.path, "skills", name)).join("\n") +
      "\nFollow the pinned nt-story-discovery and nt-catalog instructions. " +
      `Only edit the canonical Story file ${target}, within cwd ${project.root}. ` +
      "Never read or search .story-inbox/ideas or include dormant author ideas in any Story draft. " +
      "That reserved Git-tracked directory is noncanonical and author-only; avoid it even with rg --hidden, git grep, git show or broad filesystem scans. " +
      "Use only narrowly scoped author constraints supplied explicitly for this assignment. " +
      "Never run git add, commit, reset, checkout, or alter Git history. Do not touch other files or any NovelTea engine records. " +
      "No shell tool is available for this single-record assignment. Use read for pinned skills and story_validate for native validation. " +
      "Preserve every existing user-protected decision verbatim; do not invent author approvals. " +
      "Attribute actual author constraints individually as origin:user/authority:user-protected; " +
      "agent-chosen decisions as origin:agent/authority:delegated. " +
      "IMPORTANT: The author brief and presentation envelope below contain explicitly author-specified story and production constraints; " +
      "delegation of UNSPECIFIED choices does not delegate these supplied constraints. " +
      "Create at least one explicit user/user-protected Creative Decision capturing the actual author constraints, " +
      "and keep your own newly invented details as separate agent/delegated decisions. " +
      "Do not relabel an invented choice as the author's. Mark status draft or proposed, not approved. " +
      "For YAML frontmatter, DOUBLE-QUOTE every free-text scalar (title, premise, central_conflict, genre, tone, " +
      "player_experience, scope and decision statements); escape embedded quote characters as needed. " +
      "Plain unquoted prose with colons is INVALID YAML. Verify your frontmatter is parseable before finishing. " +
      (existsSync(authoredFile)
        ? "The target file exists: read it before editing and preserve its existing decisions. "
        : "The Foundation target does not exist yet. Create it with write before attempting story_context or read on that file; " +
          "story_context cannot read nonexistent Story records. ") +
      "Call story_validate with no arguments after authoring, inspect diagnostics and readiness, repair and revalidate before finishing. " +
      "Honor the requested narrative/presentation envelope as constraints rather than universal plot counts. " +
      "Do not claim validation, approval or a commit; the graph performs those independently. " +
      `Collaboration mode: ${state.mode}.\nAuthor brief: ${state.task}\n` +
      `Presentation/narrative envelope: ${state.envelope || "(unspecified)"}\n` +
      `Author's explicit discovery response: ${state.authorInput || "(none; autonomous choice of unspecified matters authorized)"}\n` +
      "Produce a substantive foundation. " + ASSIGNMENT_REPORT,
      verify: async manifest => {
        if (!existsSync(authoredFile) || changedPaths(job).length === 0) {
          if (await recordFoundationConflict(job)) throw new FoundationAuthorRequiredError();
          throw Error("Foundation specialist submitted no Story changes; preserve the original invocation.");
        }
        assertOnlyTarget(job, target);
        const paths = manifest.modifiedRecords as string[];
        if (paths.length !== 1 || paths[0] !== target || (manifest.architecturalConflicts as string[]).length)
          throw Error("Foundation final report does not match its independently observed Story scope or reports a conflict.");
        const validation = await validateStoryJob(job, validatorSource);
        if (validation.status === "rejected") return nativeMetadataDefects(validation, {
          jobId: job.jobId, baseSha: job.baseSha, worktreeStoryRoot: job.worktreeStoryRoot,
          validatorVersion: job.validatorVersion, paths: [target],
          derivedDiagnostics: ["creative-direction-count"],
        });
        assertValidation(job, validation);
        if (!hasUserProtectedDecision(await readFile(authoredFile, "utf8")))
          return [{ kind: "provenance", path: target, code: "missing-author-provenance" }];
        return [];
      },
    });
    const calls = session.messages.flatMap(message => message.role === "assistant"
      ? message.content.filter((item): item is Extract<typeof item, { type: "toolCall" }> => item.type === "toolCall")
      : []);
    const completedCalls = new Set(session.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> =>
      message.role === "toolResult" && !message.isError).map(message => message.toolCallId));
    reads = calls.filter(call => completedCalls.has(call.id) && call.name === "read" &&
      typeof call.arguments?.path === "string")
      .map(call => canonicalPinnedReadPath(call.arguments.path as string, project.root, state.snapshot.path));
    const requiredPaths = REQUIRED.map(name => join(state.snapshot.path, "skills", name));
    wrote = calls.some(call => completedCalls.has(call.id) &&
      (call.name === "write" || call.name === "edit") &&
      typeof call.arguments?.path === "string" &&
      resolve(project.root, call.arguments.path as string) === join(project.root, target));
    if (!wrote) {
      if (await recordFoundationConflict(job)) throw new FoundationAuthorRequiredError();
      throw new Error("Pi did not author the canonical Markdown through a standard write/edit tool.");
    }
    if (requiredPaths.some(path => !reads.includes(path))) {
      throw new Error("Pi did not actually read every required pinned NovelTea skill reference.");
    }
    await context.completed(sessionFile, session.sessionId);
    return { skillReads: reads.filter(path => requiredPaths.includes(path)), invocationProof,
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
  const runtime = await createJobModelRuntime();
  const sessions = join(job.stateDir, "foundation-discovery-sessions");
  const context = await preparePiContext(job, project, {
    group: "foundation:discovery", step: "foundation:discovery",
    paths: [], snapshot: state.snapshot.id, provider, model: modelId, directory: sessions,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, state.snapshot, loader.getSkills().skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader,
    settingsManager, sessionManager: context.manager,
    customTools: (sandboxTools ?? []).filter(tool => ["read", "grep", "find", "ls"].includes(tool.name)),
    noTools: "all", tools: ["read", "grep", "find", "ls"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi foundation discovery did not honor pinned thinking effort.");
    }
    await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
    await promptStorySpecialist(session, context.contextNote + "Collaborative foundation discovery only: DO NOT edit any file. " +
      "Actually read the pinned nt-story-discovery and nt-catalog guidance and references using read:\n" +
      REQUIRED.map(name => join(state.snapshot.path, "skills", name)).join("\n") +
      "\nInspect the existing Creative Direction if relevant. Following the discovery guidance, " +
      "Do not read/search .story-inbox/ideas: deferred narrative ideas are author-only until a separate placement stage. " +
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
      .map(c => canonicalPinnedReadPath(c.arguments.path as string, project.root, state.snapshot.path));
    if (REQUIRED.some(name => !reads.includes(join(state.snapshot.path, "skills", name)))) {
      throw new Error("Pi collaborative discovery did not read the pinned narrative skill guidance.");
    }
    await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
    return { questions, discoverySessionId: session.sessionId,
      discoverySessionFile: session.sessionManager.getSessionFile() ?? undefined };
  } finally {
    session.dispose();
  }
}

async function foundationSourceDigest(job: JobStartResult, state: FoundationState, target: string) {
  const { resolved, policy } = await inspectPiPolicy(job);
  if (!resolved || policy.profile.thinking !== resolved.thinking)
    throw Error("Foundation source lacks its original pinned model resolution.");
  return createHash("sha256").update(JSON.stringify({
    job: job.jobId, thread: job.threadId, base: job.baseSha, head: workHead(state),
    target, snapshot: state.snapshot.id, provider: state.provider, modelId: state.model, task: state.task,
    selectedModel: resolved.selected.provider + "/" + resolved.selected.model, thinking: resolved.thinking,
    mode: state.mode, authorInput: state.authorInput, envelope: state.envelope,
    validator: job.validatorVersion, exception: await foundationExceptionContext(job),
    turn: await readFile(join(job.stateDir, "turn-plan.json"), "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  })).digest("hex");
}

function stateFile(job: JobStartResult) { return join(job.stateDir, "foundation.json"); }
function foundationInvocationDirectory(job: JobStartResult, sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw Error("Invalid Foundation invocation session identity.");
  return join(job.stateDir, "foundation-invocations", sessionId);
}
function hasStartedFoundationInvocation(job: JobStartResult, state: FoundationState) {
  return !!state.piSessionId && existsSync(join(foundationInvocationDirectory(job, state.piSessionId), "0.started.json"));
}
async function verifyFoundationInvocation(job: JobStartResult, state: FoundationState): Promise<void> {
  if (state.workerMode !== "pi" || state.chatApprovalDigest) return;
  if (!state.invocationVersion || !state.piSessionId || !state.piSessionFile || !state.authoredSha256)
    throw Error("Obsolete or incomplete original Foundation invocation; inspect its evidence, not replay.");
  await verifyJobPiSession(job, "foundation", state.piSessionFile, state.piSessionId);
  // Explicit operator reconciliation remains a separate, reviewed effect;
  // it never grants another Pi invocation or fabricates a model settlement.
  if (state.reviewedRecoverySha256 === state.authoredSha256) return;
  if (!state.invocationProof) throw Error("Foundation authored effect lacks its original invocation proof.");
  await verifySettledAssignment({ proof: state.invocationProof,
    directory: foundationInvocationDirectory(job, state.piSessionId),
    sessionId: state.piSessionId, sessionFile: state.piSessionFile,
    sessionRoots: [join(job.stateDir, "foundation-sessions")], effect: state.authoredSha256 });
}
async function saveState(file: string, state: FoundationState) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { await rename(tmp, file); } catch (error) { throw error; }
}
async function foundationDigest(job: JobStartResult, target: string) {
  return createHash("sha256").update(await readFile(join(job.worktreeStoryRoot, target))).digest("hex");
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
function workHead(state: FoundationState) { return state.workHead ?? state.baseSha; }
async function advanceInboxVerifiedHead(job: JobStartResult, state: FoundationState, commit: string) {
  const file = join(job.stateDir, "revisions", "verified-head.json");
  if (!existsSync(file)) return; // Older foundation-first jobs have no shared marker.
  const saved = JSON.parse(await readFile(file, "utf8")) as { version?: number; jobId?: string; headSha?: string };
  if (saved.version !== 1 || saved.jobId !== job.jobId ||
      (saved.headSha !== workHead(state) && saved.headSha !== commit)) {
    throw new Error("Verified HEAD marker differs from the foundation's original trusted predecessor.");
  }
  if (saved.headSha !== commit) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify({ version: 1, jobId: job.jobId, headSha: commit,
      workItemId: WORK_ITEM }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
  }
}
function recoveryCommit(job: JobStartResult, state: FoundationState): string | undefined {
  const head = git(job, "rev-parse", "HEAD");
  if (head === workHead(state)) return undefined;
  if (git(job, "rev-parse", "HEAD^") !== workHead(state) ||
      !git(job, "log", "-1", "--format=%B").includes(`NovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${WORK_ITEM}`) ||
      (state.stage !== "committed" &&
        (!git(job, "log", "-1", "--format=%B").split("\n").includes(`NovelTea-Foundation: ${state.authoredSha256}`) ||
         (state.reviewedRecoverySha256 && !git(job, "log", "-1", "--format=%B").split("\n")
           .includes(`NovelTea-Reviewed-Recovery: ${state.reviewedRecoverySha256}`))))) {
    throw new Error("Job branch has an unexpected commit. Preserve it for inspection; no new commit made.");
  }
  const changed = git(job, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean);
  if (changed.length !== 1 || changed[0] !== storyPath(job, state.target!)) {
    throw new Error("Job commit changes files outside the authorized foundation work item.");
  }
  return head;
}
/** Read-only routing proof for the original child, not a new write grant. */
export async function inspectPendingFoundationInvocation(job: JobStartResult, sourceHead: string): Promise<boolean> {
  const state = await existingState(job);
  if (!state || state.stage !== "writing" || state.workerMode !== "pi" ||
      state.invocationVersion !== 1 || !state.writerStarted || state.chatApprovalDigest ||
      !state.target || workHead(state) !== sourceHead)
    return false;
  // This is only a routing gate for the original child to inspect its
  // invocation chain. It neither certifies the dirty draft nor admits a
  // corrective model call. Other specialists still require trustedHead.
  assertHead(job, sourceHead);
  if (changedPaths(job).some(path => path !== storyPath(job, state.target!)))
    throw Error("Pending Foundation invocation contains out-of-scope edits.");
  if (existsSync(join(job.worktreeStoryRoot, state.target))) await assertSafeTarget(job, state.target);
  if (hasStartedFoundationInvocation(job, state))
    await verifyJobPiSession(job, "foundation", state.piSessionFile, state.piSessionId);
  else if (changedPaths(job).length)
    throw Error("Unstarted Foundation invocation has unexpected effects.");
  return true;
}

/** Only the exact unfinished Foundation may present a settled failure at
 * its pinned Git predecessor. This is not a trusted HEAD for scheduling. */
export async function inspectFoundationFailure(job: JobStartResult, sourceHead: string) {
  if (!await inspectPendingFoundationInvocation(job, sourceHead)) return null;
  const state = (await existingState(job))!;
  if (!state.piSessionId || !state.piSessionFile || !hasStartedFoundationInvocation(job, state) ||
      state.authoredSha256) return null;
  const target = state.target!;
  const terminal = await inspectAssignmentFailure({
    directory: foundationInvocationDirectory(job, state.piSessionId),
    sourceDigest: await foundationSourceDigest(job, state, target),
    sessionId: state.piSessionId, sessionFile: state.piSessionFile,
    sessionRoots: [join(job.stateDir, "foundation-sessions")],
    effect: existsSync(join(job.worktreeStoryRoot, target)) ? await foundationDigest(job, target) : null,
  });
  return terminal && { ...terminal, ref: "foundation-invocations/" + state.piSessionId + "/terminal.json" };
}

/** Read-only proof of an original commit published before its receipt. */
export async function inspectRecoverableFoundationCommit(job: JobStartResult): Promise<boolean> {
  const state = await existingState(job);
  if (!state || state.stage !== "writing" || !state.writerStarted ||
      !state.authoredSha256 || !state.target || changedPaths(job).length)
    return false;
  const recovered = recoveryCommit(job, state);
  if (!recovered || await foundationDigest(job, state.target) !== state.authoredSha256)
    return false;
  await verifyFoundationInvocation(job, state);
  return true;
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
    baseSha: job.baseSha, headSha: state.commitSha ?? workHead(state),
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
  return withStoryJobLock(job, "foundation", async () => {
    let state = await existingState(job);
    if (state?.stage === "writing" && state.writerStarted && !state.authoredSha256 &&
        !state.chatApprovalDigest) {
      // A completed, clean no-write specialist is not a partially authored
      // file. Only an exact authenticated job-scoped author decision can permit
      // one new writer, and the prior session remains archived in its receipt.
      const approved = await consumeFoundationRetry(job);
      if (approved) {
        state = { ...state, writerStarted: false, piSessionFile: undefined,
          piSessionId: undefined };
        await saveState(stateFile(job), state);
      }
    }
    if (!input.inspect && !input.recoveryDigest && (!state || state.stage === "committed" ||
        state.stage === "awaiting-author" && !state.writerStarted)) {
      await processAuthorUpdatesAtBoundary(job);
    }
    if (!state) {
      if (input.inspect || input.recoveryDigest) throw new Error("Foundation has no saved work item to inspect or reconcile.");
      if (!input.task?.trim()) throw new Error("New foundation work item requires --task.");
      if (input.authorInput) throw new Error("Start collaborative discovery before supplying --author-input.");
      const verified = await trustedHead(job);
      assertHead(job, verified);
      if (changedPaths(job).length) throw new Error("Job worktree contains unexpected preexisting changes.");
      const config = await loadSkillConfig();
      const snapshot = await createSkillSnapshot({ ...config, novelteaSkills: input.skillsSource ?? config.novelteaSkills,
        discovery: "explicit-only", requiredSkills: ["nt-story-discovery", "nt-catalog"] });
      if (!snapshot) throw new Error("Foundation generation requires configured pinned NovelTea skills (--skills-source or .local/config.json).");
      const approved = await readChatApprovedFoundation(job);
      if (approved && (approved.originalObjective !== input.task ||
          approved.skillId !== snapshot.id || input.fixture ||
          approved.provider !== (input.provider ?? "openai") ||
          approved.model !== (input.model ?? "gpt-6-luna")))
        throw new Error("Generation differs from the exact approved Chat foundation handoff.");
      state = {
        version: 1, jobId: job.jobId, baseSha: job.baseSha, workHead: verified,
        task: input.task, envelope: input.envelope ?? "",
        mode: approved?.creativeMode ?? input.mode ?? "autonomous", snapshot,
        workerMode: input.fixture ? "fixture" : "pi",
        provider: input.provider ?? "openai", model: input.model ?? "gpt-6-luna",
        stage: approved ? "writing" : input.mode === "collaborative" ? "awaiting-author" : "writing",
        writerStarted: false,
        ...(approved ? { chatApprovalDigest: approved.proposalDigest } : {}),
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
    if (input.inspect) {
      const actualHead = git(job, "rev-parse", "HEAD");
      const changes = gitRaw(job, "status", "--porcelain=v1", "-z", "--untracked-files=all")
        .split("\0").filter(Boolean);
      let candidate: { target: string; digest: string } | undefined;
      if (state.stage === "writing" && state.writerStarted && actualHead === workHead(state) && state.target) {
        try {
          assertOnlyTarget(job, state.target);
          await assertSafeTarget(job, state.target);
          candidate = { target: state.target, digest: await foundationDigest(job, state.target) };
        } catch { /* Ambiguous changes stay blocked; preserve the actual Git inventory. */ }
      }
      let blockedReason: string | undefined;
      if (state.stage === "committed") {
        try {
          if (changes.length) throw new Error("Unexpected uncommitted or staged Story changes after the accepted foundation.");
          if (actualHead !== state.commitSha) {
            const trusted = await trustedHead(job);
            if (actualHead !== trusted) throw new Error("HEAD differs from the last verified work item.");
            git(job, "merge-base", "--is-ancestor", state.commitSha!, trusted);
          }
        } catch (error) {
          blockedReason = "Completed foundation is no longer at a verified safe boundary: " +
            (error instanceof Error ? error.message : String(error));
        }
      } else if (state.stage === "writing" && state.writerStarted) {
        blockedReason = "Interrupted writer: inspect preserved Creative Direction and acknowledge its exact digest; no automatic replay.";
      } else if (actualHead !== workHead(state) || changes.length) {
        blockedReason = "Foundation baseline has unexpected Git history or worktree edits.";
      }
      return {
        ...output(job, state),
        status: blockedReason ? "blocked" :
          state.stage === "committed" ? "committed" : "awaiting-author",
        recovery: { actualHead, changes, candidate, reason: blockedReason },
      };
    }
    if (state.stage === "awaiting-author") {
      if (!state.questions) {
        const discovery = await discoverQuestions(job, state,
          state.provider, state.model, state.workerMode === "fixture");
        assertHead(job, workHead(state));
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
    if (input.recoveryDigest) {
      if (state.stage !== "writing" || !state.writerStarted ||
          !/^[a-f0-9]{64}$/.test(input.recoveryDigest)) {
        throw new Error("Foundation reconciliation requires an interrupted writing work item and the exact reviewed --reconcile-digest.");
      }
      assertHead(job, workHead(state));
      assertOnlyTarget(job, target);
      await assertSafeTarget(job, target);
      if (state.workerMode === "pi" && !state.chatApprovalDigest) {
        await verifyJobPiSession(job, "foundation", state.piSessionFile, state.piSessionId);
      }
      const actual = await foundationDigest(job, target);
      if (actual !== input.recoveryDigest) {
        throw new Error("Foundation review digest differs from the current Story bytes; no changes were adopted.");
      }
      state.authoredSha256 = actual;
      state.reviewedRecoverySha256 = actual;
      await saveState(stateFile(job), state);
      return { ...output(job, state), status: "authored",
        recovery: { target, digest: actual, reviewed: true } };
    }
    if (state.stage === "committed" && git(job, "rev-parse", "HEAD") !== state.commitSha) {
      const head = await trustedHead(job);
      git(job, "merge-base", "--is-ancestor", state.commitSha!, head);
      if (changedPaths(job).length) throw new Error("Story worktree contains unexpected edits after the foundation work item.");
      return output(job, state);
    }
    if (state.stage === "writing" && state.writerStarted === undefined) {
      throw new Error("Legacy foundation writer state cannot prove the specialist was not started; inspect its worktree and Pi session before recovery.");
    }
    const recovered = recoveryCommit(job, state);
    if (recovered && changedPaths(job).length) {
      throw new Error("Job has unexpected uncommitted changes after its foundation commit.");
    }
    if (recovered && state.stage !== "committed" &&
        (!state.authoredSha256 || await foundationDigest(job, target) !== state.authoredSha256)) {
      throw new Error("Recovered foundation commit lacks exact recorded authored bytes; preserve it for reconciliation.");
    }
    if (state.writerStarted && state.stage !== "committed" && state.workerMode === "pi" && !state.chatApprovalDigest &&
        (!state.invocationVersion || hasStartedFoundationInvocation(job, state) || state.authoredSha256)) {
      await verifyJobPiSession(job, "foundation", state.piSessionFile, state.piSessionId);
    }
    if (state.stage === "committed") {
      if (recovered !== state.commitSha) throw new Error("Saved foundation commit differs from job HEAD.");
      await verifyFoundationInvocation(job, state);
      await advanceInboxVerifiedHead(job, state, state.commitSha!);
      await finalizeRecoveryCheckpoint(job, WORK_ITEM, workHead(state), state.commitSha!);
      return output(job, state);
    }
    state = await executeFoundationGraph(job, state, input, recovered);
    const authorUpdates = await processAuthorUpdatesAfterWork(job);
    return { ...output(job, state), authorUpdates };
  });
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
      assertHead(job, workHead(foundation));
      if (foundation.writerStarted && !foundation.authoredSha256 && foundation.workerMode === "pi" &&
          foundation.invocationVersion === 1 && !foundation.chatApprovalDigest) {
        if (!hasStartedFoundationInvocation(job, foundation)) {
          if (changedPaths(job).length) throw Error("Unstarted Foundation invocation has unexpected effects.");
          // No external prompt was admitted. A lazy Pi transcript may not exist.
          if (foundation.piSessionFile && !existsSync(foundation.piSessionFile)) {
            foundation.piSessionFile = undefined;
            foundation.piSessionId = undefined;
          }
        }
        const authored = await piAuthor(job, foundation, target, foundation.provider, foundation.model,
          async (id, path) => {
            foundation.piSessionId = id;
            foundation.piSessionFile = path;
            await saveState(stateFile(job), foundation);
          }, input.validatorSource ?? input.skillsSource);
        const next = { ...foundation, ...authored, authoredSha256: await foundationDigest(job, target) };
        await saveState(stateFile(job), next);
        return { foundation: next };
      }
      if (foundation.writerStarted) {
        if (!foundation.authoredSha256) {
          throw new Error("Interrupted foundation writer; preserve unfinished files and original Pi session. Never replay writer tools.");
        }
        assertOnlyTarget(job, target);
        await assertSafeTarget(job, target);
        if (await foundationDigest(job, target) !== foundation.authoredSha256) {
          throw new Error("Authored foundation bytes changed after interruption; manual reconciliation is required.");
        }
        await verifyFoundationInvocation(job, foundation);
        return {};
      }
      if (changedPaths(job).length) {
        throw new Error("Unfinished foundation edits exist. Inspect and reconcile them; the specialist will not blindly rerun.");
      }
      if (foundation.chatApprovalDigest) {
        const approval = await readChatApprovedFoundation(job);
        if (!approval || approval.proposalDigest !== foundation.chatApprovalDigest ||
            approval.skillId !== foundation.snapshot.id || approval.originalObjective !== foundation.task)
          throw new Error("Approved Chat baseline provenance no longer matches this work item.");
        const path = join(job.worktreeStoryRoot, target);
        const folder = dirname(path);
        await mkdir(folder, { recursive: true });
        const parent = await lstat(folder);
        if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(folder) !== folder)
          throw new Error("Creative Direction parent is not a real Story directory.");
        const previousTarget = await lstat(path).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (previousTarget) {
          if (!previousTarget.isFile() || previousTarget.isSymbolicLink() ||
              await realpath(path) !== path)
            throw new Error("Approved Creative Direction cannot overwrite a linked or unsafe file.");
          const previous = await readFile(path, "utf8");
          if (!previous.includes("Pending author discovery") || hasUserProtectedDecision(previous))
            throw new Error("Existing Creative Direction is not an unapproved initialization draft; preserve its canon.");
        }
        // Record the irreversible boundary before changing the Story. A crash
        // now requires explicit reconciliation, never a second foundation writer.
        foundation.writerStarted = true;
        await saveState(stateFile(job), foundation);
        await writeFile(path, renderFoundation(approval.foundation, 'approved'), {
          mode: 0o600, flag: previousTarget ? "w" : "wx",
        });
        const next = { ...foundation, authoredSha256: await foundationDigest(job, target) };
        if (next.authoredSha256 !== approval.authoredSha256)
          throw new Error("Written Creative Direction differs from the exact Chat approval.");
        await saveState(stateFile(job), next);
        assertOnlyTarget(job, target);
        await assertSafeTarget(job, target);
        return { foundation: next };
      }
      // Budget pauses must happen before the irreversible writerStarted marker.
      await preflightPiAssignment(job, "foundation:write", foundation.workerMode === "pi"
        ? { provider: foundation.provider, model: foundation.model } : undefined);
      foundation.writerStarted = true;
      if (foundation.workerMode === "pi") foundation.invocationVersion = 1;
      await saveState(stateFile(job), foundation);
      const authored = foundation.workerMode === "fixture"
        ? await fixtureAuthor(job, foundation, target)
        : await piAuthor(job, foundation, target, foundation.provider, foundation.model,
          async (id, path) => {
            foundation.piSessionId = id;
            foundation.piSessionFile = path;
            await saveState(stateFile(job), foundation);
          }, input.validatorSource ?? input.skillsSource);
      const next = { ...foundation, ...authored, authoredSha256: await foundationDigest(job, target) };
      await saveState(stateFile(job), next);
      assertHead(job, workHead(foundation));
      assertOnlyTarget(job, target);
      await assertSafeTarget(job, target);
      return { foundation: next };
    })
    .addNode("validate_and_commit_foundation", async ({ foundation, recovered }) => {
      const target = foundation.target!;
      const config = await loadSkillConfig(undefined, false);
      const validation = await validateStoryJob(job, input.validatorSource ?? input.skillsSource ?? config.novelteaSkills);
      const verified = assertValidation(job, validation);
      await verifyFoundationInvocation(job, foundation);
      assertOnlyTargetForCommit(job, target, recovered);
      if (!foundation.authoredSha256 || await foundationDigest(job, target) !== foundation.authoredSha256) {
        throw new Error("Foundation bytes differ from the exact authored work item; commit refused.");
      }
      if (!recovered) {
        assertHead(job, workHead(foundation));
        git(job, "add", "--", storyPath(job, target));
        if (git(job, "diff", "--cached", "--name-only") !== storyPath(job, target)) {
          throw new Error("Git staging contains unexpected files; commit refused.");
        }
        git(job, "-c", `user.name=${AGENT_NAME}`, "-c", `user.email=${AGENT_EMAIL}`,
          "commit", "--only", "-m",
          `Generate Creative Direction [${job.jobId}/${WORK_ITEM}]\n\nNovelTea-Job: ${job.jobId}\nNovelTea-Work-Item: ${WORK_ITEM}\nNovelTea-Validation: ${verified}\nNovelTea-Foundation: ${foundation.authoredSha256}` +
          (foundation.reviewedRecoverySha256 ? `\nNovelTea-Reviewed-Recovery: ${foundation.reviewedRecoverySha256}` : ""),
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
      await advanceInboxVerifiedHead(job, next, next.commitSha!);
      await finalizeRecoveryCheckpoint(job, WORK_ITEM, workHead(next), next.commitSha!);
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
