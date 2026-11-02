import { mkdir } from "node:fs/promises";
import { createJobModelRuntime } from "./model-runtime.js";
import { join, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";

const REQUIRED = [
  "nt-story-architecture/SKILL.md",
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
] as const;

/** The specialist authors Markdown; it cannot approve, validate, or commit its own output. */
export async function authorArchitecture(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  plan: Plan,
  provider: string,
  modelId: string,
  onSession: (sessionId: string, path: string) => Promise<void>,
): Promise<{ piSessionId: string; piSessionFile?: string; skillReads: string[] }> {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = {
    discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-story-architecture", "nt-catalog"],
  };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "error") throw new Error("Architecture skill discovery: " + diagnostic.message);
  }
  for (const name of ["nt-story-architecture", "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned architecture skill " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "architecture-sessions");
  const context = await preparePiContext(job, project, {
    group: "architecture", step: "architecture:" + plan.version,
    paths: ["creative-direction/foundation.md"], snapshot: snapshot.id,
    provider, model: modelId, directory: sessionDir,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [...(sandboxTools ?? []), createStoryValidateTool(job), context.contextTool],
    noTools: "all", tools: [...SANDBOX_TOOLS, "story_context", "story_validate"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi architecture specialist did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Architecture Pi session transcript cannot be persisted; writer will not begin.");
    await onSession(session.sessionId, sessionFile);
    await context.beforeTurn(sessionFile);
    await promptStorySpecialist(session,
      context.contextNote + "You are the NovelTea Story architecture specialist, working on an isolated Git-backed Story. " +
      "Read the following pinned skill instructions using the read tool before writing:\n" +
      REQUIRED.map(path => join(snapshot.path, "skills", path)).join("\n") +
      "\nRead the actual canonical Creative Direction and any relevant existing Story records. " +
      "Do not read or search the noncanonical .story-inbox/ideas directory (including via git grep/show or rg --hidden); " +
      "dormant author concepts and dialogue must not influence early architecture. Only use explicitly supplied scoped constraints. " +
      "Follow nt-story-architecture and nt-catalog. Do not invent an alternative narrative schema. " +
      "AUTHOR actual Arc and Milestone Markdown inside the Story root using ordinary write/edit tools. " +
      "Only write arcs/*.md and milestones/*.md; do not edit Creative Direction, Events, other records, or project files. " +
      "Use schema '0.1', valid typed IDs/references and honest status draft. " +
      "Planning-stage Milestones without real Events MUST have completeness: partial and fulfillment: {any_of: []}. " +
      "Describe plausible future routes and their required causal prerequisites in prose, not as speculative typed Event IDs. " +
      "Never invent Events, fixed act/ending/Puzzle counts, approvals, or completion claims. " +
      "Preserve existing user-protected decisions; never change an existing record unless safely authorized. " +
      "Honor branch/depth/target selection and do not shrink or redefine the contract yourself. " +
      (sandboxTools ? "The shell operates only inside /story, without Git, host credentials or network. Read pinned skills through the read tool; use story_validate for native validation. " :
        "Do not run git add/commit/reset/checkout or alter Git history. Grep, rg, git status/diff and similar inspections are allowed. ") +
      "The graph independently validates, inspects and commits your changes. " +
      "Production economy is an explicit constraint, not a universal fixed budget. " +
      "Frontmatter free-text YAML scalars must be quoted; avoid invalid colon-containing unquoted values. " +
      "Before finishing, call story_validate with no arguments, inspect diagnostics and coverage, repair problems and rerun validation; the graph independently decides acceptance. Explain downstream obligations.\n" +
      "AUTHORIZED PLAN AND SCOPE:\n" + JSON.stringify(plan, null, 2) +
      "\nOnly implement the global architecture work item now, not the downstream realization or composition items.",
    );
    const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!assistant || assistant.role !== "assistant" ||
        ["error", "aborted"].includes(assistant.stopReason)) {
      throw new Error("Architecture specialist did not complete a successful Pi turn.");
    }
    const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const calls = session.messages.flatMap(m => m.role === "assistant"
      ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall")
      : []);
    const reads = calls.filter(c => completed.has(c.id) && c.name === "read" &&
      typeof c.arguments?.path === "string")
      .map(c => resolve(project.root, c.arguments.path as string));
    const required = REQUIRED.map(p => join(snapshot.path, "skills", p));
    if (required.some(path => !reads.includes(path))) {
      throw new Error("Architecture specialist did not read all required pinned skill references.");
    }
    const authored = calls.some(c => completed.has(c.id) && ["write", "edit"].includes(c.name) &&
      typeof c.arguments?.path === "string" &&
      /^(arcs|milestones)\/[a-z][a-z0-9-]*\.md$/.test(
        resolve(project.root, c.arguments.path as string).slice(project.root.length + 1).split(sep).join("/"),
      ));
    if (!authored) throw new Error("Architecture specialist did not author canonical Arc/Milestone Markdown.");
    await context.completed(sessionFile, session.sessionId);
    return { piSessionId: session.sessionId, piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
      skillReads: reads.filter(p => required.includes(p)) };
  } finally {
    session.dispose();
  }
}
