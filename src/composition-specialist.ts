import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { agentValidatorBashTool } from "./validator.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

export interface CompositionAssignment {
  milestoneId: string;
  workItemId: string;
  authorContract: unknown;
  sourcePaths: string[];
  mandatoryReads: string[];
  allowedExistingContent: string[];
  eventIds: string[];
  choicePoints: Array<{ id: string; events: string[]; outcomes: string[] }>;
  puzzleSolutions: Array<{ id: string; eventIds: string[] }>;
  branchWitnesses: Array<{ event: string; step: string; branch: string; witness: string[] }>;
  requiredSources: string[];
}
export interface CompositionEvidence {
  modifiedRecords: string[];
  conflicts: string[];
  obligations: string[];
  skillReads: string[];
  piSessionFile?: string;
}
export interface SemanticReview {
  verdict: "pass" | "block";
  sourceEvidence: string[];
  concerns: string[];
  sessionFile?: string;
}

const catalog = [
  "nt-catalog/SKILL.md", "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
];
const guidance = ["nt-narrative-composition/SKILL.md", ...catalog];
function parseJson(text: string): Record<string, unknown> {
  const candidates = [text.trim(), ...[...text.matchAll(/\{[\s\S]*?\}/g)].map(m => m[0])];
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Record<string, unknown>;
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch { /* continue */ }
  }
  throw new Error("Composition specialist returned no parseable JSON manifest.");
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(s => typeof s === "string" && s.length > 0);
}
async function createSession(job: JobStartResult, snapshot: SkillSnapshot, workItemId: string,
  provider: string, modelId: string, thinking: "low" | "high" | undefined,
  phase: "write" | "review") {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-narrative-composition", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Composition skill discovery: " + diag.message);
  for (const name of ["nt-narrative-composition", "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned composition specialist skill: " + name);
    }
  }
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider, modelId);
  if (!model || !(await runtime.getAvailable(provider)).some(m => m.id === modelId)) {
    throw new Error(`Unavailable composition Pi model or credentials: ${provider}/${modelId}`);
  }
  const dir = join(dirname(job.worktreeRoot), "composition-sessions", workItemId, phase);
  await mkdir(dir, { recursive: true });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model, thinkingLevel: thinking, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(project.root, dir),
    ...(phase === "write" ? { customTools: [await agentValidatorBashTool(job)] } : {}),
    noTools: "all", tools: phase === "write"
      ? ["read", "write", "edit", "bash", "grep", "find", "ls"] : ["read", "grep", "find", "ls"],
  });
  if (thinking && session.thinkingLevel !== thinking) {
    session.dispose(); throw new Error("Pi did not honor requested thinking effort.");
  }
  return { session, project, pinned: guidance.map(p => join(snapshot.path, "skills", p)) };
}
function lastReply(session: Awaited<ReturnType<typeof createSession>>["session"]) {
  const last = [...session.messages].reverse().find(m => m.role === "assistant");
  if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
    throw new Error("Composition Pi turn failed: " + (last?.role === "assistant" ? last.stopReason : "no response"));
  }
  return last.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
