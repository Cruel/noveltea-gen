import { mkdir } from "node:fs/promises";
import { createJobModelRuntime } from "./model-runtime.js";
import { join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { selectSandboxPiTools, SANDBOX_TOOLS, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup } from "./job-pi-policy.js";
import { completedContextReads } from "./story-context.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";

export interface CompositionAssignment {
  milestoneId: string;
  workItemId: string;
  authorTask?: string;
  authorContract: unknown;
  sourcePaths: string[];
  mandatoryReads: string[];
  allowedExistingContent: string[];
  eventIds: string[];
  composeTargets: string[];
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
/** Extract the last complete JSON object from model text. A response may
 * contain a prose preface or fenced block; never parse partial nested braces. */
export function parseSpecialistJson(text: string): Record<string, unknown> {
  const objects: Record<string, unknown>[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const data: unknown = JSON.parse(text.slice(start, end + 1));
          if (data && typeof data === "object" && !Array.isArray(data)) objects.push(data as Record<string, unknown>);
        } catch { /* next candidate */ }
        break;
      }
    }
  }
  const match = objects.reverse().find(data => "modifiedRecords" in data || "verdict" in data);
  if (!match) throw new Error("Composition specialist returned no parseable JSON manifest.");
  return match;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(s => typeof s === "string" && s.length > 0);
}
async function createSession(job: JobStartResult, snapshot: SkillSnapshot, assignment: CompositionAssignment,
  provider: string, modelId: string, thinking: "low" | "high" | undefined,
  phase: "write" | "review", extraPaths: string[] = [], insideWriter = false) {
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
  const runtime = await createJobModelRuntime();
  const dir = join(job.stateDir, "composition-sessions", assignment.workItemId, phase);
  const context = await preparePiContext(job, project, {
    group: piNarrativeGroup("composition:" + phase, assignment.sourcePaths, assignment.milestoneId),
    step: "composition:" + assignment.workItemId + ":" + phase,
    paths: [...assignment.sourcePaths, ...extraPaths], snapshot: snapshot.id,
    task: { kind: "dialogue", ids: assignment.eventIds, scope: "related" },
    provider, model: modelId, thinking, directory: dir, insideWriter,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills, undefined,
    phase === "review" ? "read-only" : "writer");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [...(sandboxTools ?? []), ...(phase === "write" ? [createStoryValidateTool(job)] : []), context.contextTool],
    noTools: "all", tools: phase === "write"
      ? [...SANDBOX_TOOLS, "story_context", "story_validate"]
      : [...SANDBOX_READ_ONLY_TOOLS, "story_context"],
  });
  if (context.thinking && session.thinkingLevel !== context.thinking) {
    session.dispose(); throw new Error("Pi did not honor requested thinking effort.");
  }
  return { session, project, context, sandboxed: !!sandboxTools,
    pinned: guidance.map(p => join(snapshot.path, "skills", p)) };
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
  const direct = session.messages.flatMap(m => m.role === "assistant"
    ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
      c.type === "toolCall" && done.has(c.id) &&
      typeof c.arguments?.path === "string").map(c => ({
        tool: c.name, path: resolve(projectRoot, c.arguments.path as string),
        relative: relative(projectRoot, resolve(projectRoot, c.arguments.path as string)).split(sep).join("/"),
      })) : []);
  return [...direct, ...completedContextReads(session.messages, projectRoot).map(relativePath => ({
    tool: "read", path: resolve(projectRoot, relativePath), relative: relativePath,
  }))];
}
export async function authorComposition(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: CompositionAssignment, provider: string, modelId: string,
  thinking: "low" | "high" | undefined, onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: CompositionEvidence) => Promise<string[]>): Promise<CompositionEvidence> {
  const { session, project, pinned, context, sandboxed } = await createSession(job, snapshot, assignment,
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
      "Ensure one playable Authored Content document per Event in composeTargets, reusing valid existing documents; each has " +
      "events: [that-single-event] and revelations: [only Revelations presented by that Event]. " +
      "Do not combine all Event prose into one record; each file has exactly one playback owner. " +
      "Existing clue Authored Content in sourcePaths already covers its linked discovery Events: read " +
      "those records, leave them unchanged, and do not double-author their discovery text. " +
      "In the Choice Event file use literal headings '## Shared entry', '## Choice wording', and " +
      "'## <Outcome> selected' for EACH declared outcome. Menu contains selectable labels only; " +
      "the entry and menu never reveal branch-only truths or presume physical props. " +
      "The Story may begin at the Choice Event with no clues discovered: write the shared entry and " +
      "choice labels for this least-informed route. Only the challenge branch's revealed effect " +
      "licenses revelation.ledger-secret, if present in the source; protecting does not. " +
      "Every later outcome-conditioned Event, including an aftermath, needs distinct playable " +
      "'## <Outcome> selected' sections for every reachable condition branch, not a generic summary. " +
      "For each Puzzle solution Event, ensure standalone playable dialogue/narration under " +
      "'## Solution consequence' using only clues required on that route. Never place the watermark " +
      "in the seal/testimony route without an additional prerequisite, nor vice versa. " +
      "Do not write editorial directions as playable prose. " +
      "If a source lacks a needed route, report a conflict; NEVER manufacture new Event effects or bypass gates. " +
      (sandboxed ?
        "Call story_validate with no arguments; Git and host shell access are unavailable in the sandbox. " :
        "Call story_validate with no arguments and inspect Git diff. Do not git add, reset, checkout or commit. ") +
      "Finally output ONE unfenced JSON object with the cumulative paths and precise obligations: " +
      '{"modifiedRecords":["authored-content/example.md"],"architecturalConflicts":[],"laterObligations":[]}. ' +
      "Graph will independently verify sources, actual Markdown, coverage and editorial review.\nASSIGNMENT:\n" +
      JSON.stringify(assignment, null, 2) + specialistAuthorInstruction(assignment.authorTask);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + prompt : prompt);
      await requirePinnedSkillReads(session, project.root, pinned, "Composition specialist");
      let text = lastReply(session);
      let parsed: Record<string, unknown> | undefined;
      for (let formatAttempt = 0; formatAttempt < 3; formatAttempt++) {
        try { parsed = parseSpecialistJson(text); break; }
        catch (error) {
          if (formatAttempt === 2) throw error;
          await promptStorySpecialist(session, "Reformat your LAST cumulative modifiedRecords, architecturalConflicts, " +
            "and laterObligations report as a single valid JSON object. " +
            "Preserve the already-authored files unchanged; only correct the response format.");
          text = lastReply(session);
        }
      }
      if (!parsed) throw new Error("Composition specialist manifest was not provided.");
      const calls = toolPaths(session, project.root);
      if (assignment.mandatoryReads.some(p => !calls.some(c => c.tool === "read" && c.relative === p))) {
        throw new Error("Composition specialist omitted pinned skill or essential source reads.");
      }
      if (!calls.some(c => ["write", "edit"].includes(c.tool) && c.relative.startsWith("authored-content/"))) {
        throw new Error("Composition specialist did not author canonical Authored Content.");
      }
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
      if (!problems.length) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
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
  thinking: "low" | "high" | undefined, onSession: (file: string) => Promise<void>,
  insideWriter = false): Promise<SemanticReview> {
  const { session, project, pinned, context } = await createSession(job, snapshot, assignment,
    provider, modelId, thinking, "review", paths, insideWriter);
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile);
    await context.beforeTurn(sessionFile);
    await promptStorySpecialist(session, context.contextNote + "You are an INDEPENDENT read-only editorial reviewer. Read the pinned composition " +
      "skill and catalog, the ACTUAL saved authored-content paths, linked Events, all choice outcomes, " +
      "both Puzzle solution events, character voices, initial knowledge, facts, revelations, and optional " +
      "discovery routes. Do not trust the writer's explanation or Event narrative body as proof of state. " +
      "Compare each line against the least-informed reachable route and the exact source step/branch. " +
      "Block actual authored prose defects: leaked branch-only truth in shared/menu text, " +
      "unearned optional evidence, missing outcome-conditioned aftermath, missing Event ownership, " +
      "summaries instead of playable lines, author-protected rewordings or incoherent consequences. " +
      "One Authored Content record per composeTargets Event is required; existing clue content " +
      "covers its discovery Event. An Event's narrative body is planning context, NOT proof of " +
      "player knowledge or a physically present object. Review the actual saved prose ONLY for " +
      "what can be established from these records; do not block because engine UI/backdrop is " +
      "outside this ticket or because the schema lacks typed step-level content links. " +
      "Use headings for branch ownership. Report only actionable contradictions in authored prose. " +
      "Do not edit or invoke shell. Read these pinned references FIRST:\n" +
      pinned.join("\n") + "\n Read these Story paths:\n" +
      [...new Set([...assignment.sourcePaths, ...paths])].join("\n") +
      "\nReturn unfenced JSON ONLY: " +
      '{"verdict":"pass"|"block","sourceEvidence":["event.X#step/branch licenses ..."],"concerns":[]}. ' +
      "A pass requires explicit source-linked evidence for EVERY choice outcome and BOTH puzzle endings. " +
      "If uncertain, block.\nASSIGNMENT:\n" + JSON.stringify(assignment, null, 2));
    const missingReads = () => {
      const calls = toolPaths(session, project.root);
      return [...pinned, ...[...assignment.mandatoryReads, ...paths].map(p => resolve(project.root, p))]
        .filter(path => !calls.some(c => c.tool === "read" && c.path === path));
    };
    if (missingReads().length) {
      await promptStorySpecialist(session, "Your independent review is incomplete. Use read to inspect " +
        "each EXACT missing pinned skill or canonical Story file below; do not edit or invoke shell. " +
        "Then independently reassess the ACTUAL saved prose and return a new source-linked " +
        "verdict/sourceEvidence/concerns JSON object.\nMISSING READS:\n" + missingReads().join("\n"));
    }
    if (missingReads().length) {
      throw new Error("Independent composition reviewer did not read pinned skill, essential source witnesses and saved prose.");
    }
    const parsed = parseSpecialistJson(lastReply(session));
    if ((parsed.verdict !== "pass" && parsed.verdict !== "block") ||
        !strings(parsed.sourceEvidence) || !strings(parsed.concerns)) {
      throw new Error("Independent composition reviewer returned an invalid source-linked verdict.");
    }
    await context.completed(sessionFile!, session.sessionId);
    return { verdict: parsed.verdict, sourceEvidence: parsed.sourceEvidence,
      concerns: parsed.concerns, sessionFile: sessionFile ?? undefined };
  } finally { session.dispose(); }
}
