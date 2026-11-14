import { boundedPinnedSources, renderBoundedPrompt } from "./bounded-specialist-prompt.js";
import { createPiStatusTool } from "./pi-work-status.js";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { parseSpecialistChoice, extractSpecialistChoice, authorChoiceDirection,
  type SpecialistChoiceQuestion, type SpecialistChoiceReceipt } from "./specialist-choice.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { lastSpecialistManifest, requireSpecialistManifest } from "./specialist-manifest.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";

const REQUIRED = boundedPinnedSources("nt-event-design");

/** Cheap, read-only early diagnosis for half-written model records. Native
 * validation remains authoritative for YAML schema, references and reachability.
 * This never repairs bytes or certifies a record as valid. */
export function canonicalFrontmatterStructureError(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return "The first line must be exactly --- (YAML frontmatter opening).";
  const close = lines.findIndex((line, i) => i > 0 && line === "---");
  if (close < 2) return "The file is missing its closing --- delimiter after YAML frontmatter.";
  if (!lines.slice(close + 1).join("\n").trim())
    return "The file has no narrative Markdown body after the closing --- delimiter.";
  return null;
}

export interface EventAssignment {
  milestoneId: string;
  milestonePath: string;
  arcIds: string[];
  characterIds: string[];
  sourcePaths: string[];
  contract: CompletionContract;
  workItemId: string;
  authorTask?: string;
  authority: { existingProtectedChoices: "no-retcon"; delegatedChoices: "draft"; signingRequiredForProtectedChanges: true };
}
export interface EventEvidence {
  claimedPaths: string[];
  conflicts: string[];
  obligations: string[];
  sessionFile?: string;
  piSessionId?: string;
  authorQuestion?: SpecialistChoiceQuestion;
  skillReads: string[];
}

export function parseEventManifest(text: string): { modifiedRecords: string[]; architecturalConflicts: string[]; laterObligations: string[] } {
  const obj = lastSpecialistManifest(text);
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(x => typeof x === "string" && x.trim().length > 0);
  if (!obj || !strings(obj.modifiedRecords) ||
      !strings(obj.architecturalConflicts) || !strings(obj.laterObligations) ||
      (!obj.modifiedRecords.length && !obj.architecturalConflicts.length &&
        !obj.laterObligations.length)) {
    throw new Error("Event specialist must return a JSON manifest with modifiedRecords, architecturalConflicts and laterObligations.");
  }
  return { modifiedRecords: obj.modifiedRecords, architecturalConflicts: obj.architecturalConflicts,
    laterObligations: obj.laterObligations };
}

