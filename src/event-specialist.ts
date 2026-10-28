import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { agentValidatorBashTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

const REQUIRED = [
  "nt-event-design/SKILL.md",
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
] as const;

export interface EventAssignment {
  milestoneId: string;
  milestonePath: string;
  arcIds: string[];
  characterIds: string[];
  sourcePaths: string[];
  contract: CompletionContract;
  workItemId: string;
  authority: { existingProtectedChoices: "no-retcon"; delegatedChoices: "draft"; signingRequiredForProtectedChanges: true };
}
export interface EventEvidence {
  claimedPaths: string[];
  conflicts: string[];
  obligations: string[];
  sessionFile?: string;
  skillReads: string[];
}

function parseManifest(text: string): { modifiedRecords: string[]; architecturalConflicts: string[]; laterObligations: string[] } {
  const match = text.match(/\{\s*"modifiedRecords"\s*:\s*\[[^\]]*\][^{}]*\}/g)?.at(-1);
  let parsed: unknown;
  try { parsed = JSON.parse(match ?? "null"); } catch { /* reject below */ }
  const obj = parsed as Record<string, unknown> | null;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(x => typeof x === "string" && x.trim().length > 0);
  if (!obj || !strings(obj.modifiedRecords) || !obj.modifiedRecords.length ||
      !strings(obj.architecturalConflicts) || !strings(obj.laterObligations)) {
    throw new Error("Event specialist must return a JSON manifest with modifiedRecords, architecturalConflicts and laterObligations.");
  }
  return { modifiedRecords: obj.modifiedRecords, architecturalConflicts: obj.architecturalConflicts,
    laterObligations: obj.laterObligations };
}

export async function authorEventCluster(
  job: JobStartResult, snapshot: SkillSnapshot, assignment: EventAssignment,
  provider: string, modelId: string, onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: EventEvidence) => Promise<string[]>,
): Promise<EventEvidence> {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-event-design", "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Event skill discovery: " + diag.message);
  for (const name of ["nt-event-design", "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned Event skill " + name);
    }
  }
  const runtime = await ModelRuntime.create();
  const sessionDir = join(dirname(job.worktreeRoot), "event-sessions", assignment.workItemId);
  const context = await preparePiContext(job, project, {
    group: piNarrativeGroup("event", assignment.sourcePaths, assignment.milestoneId),
    step: "event:" + assignment.workItemId,
    paths: assignment.sourcePaths, snapshot: snapshot.id,
    provider, model: modelId, directory: sessionDir,
  }, runtime);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [await agentValidatorBashTool(job)],
    noTools: "all", tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi Event specialist did not honor pinned thinking effort.");
    }
    const file = session.sessionManager.getSessionFile();
    if (file) await onSession(file);
    const required = REQUIRED.map(name => join(snapshot.path, "skills", name));
    let prompt = "You are the pinned NovelTea nt-event-design specialist. Read ALL the following real skill instructions " +
      "and references with the read tool BEFORE editing:\n" + required.join("\n") +
      "\nRead the specified source files and follow their typed links only where necessary. " +
      "Work in this isolated canonical Story root. Implement exactly ONE bounded Milestone Event-design cluster, " +
      "with meaningful dramatic stakes, actions, actual causes, and typed consequences. " +
      "Event 'after' is optional chronology IF both Events occur; it does not require the earlier Event. " +
      "Actual enabling conditions belong in prerequisites.any_of, with nonempty alternatives containing completed and not_completed lists. " +
      "Explicitly model knowledge, truth, relationship and player revelation at the correct branch; do not infer them from prose. " +
      "If a new Revelation is required, create a correctly typed canonical revelation with an existing Fact; do not invent a Choice Point, Puzzle, engine Room or game state snapshot. " +
      "Fulfill the selected Milestone with reachable authored Event IDs, changing ONLY its fulfillment and completeness fields. " +
      "Do NOT edit any other Milestone, Creative Direction, unrelated Arc, or any Character baseline. " +
      "You may write events/*.md and strictly connected, authorized arcs/*.md, facts/*.md, revelations/*.md and relationships/*.md. " +
      "All records must contain valid schema '0.1' frontmatter with ONLY allowed fields and nonempty Markdown body prose. " +
      "Do not invent references; preserve user-protected author choices. New work remains draft, not author-approved. " +
      "Do not run git add, commit, checkout or reset. Git diff/status and grep inspection are permitted. " +
      "If the scope cannot be fulfilled without changing a protected or unrelated record, report an architectural conflict rather than editing it. " +
      "Any unresolved future alternative must be a concrete later obligation, not a fabricated Event ID. " +
      "REPORT an exact JSON object at the end (no markdown fences): " +
      '{"modifiedRecords":["events/example.md","milestones/example.md"],"architecturalConflicts":[],"laterObligations":["Future alternative requires Event design"]}. ' +
      "The modifiedRecords list MUST include every Story-relative file changed in this ENTIRE work item. " +
      "Run noveltea narrative validate . --json after authoring, inspect diagnostic and reachability evidence, repair and revalidate before reporting. Your own claims are not sufficient evidence; the graph independently checks changes, protection and acceptance.\n" +
      "AUTHORIZED ASSIGNMENT:\n" + JSON.stringify(assignment, null, 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + prompt : prompt);
      const last = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
        throw new Error("Event specialist Pi turn failed: " + (last?.role === "assistant"
          ? last.stopReason + ": " + (last.errorMessage ?? "") : "no assistant response"));
      }
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      const calls = session.messages.flatMap(m => m.role === "assistant"
        ? m.content.filter(c => c.type === "toolCall") : []);
      const reads = calls.filter(c => c.name === "read" && completed.has(c.id) &&
        typeof c.arguments?.path === "string").map(c => resolve(project.root, c.arguments.path as string));
      if (required.some(p => !reads.includes(p))) throw new Error("Event specialist did not read the required pinned skill references.");
      if (!calls.some(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
          typeof c.arguments?.path === "string" &&
          relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/").startsWith("events/"))) {
        throw new Error("Event specialist did not author canonical Event Markdown with an editing tool.");
      }
      const summary = parseManifest(last.content.filter(c => c.type === "text").map(c => c.text).join("\n"));
      const evidence: EventEvidence = { claimedPaths: summary.modifiedRecords,
        conflicts: summary.architecturalConflicts, obligations: summary.laterObligations,
        sessionFile: session.sessionManager.getSessionFile() ?? undefined,
        skillReads: reads.filter(p => required.includes(p as typeof required[number])) };
      const diagnostics = await verifyDraft(evidence);
      if (!diagnostics.length) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
      if (attempt === 2) throw new Error("Event specialist exhausted bounded repair attempts: " + JSON.stringify(diagnostics));
      prompt = "The independent canonical validator rejected your UNCOMMITTED Event cluster. " +
        "You may repair only files already within the authorized assignment. " +
        "Re-read nt-catalog progression as needed; check all Event prerequisites, branch state, and typed references. " +
        "Do not change protected author decisions, add speculative Event IDs, or stage files. " +
        "At the end return the COMPLETE modifiedRecords/architecturalConflicts/laterObligations manifest again. " +
        "Localized diagnostics:\n" + diagnostics.join("\n");
    }
    throw new Error("Unexpected Event repair termination.");
  } finally { session.dispose(); }
}
