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

/** An Event owns its own in-scene evidence. A model's claim that its draft
 * lacks source-grounded access/timing/testimony is repair feedback, not a new
 * specialist grant. Only a concrete deficit in the assigned Milestone's
 * existing material evidence may be corrected here; anything demanding new
 * upstream canon, a protected change or a different owner remains blocked.
 * The native path/protection verifier still owns every actual edit. */
export function scopedEventEvidenceConflict(
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  conflicts: readonly string[],
): boolean {
  return conflicts.length > 0 && conflicts.length <= 3 && conflicts.every(text =>
    text.includes(assignment.milestoneId) &&
    /\b(?:validator|milestone|fulfillment|reachable)\b/i.test(text) &&
    /\b(?:does not establish|lacks?|missing|not yet established|insufficient)\b/i.test(text) &&
    /\b(?:evidence|observation|testimony|witness|access|time|interval|material clause|support|route)\b/i.test(text) &&
    !/\b(?:protected|retcon|approval|consent|unrelated|out.of.scope|outside.scope|upstream|prior event|previous event|cannot (?:author|create)|need (?:an? )?(?:new|another|second) (?:fact|character|arc|milestone|event)|(?:new|another|second) (?:fact|character|arc|milestone|event) (?:is )?(?:required|needed))\b/i.test(text),
  );
}

/** One bounded correction in the original authenticated Pi session. It does
 * not waive Event completion, create a new grant or automatically trust the
 * model's assertion that the requirement has been met. */
export function eventEvidenceRepairFeedback(
  assignment: Pick<EventAssignment, "milestoneId" | "milestonePath">,
  conflicts: readonly string[],
): string {
  if (!scopedEventEvidenceConflict(assignment, conflicts))
    throw new Error("An out-of-scope Event conflict cannot be routed as local evidence.");
  return "EVENT_LOCAL_EVIDENCE: The CURRENT authored Event is missing a material clause " +
    "of the selected Milestone " + assignment.milestoneId + " in " + assignment.milestonePath + ". " +
    "This is evidence the CURRENT Event specialist can gather within the SAME authorized " +
    "Event and existing-character context; it is not automatically a prerequisite for a new writer. " +
    "Re-read the Milestone's exact change and narrative promise, then revise the existing " +
    "Event (or author another causally connected Event under its already granted events/ scope) " +
    "so the player actually observes the relevant access, timing, space or source limitations, " +
    "or hears a named, existing participant provide firsthand, uncertainty-qualified testimony " +
    "IN this Event. Specify which spaces and people the witness observed as accessible, " +
    "and which access facts remain unknown. A reported past sighting is testimony, NOT objective " +
    "truth or proof of continuous enclosure; do not invent an authoritative offscreen investigation, " +
    "time record, new Character, protected change, or unsupported certainty. " +
    "Only then bind a reachable fulfillment route for a nondecision Milestone; never " +
    "invent fulfillment IDs, steps or effects merely to pass validation. " +
    "If the Milestone actually requires a player decision, keep that Milestone partial " +
    "and hand off only the formally unbound Choice. " +
    "Re-run story_validate and report EXACT cumulative modifiedRecords, " +
    "architecturalConflicts and laterObligations. If source-grounded evidence truly cannot " +
    "be authored within the original grant, report the concrete blocker; the controller " +
    "must remain blocked, not infer proof or waive the review. " +
    "SOURCE DEFICITS: " + JSON.stringify(conflicts).slice(0, 1800);
}

/** Exactly one extra turn is permitted ONLY for a controller-identified,
 * source-local evidence gap after the usual three attempts. No other error
 * category gains a retry and a fourth failure is always terminal. */
export function eventEvidenceRetryAllowed(attempt: number, diagnostics: readonly string[]): boolean {
  return Number.isInteger(attempt) && (attempt === 0 || attempt === 1 ||
    attempt === 2 && diagnostics.length > 0 &&
    diagnostics.every(message => message.startsWith("EVENT_LOCAL_EVIDENCE:")));
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
      "Every named speaking witness or central actor present in the scene must be an " +
      "existing canonical Character listed in this Event's typed participants. " +
      "Use the existing cast; if a missing Character is genuinely essential, " +
      "report that dependency before any edits rather than creating the Character " +
      "or beginning an incomplete Event. " +
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
      "For a promised contradiction, test the claims against an independent observation " +
      "the player can inspect: an undated physical trace cannot establish the disputed timing. " +
      "For a nondecision Milestone, THIS Event assignment owns delivering each " +
      "material evidence clause in a reachable in-scene observation or identified, " +
      "uncertainty-qualified testimony, including which relevant spaces or people " +
      "were accessible if the selected Milestone asks for access evidence. " +
      "Do not substitute present absence for past access proof; a genuine limited " +
      "witness account can establish what that witness observed without claiming " +
      "omniscient certainty. If one observation is insufficient, revise this Event " +
      "or author a causally linked second Event within the existing writable scope. " +
      "Do not merely leave a nondecision Milestone partial and delegate its missing " +
      "material evidence to an unspecified later Event; a complete nondecision " +
      "Milestone requires genuine reachable fulfillment NOW. " +
      "Partial completeness and empty fulfillment.any_of are appropriate for an " +
      "unbound later formal Choice or a genuinely impossible out-of-scope requirement, " +
      "but a reported conflict is NOT a successful Event. Do not fabricate a " +
      "completed route or change protected canon to pass this gate. " +
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
      "No-write prerequisite reports have modifiedRecords:[] and must precede " +
      "any edit. An authored Event with an in-scope evidence gap needs a bounded " +
      "same-session correction, not an invented downstream owner. The graph verifies " +
      "source, manifests, authority and validation.",
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
    // The normal budget is three bounded turns. A final local-evidence
    // diagnostic may earn ONE additional correction turn, under the SAME
    // assignment and original Pi session. This is not writer replay or an
    // automatic grant for an upstream/protected dependency.
    let extraEvidenceCorrection = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 3 && !extraEvidenceCorrection)
        throw new Error("Event specialist correction exceeded its original bounded budget.");
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
        if (attempt >= 2)
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
      const localEvidence = diagnostics.length > 0 &&
        diagnostics.every(message => message.startsWith("EVENT_LOCAL_EVIDENCE:"));
      if (!eventEvidenceRetryAllowed(attempt, diagnostics))
        throw new Error("Event specialist exhausted bounded repair attempts: " + JSON.stringify(diagnostics));
      if (attempt === 2) extraEvidenceCorrection = true;
      prompt = localEvidence
        ? "IN-SCOPE EVENT EVIDENCE CORRECTION ONLY. Keep the original " +
          "Milestone, approved cast, protected facts and event-scope permissions. " +
          "Do not convert this evidence deficit into an upstream approval request, " +
          "nor claim partial fulfillment is a pass for a nondecision Milestone. " +
          "Read the selected source and revise only the already-authorized Event " +
          "cluster in this SAME Pi session. After editing, run story_validate and " +
          "return a complete cumulative manifest. Exact controller findings:\n" +
          diagnostics.join("\n")
        : "The independent canonical validator rejected your UNCOMMITTED Event cluster. " +
          "You may repair only files already within the authorized assignment. " +
          "Re-read nt-catalog progression as needed; check all Event prerequisites, branch state, and typed references. " +
          "Do not change protected author decisions, add speculative Event IDs, or stage files. " +
          "At the end return the COMPLETE modifiedRecords/architecturalConflicts/laterObligations manifest again. " +
          "Localized diagnostics:\n" + diagnostics.join("\n");
    }
    throw new Error("Unexpected Event repair termination.");
  } finally { session.dispose(); }
}
