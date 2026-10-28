import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { agentValidatorBashTool } from "./validator.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";

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
  onSession: (path: string) => Promise<void>,
): Promise<{ piSessionFile?: string; skillReads: string[] }> {
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
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(candidate => candidate.id === modelId)) {
    throw new Error(`Unavailable architecture Pi model or credentials: ${provider}/${modelId}`);
  }
  const sessionDir = join(dirname(job.worktreeRoot), "architecture-sessions");
  await mkdir(sessionDir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(project.root, sessionDir),
    customTools: [await agentValidatorBashTool(job)],
    noTools: "all", tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile);
    await session.prompt(
      "You are the NovelTea Story architecture specialist, working on an isolated Git-backed Story. " +
      "Read the following pinned skill instructions using the read tool before writing:\n" +
      REQUIRED.map(path => join(snapshot.path, "skills", path)).join("\n") +
      "\nRead the actual canonical Creative Direction and any relevant existing Story records. " +
      "Follow nt-story-architecture and nt-catalog. Do not invent an alternative narrative schema. " +
      "AUTHOR actual Arc and Milestone Markdown inside the Story root using ordinary write/edit tools. " +
      "Only write arcs/*.md and milestones/*.md; do not edit Creative Direction, Events, other records, or project files. " +
      "Use schema '0.1', valid typed IDs/references and honest status draft. " +
      "Planning-stage Milestones without real Events MUST have completeness: partial and fulfillment: {any_of: []}. " +
      "Describe plausible future routes and their required causal prerequisites in prose, not as speculative typed Event IDs. " +
      "Never invent Events, fixed act/ending/Puzzle counts, approvals, or completion claims. " +
      "Preserve existing user-protected decisions; never change an existing record unless safely authorized. " +
      "Honor branch/depth/target selection and do not shrink or redefine the contract yourself. " +
      "Do not run git add/commit/reset/checkout or alter Git history. Grep, rg, git status/diff and similar inspections are allowed. " +
      "The graph independently validates, inspects and commits your changes. " +
      "Production economy is an explicit constraint, not a universal fixed budget. " +
      "Frontmatter free-text YAML scalars must be quoted; avoid invalid colon-containing unquoted values. " +
      "Before finishing, run noveltea narrative validate . --json, inspect diagnostics and coverage, repair problems and rerun validation; the graph independently decides acceptance. Explain downstream obligations.\n" +
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
    return { piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
      skillReads: reads.filter(p => required.includes(p)) };
  } finally {
    session.dispose();
  }
}