function toolPaths(session: Awaited<ReturnType<typeof createSession>>["session"], projectRoot: string) {
  const done = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
    m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
  return session.messages.flatMap(m => m.role === "assistant"
    ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
      c.type === "toolCall" && done.has(c.id) &&
      typeof c.arguments?.path === "string").map(c => ({
        tool: c.name, path: resolve(projectRoot, c.arguments.path as string),
        relative: relative(projectRoot, resolve(projectRoot, c.arguments.path as string)).split(sep).join("/"),
      })) : []);
}
export async function authorComposition(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: CompositionAssignment, provider: string, modelId: string,
  thinking: "low" | "high" | undefined, onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: CompositionEvidence) => Promise<string[]>): Promise<CompositionEvidence> {
  const { session, project, pinned } = await createSession(job, snapshot, assignment.workItemId,
    provider, modelId, thinking, "write");
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile);
    let prompt = "You are a pinned nt-narrative-composition author for one bounded composition milestone. " +
      "FIRST read ALL pinned guidance files below using read, then read sourcePaths including Event steps, " +
      "Character voices, Relationship, Facts, Revelations, any optional clue discovery, and existing content.\n" +
      pinned.join("\n") + "\n" +
      "Write real player-facing dialogue/narration in canonical authored-content/*.md only. " +
      "No engine records, no invented schema keys, no branch retcons. Edit ONLY allowedExistingContent " +
      "or add new Authored Content; do NOT alter other Story records, including Events, Choice Points, Milestones, " +
      "Character or Creative Direction, and do not edit read-only puzzle clue content. " +
      "Existing protected author wording must be preserved. Work from the least-informed reachable entry: " +
      "shared text cannot assume exclusive Choice outcomes, conditional Revelation, or optional clue. " +
      "Use literal headings '## Shared entry', '## Choice wording', and one '## <Outcome> selected' " +
      "for EACH declared outcome in its linked Event content. Menu text must contain labels only; write distinct " +
      "actual dialogue and reactions in each selected section. Compose actual prose for EACH puzzle solution Event, " +
      "with optional discoveries conditional, not assumed. Do not write editorial directions as playable prose. " +
      "If a source lacks a needed route, report a conflict; NEVER manufacture new Event effects or bypass gates. " +
      "Run noveltea narrative validate . --json and inspect Git diff. Do not git add, reset, checkout or commit. " +
      "Finally output ONE unfenced JSON object with the cumulative paths and precise obligations: " +
      '{"modifiedRecords":["authored-content/example.md"],"architecturalConflicts":[],"laterObligations":[]}. ' +
      "Graph will independently verify sources, actual Markdown, coverage and editorial review.\nASSIGNMENT:\n" +
      JSON.stringify(assignment, null, 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      await session.prompt(prompt);
      const text = lastReply(session);
      const calls = toolPaths(session, project.root);
      if (pinned.some(p => !calls.some(c => c.tool === "read" && c.path === p)) ||
          assignment.mandatoryReads.some(p => !calls.some(c => c.tool === "read" && c.relative === p))) {
        throw new Error("Composition specialist omitted pinned skill or essential source reads.");
      }
      if (!calls.some(c => ["write", "edit"].includes(c.tool) && c.relative.startsWith("authored-content/"))) {
        throw new Error("Composition specialist did not author canonical Authored Content.");
      }
      const parsed = parseJson(text);
      if (!strings(parsed.modifiedRecords) || !parsed.modifiedRecords.length ||
          !strings(parsed.architecturalConflicts) || !strings(parsed.laterObligations)) {
        throw new Error("Composition specialist must report modifiedRecords, architecturalConflicts and laterObligations.");
      }
      const evidence: CompositionEvidence = {
        modifiedRecords: parsed.modifiedRecords, conflicts: parsed.architecturalConflicts,
        obligations: parsed.laterObligations, skillReads: pinned,
        piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
      };
      const problems = await verifyDraft(evidence);
      if (!problems.length) return evidence;
      if (attempt === 2) throw new Error("Composition exhausted bounded repairs: " + problems.join("; "));
      prompt = "The independent graph audit rejected the draft. In this SAME session, repair only the " +
        "problems below, without changing Event/Choice/Milestone/Character/Fact/Relationship/author-protected canon. " +
        "Read saved prose and replay ALL branches, including least-informed entry and optional clues. " +
        "Re-run validation and report the FULL changed path manifest.\n" + problems.join("\n");
    }
    throw new Error("Composition repair loop terminated unexpectedly.");
  } finally { session.dispose(); }
}
export async function reviewComposition(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: CompositionAssignment, paths: string[], provider: string, modelId: string,
  thinking: "low" | "high" | undefined, onSession: (file: string) => Promise<void>): Promise<SemanticReview> {
  const { session, project, pinned } = await createSession(job, snapshot, assignment.workItemId,
    provider, modelId, thinking, "review");
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile);
    await session.prompt("You are an INDEPENDENT read-only editorial reviewer. Read the pinned composition " +
      "skill and catalog, the ACTUAL saved authored-content paths, linked Events, all choice outcomes, " +
      "both Puzzle solution events, character voices, initial knowledge, facts, revelations, and optional " +
      "discovery routes. Do not trust the writer's explanation or Event narrative body as proof of state. " +
      "Compare each line against the least-informed reachable route and the exact source step/branch. " +
      "Block any leaked branch-only truth in shared/menu prose, leaked or omitted optional discoveries, " +
      "missing executable route prose, summaries instead of playable lines, author-protected changes " +
      "or incoherent consequences. Do not edit or invoke shell. Read these pinned references FIRST:\n" +
      pinned.join("\n") + "\n Read these Story paths:\n" +
      [...new Set([...assignment.sourcePaths, ...paths])].join("\n") +
      "\nReturn unfenced JSON ONLY: " +
      '{"verdict":"pass"|"block","sourceEvidence":["event.X#step/branch licenses ..."],"concerns":[]}. ' +
      "A pass requires explicit source-linked evidence for EVERY choice outcome and BOTH puzzle endings. " +
      "If uncertain, block.\nASSIGNMENT:\n" + JSON.stringify(assignment, null, 2));
    const parsed = parseJson(lastReply(session));
    const calls = toolPaths(session, project.root);
    if (pinned.some(p => !calls.some(c => c.tool === "read" && c.path === p)) ||
        [...assignment.mandatoryReads, ...paths].some(p =>
          !calls.some(c => c.tool === "read" && c.relative === p))) {
      throw new Error("Independent composition reviewer did not read pinned skill, essential source witnesses and saved prose.");
    }
    if ((parsed.verdict !== "pass" && parsed.verdict !== "block") ||
        !strings(parsed.sourceEvidence) || !strings(parsed.concerns)) {
      throw new Error("Independent composition reviewer returned an invalid source-linked verdict.");
    }
    return { verdict: parsed.verdict, sourceEvidence: parsed.sourceEvidence,
      concerns: parsed.concerns, sessionFile: sessionFile ?? undefined };
  } finally { session.dispose(); }
}