/** Pure production prompt for fixture comparison and controller-contract tests. */
export function eventSpecialistPrompt(
  snapshot: SkillSnapshot,
  assignment: EventAssignment,
  sandboxed: boolean,
): string {
  return renderBoundedPrompt(snapshot, {
    goal:
      "Author exactly ONE Event-design cluster for the assigned Milestone and its authored " +
      "Arc and Character context. Author a reachable in-scene setup grounded in those sources; " +
      "do not assert unshown past evidence, unearned typed effects or completed player decisions.",
    sources: REQUIRED,
    sourceUse:
      "Read the selected Milestone/Arc, connected Characters/Facts and reachable earlier " +
      "Events, IF any already exist. An empty events/ directory is a normal first " +
      "Milestone, not a missing dependency or a reason to ask permission: " +
      "YOU own authoring its discovery scene within this exact Event grant. " +
      "Follow only relevant typed links. 'after' orders Events if both occur; actual " +
      "enabling conditions use prerequisites.any_of.",
    writableScope:
      "Only events/*.md and causally connected authorized arcs/*.md, new facts/*.md, " +
      "revelations/*.md or relationships/*.md. The selected milestones/*.md may change ONLY its " +
      "fulfillment/completeness fields. All other Milestones, Creative Direction, Character " +
      "baselines and protected choices are read-only; sourcePaths do not grant writes. " +
      (sandboxed
        ? "The networkless /story sandbox cannot use host Git, paths or credentials."
        : "Do not stage, commit, reset or checkout; Git diff/status inspection is permitted."),
    doneWhen:
      "The canonical schema 0.1 Event files have complete YAML frontmatter and " +
      "substantive Markdown. If this is the first Event or a discovery Milestone, " +
      "author the discovery and Character access NOW with justified in-scene " +
      "knowledge effects, rather than asking who should author the discovery. " +
      "The Story does not require a pre-existing discovery Event to start. " +
      "A new in-scene observation or explicitly sourced testimony " +
      "may establish evidence without a pre-existing Fact or earlier Event; do not invent " +
      "off-screen history or promote uncertain claims to truth. Show evidence before " +
      "justified inferences/effects. " +
      "A nondecision Event needs no artificial typed effect. If the authored Milestone requires " +
      "an enacted player decision, produce a reachable setup, preserve partial Milestone " +
      "completeness with empty fulfillment.any_of, and leave formal outcome binding for Choice. " +
      "A setup Event is complete unless its own text claims the decision enacted. " +
      "Before setting a Milestone complete, compare EACH material clause of its " +
      "selected change/outcome and narrative promise with the player's actually " +
      "reachable observations, testimony and access in this Event. An observation " +
      "of an empty or locked place NOW does not prove it was continuously locked " +
      "or inaccessible EARLIER; neither a witness claim nor a possible discrepancy " +
      "alone proves that all the Milestone's evidence has been established. " +
      "When an essential clause is not yet established, retain partial " +
      "completeness and empty fulfillment.any_of, and name the exact missing " +
      "support as a later obligation; do NOT make a false completed route. " +
      "For a completed nondecision Milestone, bind only genuinely fulfilled routes. " +
      "Call story_validate without arguments, repair introduced errors and revalidate; " +
      "independent controller checks remain authoritative.",
    laterObligations:
      "Include a concrete laterObligations entry naming formal Choice binding, " +
      "missing outcome effects and later consumers; defer Puzzle and final prose. Missing Choice, Puzzle, " +
      "clue, or composed scene records are NOT blockers for this Event setup; write the " +
      "bounded Event now rather than requesting those later units first. Never invent " +
      "a Choice Point ID or unrelated effects to claim completion. For truly impossible out-of-scope or " +
      "protected prerequisites, make NO edits and return concrete conflicts/obligations; " +
      "only the controller may authorize changed scope.",
    requiredOutput:
      "Return one unfenced JSON object with cumulative Story-relative " +
      "modifiedRecords, architecturalConflicts and laterObligations arrays. Include all " +
      "changed records. An optional authorDecisionRequest for consequential ambiguity " +
      "MUST use field kind, never type, with value free-text, yes-no or " +
      "alternatives. Free-text needs only question; yes-no needs question; " +
      "alternatives require " +
      "(question, 2–4 options and recommendation); structured choices include Other. " +
      "Do not request author permission for a discovery Event already in this " +
      "authorized work item. No choice authorizes protected changes. " +
      "No-write prerequisite reports have modifiedRecords:[] " +
      "and must precede any edit. The graph verifies source, manifests, authority and validation.",
    assignmentLabel: "AUTHORIZED ASSIGNMENT",
    assignment,
    authorInstruction: specialistAuthorInstruction(assignment.authorTask),
  });
}

/** A malformed author question is never permission to replay the writer or
 * ask the author to approve work already owned by this Event assignment. */
export function eventQuestionCorrectionFeedback(error: unknown): string {
  return "CONTROLLER-REJECTED AUTHOR QUESTION: " + String(error) + ". " +
    "An empty events/ directory is normal. If this Milestone requires " +
    "the discovery, YOU are the Event writer authorized to create its " +
    "reachable, source-grounded discovery scene under the SAME Event " +
    "record grant. Do not ask for another Event writer or a separate " +
    "approval to author the discovery. Show who discovers what and when, " +
    "with only justified in-scene Character knowledge effects. " +
    "Keep protected and other-owner records unchanged. If a genuine " +
    "consequential question remains outside your grant, use EXACT " +
    "authorDecisionRequest field kind (never type), with value " +
    "free-text, yes-no, or alternatives and the supported option fields. " +
    "Otherwise author the Event, run story_validate, and return the " +
    "complete cumulative modifiedRecords, architecturalConflicts and " +
    "laterObligations JSON arrays. This is one bounded correction in " +
    "the SAME Pi session, not a writer replay or new authority.";
}

