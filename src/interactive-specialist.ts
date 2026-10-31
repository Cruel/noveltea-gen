import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

export type InteractiveDomain = "choice" | "puzzle";
export interface InteractiveAssignment {
  workItemId: string;
  milestoneId: string;
  arcIds: string[];
  characterIds: string[];
  factIds: string[];
  eventIds: string[];
  sourcePaths: string[];
  authorContract: unknown;
  protectedRouteGates: "immutable-existing-event-prerequisites";
  authorizedPaths: string[];
  downstreamRequirements: string[];
}
export interface InteractiveEvidence {
  modifiedRecords: string[];
  conflicts: string[];
  obligations: string[];
  skillReads: string[];
  piSessionFile?: string;
}
const CATALOG = [
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
];
const SPECIALISTS = {
  choice: {
    name: "nt-interactive-narrative",
    guidance: "Develop a real two-outcome Choice Point. Canonical choice-point.outcomes MUST be an array of plain outcome slug strings (for example [protect, confront]), not objects, labels or descriptions; put option explanations in the Markdown body. The Story model intentionally does not represent engine UI input binding: a step with multiple enabled conditions: [] branches, each setting a distinct kind: outcome effect, is the canonical representation of selectable narrative alternatives (exact user-facing UI controls are downstream work, not an architectural blocker). Place each exclusive outcome effect in a reachable Event step branch, with materially different immediate state and a later conditional consumer. Preserve original Event prerequisites verbatim. Never reveal branch-exclusive information in shared prose or the other branch. Complete the choice/branch work before proposing the Puzzle. Do not create Puzzle records in this unit.",
  },
  puzzle: {
    name: "nt-puzzle-design",
    guidance: "Create a complete narrative Puzzle with at least TWO distinct reachable solving Events and pre-solution Authored Content clues each attached to a separate reachable discovery Event. Clue Markdown must actually describe the player-visible observation, and Puzzle prose should explain goal, inference, failed attempts, hints and solution payoffs. Do not link content first presented in a solution Event as a Puzzle clue. Solution Events must have real gated prerequisites and consequences, not merely be named in the Puzzle. Preserve original Event prerequisites and Choice Point outcomes.",
  },
} as const;
function parseManifest(text: string) {
  const match = text.match(/\{\s*"modifiedRecords"\s*:\s*\[[^\]]*\][^{}]*\}/g)?.at(-1);
  let obj: Record<string, unknown> | undefined;
  try { obj = JSON.parse(match ?? "null") as Record<string, unknown>; } catch { /* reject */ }
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(x => typeof x === "string" && x.length > 0);
  if (!obj || !strings(obj.modifiedRecords) || !obj.modifiedRecords.length ||
      !strings(obj.architecturalConflicts) || !strings(obj.laterObligations)) {
    throw new Error("Interactive specialist must return complete modifiedRecords, architecturalConflicts and laterObligations JSON.");
  }
  return { paths: obj.modifiedRecords, conflicts: obj.architecturalConflicts,
    obligations: obj.laterObligations };
}
export async function authorInteractive(job: JobStartResult, snapshot: SkillSnapshot,
  domain: InteractiveDomain, assignment: InteractiveAssignment, provider: string, modelId: string,
  thinking: "low" | "high" | undefined,
  onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: InteractiveEvidence) => Promise<string[]>): Promise<InteractiveEvidence> {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const selected = SPECIALISTS[domain];
  const required = [selected.name + "/SKILL.md", ...CATALOG];
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: [selected.name, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Interactive skill discovery: " + diag.message);
  for (const name of [selected.name, "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned interactive specialist " + name);
    }
  }
  const runtime = await ModelRuntime.create();
  const dir = join(dirname(job.worktreeRoot), "interactive-sessions", assignment.workItemId, domain);
  const context = await preparePiContext(job, project, {
    group: piNarrativeGroup("interactive:" + domain, assignment.sourcePaths, assignment.milestoneId),
    step: "interactive:" + assignment.workItemId + ":" + domain,
    paths: assignment.sourcePaths, snapshot: snapshot.id, provider, model: modelId,
    task: { kind: "puzzle", ids: [...assignment.eventIds, assignment.milestoneId], scope: "related" },
    thinking, directory: dir,
  }, runtime);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [createStoryValidateTool(job), context.contextTool],
    noTools: "all", tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "story_context", "story_validate"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi did not honor requested " + thinking + " thinking level.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) await onSession(sessionFile);
    const pinned = required.map(name => join(snapshot.path, "skills", name));
    let prompt = `You are the real pinned NovelTea ${selected.name} specialist authoring ONE bounded ${domain} work item.\n` +
      "Read each of these skill references using the read tool BEFORE authoring:\n" + pinned.join("\n") +
      "\nRead the relevant Story sources in the assignment. Follow only necessary typed references. " +
      "Use canonical schema '0.1' Story Markdown only, with nonempty narrative body and exact permitted fields. " +
      "No engine Dialogue/Room/Scene records, no speculative typed IDs, and no author-protected retcons. " +
      "Existing Fact, Relationship, Character, World Entity, Arc, Milestone and Creative Direction records are strictly READ-ONLY, " +
      "including their Markdown prose. In particular, NEVER edit milestones/ files, their fulfillment clauses or their prose. " +
      "ASSIGNMENT.sourcePaths lists records to READ, not permission to edit. " +
      "ASSIGNMENT.authorContract.scope.targets are narrative goals, not writable file paths. " +
      "ASSIGNMENT.authorizedPaths is a directory ceiling, NOT blanket permission to modify existing records; " +
      "only assigned existing files of writable types may be edited. " +
      "If an Event payoff suggests changing Milestone fulfillment, record that need in laterObligations or " +
      "architecturalConflicts without touching the Milestone. " +
      "Do not revise or reword an existing objective Fact even to clarify it; " +
      "put clarification in Event prose or create a NEW connected Fact only if genuinely needed. " +
      "Existing Event prerequisites are immutable and must remain textually identical. " +
      "You may edit existing authorized Event, Choice Point, Revelation and Authored Content files, " +
      "and create connected new canonical records in your assigned directories. " +
      "Do not stage, reset, checkout or commit. Grep, rg and Git diff/status inspections are permitted. " +
      selected.guidance + "\n" +
      "Report any unavoidable architectural conflict without editing protected or out-of-domain canon. " +
      "A valid structure alone does not prove the reader actually sees the clue or that prose obeys choice branches. " +
      "Record conditional writing and later payoff obligations explicitly. " +
      "At the end output ONE unfenced JSON object with the exact cumulative Story-relative file inventory: " +
      '{"modifiedRecords":["events/example.md"],"architecturalConflicts":[],"laterObligations":["Review branch-specific prose before composition"]}. ' +
      "Call story_validate with no arguments after authoring, inspect Puzzle/Choice route coverage and protection, repair and revalidate before reporting. The graph independently checks all bytes, protection and progression.\nASSIGNMENT:\n" +
      JSON.stringify(assignment, null, 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + prompt : prompt);
      const last = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
        throw new Error("Interactive Pi turn failed: " +
          (last?.role === "assistant" ? last.stopReason + ": " + (last.errorMessage ?? "") : "no assistant response"));
      }
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      const calls = session.messages.flatMap(m => m.role === "assistant"
        ? m.content.filter(c => c.type === "toolCall") : []);
      const reads = calls.filter(c => c.name === "read" && completed.has(c.id) &&
        typeof c.arguments?.path === "string").map(c => resolve(project.root, c.arguments.path as string));
      if (pinned.some(p => !reads.includes(p))) throw new Error("Interactive specialist omitted pinned skill reads.");
      const edits = calls.filter(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
        typeof c.arguments?.path === "string").map(c =>
        relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"));
      if (!edits.some(p => p.startsWith(domain === "choice" ? "choice-points/" : "puzzles/"))) {
        throw new Error("Specialist did not author its owned canonical Choice Point/Puzzle record.");
      }
      const data = parseManifest(last.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      const evidence: InteractiveEvidence = { modifiedRecords: data.paths, conflicts: data.conflicts,
        obligations: data.obligations, skillReads: reads.filter(p => pinned.includes(p)),
        piSessionFile: session.sessionManager.getSessionFile() ?? undefined };
      const diagnostics = await verifyDraft(evidence);
      if (!diagnostics.length) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
      if (attempt === 2) throw new Error("Interactive specialist exhausted bounded repair attempts: " + diagnostics.join("; "));
      prompt = "The INDEPENDENT graph audit rejected your uncommitted work. " +
        "In this SAME Pi session, repair only the specific diagnostics below without touching " +
        "existing Event prerequisite gates or protected decisions. If a READ-ONLY file was edited, " +
        "restore precisely that file to the verified Git HEAD using read/edit/write tools, not git checkout/restore/reset; " +
        "retain your authorized changes. The sourcePaths inventory and scope.targets are READ-ONLY context/goals, " +
        "not edit permissions. Recheck every path with Git diff and provide the FULL cumulative modifiedRecords manifest " +
        "EXCLUDING restored files. " +
        "Do not claim a conditional or unverified path is proven. Diagnostics:\n" + diagnostics.join("\n");
    }
    throw new Error("Unexpected interactive repair loop termination.");
  } finally { session.dispose(); }
}