export async function authorEventCluster(
  job: JobStartResult, snapshot: SkillSnapshot, assignment: EventAssignment,
  provider: string, modelId: string, onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: EventEvidence) => Promise<string[]>,
  resume?: SpecialistChoiceReceipt, reroutedFrom?: string,
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
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "event-sessions", assignment.workItemId,
    ...(reroutedFrom ? ["rerouted-" + reroutedFrom] : []));
  const context = await preparePiContext(job, project, {
    // A fresh bounded reassignment must not fork the no-write author's settled Pi session.
    group: piNarrativeGroup("event", assignment.sourcePaths, assignment.milestoneId) +
      (reroutedFrom ? ":rerouted-" + reroutedFrom : ""),
    step: "event:" + assignment.workItemId + (reroutedFrom ? ":rerouted-" + reroutedFrom : ""),
    paths: assignment.sourcePaths, snapshot: snapshot.id,
    task: { kind: "event", ids: [assignment.milestoneId], scope: "related" },
    provider, model: modelId, directory: sessionDir,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: resume
      ? SessionManager.open(resume.sessionFile, dirname(resume.sessionFile), project.root)
      : context.manager,
    customTools: [...(sandboxTools ?? []), createStoryValidateTool(job), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: [...SANDBOX_TOOLS, "story_context", "story_validate", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi Event specialist did not honor pinned thinking effort.");
    }
    const file = session.sessionManager.getSessionFile();
    if (file) await onSession(file);
    const required = REQUIRED.map(name => join(snapshot.path, "skills", name));
    let prompt = eventSpecialistPrompt(snapshot, assignment, Boolean(sandboxTools));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      const direction = resume?.answer
        ? "AUTHENTICATED AUTHOR ANSWER: " + authorChoiceDirection(resume.question, resume.answer) +
          "\nContinue in this exact session without changing protected decisions.\n" : "";
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + direction + prompt : prompt);
      const last = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
        throw new Error("Event specialist Pi turn failed: " + (last?.role === "assistant"
          ? last.stopReason + ": " + (last.errorMessage ?? "") : "no assistant response"));
      }
      const skillReads = await requirePinnedSkillReads(session, project.root, required, "Event specialist");
      const finalAssistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!finalAssistant || finalAssistant.role !== "assistant") throw new Error("Event specialist reply is missing.");
      const text = finalAssistant.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const proposed = extractSpecialistChoice(text);
      if (proposed) {
        let question: SpecialistChoiceQuestion;
        try {
          question = parseSpecialistChoice(proposed.authorDecisionRequest);
        } catch (error) {
          if (attempt === 2) throw error;
          // #158: A new Story can have no existing Event. A malformed model
          // question never creates a new grant or a synthetic author answer.
          // Correct it in the original bounded specialist session.
          prompt = eventQuestionCorrectionFeedback(error);
          continue;
        }
        if (!Array.isArray(proposed.modifiedRecords) ||
            !proposed.modifiedRecords.every(p => typeof p === "string"))
          throw Error("Event author question lacks an exact modifiedRecords manifest.");
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return { claimedPaths: proposed.modifiedRecords as string[], conflicts: [], obligations: [],
          skillReads, sessionFile: session.sessionManager.getSessionFile() ?? undefined,
          piSessionId: session.sessionId, authorQuestion: question };
      }
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      const calls = session.messages.flatMap(m => m.role === "assistant"
        ? m.content.filter(c => c.type === "toolCall") : []);

      const summary = await requireSpecialistManifest(session, parseEventManifest, "Event");
      if (!summary.modifiedRecords.length) {
        // Only a genuinely no-write, settled model turn may report missing
        // prerequisites. A modified/reverted or interrupted writer has no
        // authority to claim a clean plan-reconciliation boundary.
        if (resume || calls.some(c => ["write", "edit"].includes(c.name)))
          throw new Error("Event no-write prerequisite report follows a writer tool or author-choice resume.");
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return { claimedPaths: [], conflicts: summary.architecturalConflicts,
          obligations: summary.laterObligations,
          skillReads, sessionFile: session.sessionManager.getSessionFile() ?? undefined,
          piSessionId: session.sessionId };
      }
      if (!calls.some(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
          typeof c.arguments?.path === "string" &&
          relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/").startsWith("events/"))) {
        throw new Error("Event specialist did not author canonical Event Markdown with an editing tool.");
      }
      const structural: string[] = [];
      for (const path of summary.modifiedRecords) {
        if (!/^(?:events|facts|revelations|relationships|arcs|milestones)\/[a-z][a-z0-9-]*\.md$/.test(path))
          continue; // The controller's exact scope/diff validator owns invalid paths.
        const full = join(job.worktreeStoryRoot, path);
        try {
          const info = await lstat(full);
          if (!info.isFile() || info.isSymbolicLink() || await realpath(full) !== full)
            throw new Error("Unsafe or redirected record path");
          const issue = canonicalFrontmatterStructureError(await readFile(full, "utf8"));
          if (issue) structural.push(path + ": " + issue);
        } catch {
          structural.push(path + ": Missing or unsafe canonical record file.");
        }
      }
      if (structural.length) {
        if (attempt === 2)
          throw new Error("Event specialist left structurally incomplete Markdown after bounded repairs: " +
            structural.join("; "));
        prompt = "The files you just wrote have an OBJECTIVE source formatting error, " +
          "NOT an architectural conflict or native-validator bug. You may edit " +
          "only your already authorized paths, in this SAME session. Read the " +
          "complete files and repair each one: every canonical .md record must " +
          "start with a standalone --- line, close the YAML with a SECOND " +
          "standalone --- line, and contain substantive narrative Markdown " +
          "AFTER that closing line. A single opening --- is insufficient. " +
          "Then run story_validate and return the complete cumulative JSON " +
          "manifest; remove any false architectural-conflict claim caused only " +
          "by these truncated files. EXACT ERRORS:\n" + structural.join("\n");
        continue;
      }
      const evidence: EventEvidence = { claimedPaths: summary.modifiedRecords,
        conflicts: summary.architecturalConflicts, obligations: summary.laterObligations,
        sessionFile: session.sessionManager.getSessionFile() ?? undefined,
        skillReads };
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
