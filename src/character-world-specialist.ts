import { createPiStatusTool } from "./pi-work-status.js";
import { mkdir } from "node:fs/promises";
import { parseSpecialistChoice, extractSpecialistChoice, authorChoiceDirection, type SpecialistChoiceQuestion,
  type SpecialistChoiceReceipt } from "./specialist-choice.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import { pinnedSkillReferences, type SkillSnapshot } from "./snapshot.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { creativePolicyInstruction, DEFAULT_CREATIVE_POLICY, type CreativePolicy } from "./creative-policy.js";

export type FoundationDomain = "world" | "character";
export interface FoundationAssignment {
  domain: FoundationDomain;
  arcIds: string[];
  milestoneIds: string[];
  sourcePaths: string[];
  scope: CompletionContract;
  authorTask?: string;
  creativePolicy?: CreativePolicy;
  decisionAuthority: {
    existingAuthorChoices: "protected-no-retcon";
    newSpecialistChoices: "agent-delegated";
    editorialApproval: "not-granted";
  };
}
export interface SpecialistChoiceProposal {
  authorQuestion: SpecialistChoiceQuestion;
  claimedPaths: string[];
  piSessionId: string;
  piSessionFile: string;
}
export interface SpecialistEvidence {
  claimedPaths: string[];
  piSessionFile?: string;
  piSessionId?: string;
  skillReads: string[];
  architecturalConflicts?: string[];
  laterObligations?: string[];
}
const CATALOG = [
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
  "nt-catalog/references/glossary.md",
];
export const CRITICAL_CAST_GUIDANCE = [
  "FIRST compare the selected Arc/Milestone and World Foundations against",
  "the cast. A named or clearly individuated person central to the inciting",
  "mystery (including an absent victim, missing witness, or inspector) may need",
  "a canonical Character record even if currently off-scene. Author that",
  "profile under this original creation grant when their identity/role matters",
  "to later Events, without inventing a culprit, outcome, appearance, or",
  "unearned initial knowledge. Do not create Characters for incidental",
  "references or force absent Characters into scenes. If a central figure",
  "must remain intentionally undefined, report its exact later-owner",
  "obligation rather than imply that two other leads cover it.",
].join(" ");

/** The controller requires one real, typed starting knowledge witness.
 * A wholly empty initial_knowledge array across the cast is not acceptable
 * when an existing, observable Fact is available. Do not invent future
 * discoveries or treat objective truth as automatic Character knowledge. */
export const CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE =
  "MANDATORY CHARACTER BASELINE: At least ONE in-scope canonical Character " +
  "MUST have a non-empty initial_knowledge YAML list referencing an EXISTING " +
  "Fact ID from the World foundations. Inspect the selected Fact record and " +
  "Character's actual starting circumstances. An already visible initial Fact " +
  "(for example, a visibly stranded train) may truly be KNOWN to an on-scene " +
  "Character. No one automatically knows an unobserved cause or culprit. " +
  "Use schema shape initial_knowledge:\n  - fact: fact.<EXACT-EXISTING-ID>\n    value: knows\n" +
  "(replace the placeholder with the original Fact's exact canonical ID). " +
  "NEVER leave every Character's initial_knowledge: [] and NEVER invent a " +
  "new Fact, Character, author approval or premature discovery to fill this gate. ";

export function characterInitialKnowledgeCorrection(factIds: readonly string[]): string {
  const known = [...new Set(factIds)].filter(id => /^fact\.[a-z][a-z0-9-]*$/.test(id)).slice(0, 12);
  if (!known.length) throw new Error("No canonical Fact IDs available for a safe Character knowledge correction.");
  return "CHARACTER_INITIAL_KNOWLEDGE_REPAIR: The current Character draft has " +
    "no explicit typed initial Fact-knowledge witness. Edit only the existing " +
    "authorized Character YAML, not the Fact, Milestone or protected Arc. " +
    "At least one Character must have initial_knowledge: [ {fact, value} ] " +
    "with a genuine starting relationship to a fact visible in the pinned " +
    "World sources. Exact current canonical Fact candidates: " +
    JSON.stringify(known) + ". Pick one that the Character plausibly KNOWS " +
    "at the start, and use a YAML list:\ninitial_knowledge:\n  - fact: " +
    known[0] + "\n    value: knows\n" +
    "This is an EXAMPLE shape, not permission to attribute unseen or contested " +
    "knowledge; read the actual Fact and Character first and choose accordingly. " +
    "Do not leave every initial_knowledge array empty. Run story_validate, " +
    "recheck protected choices and return the complete changedPaths manifest " +
    "in the SAME original Pi session without starting a second writer.";
}

const DOMAINS = {
  world: {
    name: "nt-worldbuilding",
    owns: ["world-entities/*.md", "facts/*.md"],
    guidance: "Establish or improve consequential persistent setting elements (world-entity) and objective initial Facts; reuse correct existing records instead of creating duplicates or rewriting unchanged types. This is not a glossary of the cast. People belong in Character records, never in world-entity records. A world-entity has exactly one type-specific field, description (quoted string); a fact has exactly one type-specific field, initial (unquoted boolean). NEVER put description on a fact. EVERY record MUST have substantial readable Markdown narrative prose AFTER its closing --- frontmatter line. Never use initial: false to mean undiscovered. Do not invent engine Rooms, speculative Events or future Narrative State snapshots.",
  },
  character: {
    name: "nt-character-development",
    owns: ["characters/*.md", "relationships/*.md", "arcs/*.md (characters array only)"],
    guidance: "Develop at least two distinct Characters with credible motivations and voices, a consequential initial Relationship and honest Fact knowledge baselines. " + CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE + " FIRST inspect the listed existing Character records and typed IDs. If a Character ID already exists, REUSE and develop its exact existing file; never create a second filename for the same canonical ID. A draft status does not make an existing character disposable. " + CRITICAL_CAST_GUIDANCE + " Use character records (type-specific fields motivation and at least one non-empty initial_knowledge in the assigned Character cluster) for people, relationship records (characters exactly two distinct IDs and initial) for the bond. Every record MUST have readable narrative prose after its closing --- frontmatter line. Existing Arc characters arrays may be extended only to link new Characters, without changing any other Arc text. Future/branch-specific discoveries are obligations for Events, not initial knowledge.",
  },
} as const;

/** A completed writer may omit its required output envelope. This is an
 * in-session reporting correction, never permission to replay the writer. */
export function foundationManifestCorrectionPrompt(): string {
  return "MANIFEST-ONLY CORRECTION in the SAME original Pi session: You authored " +
    "canonical files but did not return the required complete JSON manifest. " +
    "Do not edit or rerun the files. Report one unfenced JSON object containing " +
    "modifiedRecords (all changed Story-relative paths), architecturalConflicts " +
    "and laterObligations (both string arrays). Only name actual changes; the " +
    "controller independently checks the actual Git diff, native validation, " +
    "protected decisions and original writable scope. No new files, write grants " +
    "or Story decisions are authorized by this correction.";
}

/** Real Pi authoring: no commit, validation or authorization power is delegated to the specialist. */
export async function authorCharacterWorld(job: JobStartResult, snapshot: SkillSnapshot,
  assignment: FoundationAssignment, provider: string, modelId: string,
  onSession: (id: string, path: string) => Promise<void>,
  verifyDraft: (evidence: SpecialistEvidence) => Promise<string[]>,
  resume?: SpecialistChoiceReceipt): Promise<SpecialistEvidence | SpecialistChoiceProposal> {
  const selected = DOMAINS[assignment.domain];
  const required = [selected.name + "/SKILL.md", ...CATALOG];
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = { discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: [selected.name, "nt-catalog"] };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics) if (diag.type === "error") throw new Error("Foundation specialist skill discovery: " + diag.message);
  for (const name of [selected.name, "nt-catalog"]) {
    if (!skills.some(skill => skill.name === name && skill.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned specialist skill: " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const dir = join(job.stateDir, "character-world-sessions", assignment.domain);
  const context = await preparePiContext(job, project, {
    group: "foundations:" + assignment.domain, step: "foundations:" + assignment.domain,
    paths: assignment.sourcePaths, snapshot: snapshot.id, provider, model: modelId, directory: dir,
    task: { kind: "character", ids: assignment.milestoneIds, scope: "related" },
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
      throw new Error("Pi Character/World specialist did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Character/World Pi transcript cannot be persisted before authoring.");
    await onSession(session.sessionId, sessionFile);
    let prompt =
      `You are the NovelTea ${selected.name} specialist assigned ONE bounded canonical Story work item.\n` +
      "Read ALL the pinned guidance below using the read tool before writing. " +
      "These are exact stable skill:// references served by the verified immutable " +
      "snapshot; NEVER construct, copy or type long absolute snapshot hash paths:\n" +
      pinnedSkillReferences(snapshot, required.map(path => join(snapshot.path, "skills", path))) +
      "\nRead only the relevant existing Story sources named in the assignment (follow necessary typed references). " +
      "Never read/search .story-inbox/ideas, even with git grep/show, rg --hidden, find or broad scans; " +
      "it holds noncanonical, dormant author material reserved for a later placement specialist. " +
      "Do not modify files outside your ownership; never write Creative Direction, Milestones, Events, or engine files. " +
      "Preserve author-protected decisions and existing authorized choices; do not treat draft status as permission to retcon. " +
      "Write canonical schema '0.1' Markdown, with quoted YAML prose scalars, draft status and honest completeness. " +
      "For existing Stories, preserve valid existing Facts, World Entities, Characters and Relationships. " +
      "Change only records that need work; a category does not need an edit merely because it is part of final acceptance. " +
      "Where future conditional truth, discoveries or Relationship transitions depend on a branch, describe the pending Event obligation in prose rather than making false initial state claims. " +
      "Never invent typed Event IDs to fill deferred Milestone fulfillment. " +
      (sandboxTools ?
        "Shell and file searches run only in networkless /story; Git, host paths and credentials are unavailable. Use story_validate for native checks. " :
        "Do not run git add, commit, reset or checkout. Inspections with grep/rg/git diff/status are permitted. ") +
      selected.guidance + "\nAUTHORIZED WRITABLE PATHS: " + selected.owns.join(", ") +
      "\nBOUND ASSIGNMENT: " + JSON.stringify(assignment, null, 2) +
      specialistAuthorInstruction(assignment.authorTask) +
      creativePolicyInstruction(assignment.creativePolicy ?? DEFAULT_CREATIVE_POLICY) +
      "\nAsk the author only when their input would materially improve a consequential ambiguity under the current Creative mode. Routine artistic judgment, validation mistakes, duplicate IDs, syntax, and missing references should not force a choice. Never use an ordinary question to authorize protected or irreversible canonical changes. " +
      "To request a decision, end with JSON containing authorDecisionRequest: {kind:'free-text',question,placeholder?}, {kind:'yes-no',question,recommendedId?:'yes|no',recommendationReason?}, {kind:'alternatives',question,options:[2–4 {id,title,description?}],recommendedId?,recommendationReason?}, or {kind:'multiple-choice',question,options:[2–4 {id,title,description?}]}, plus modifiedRecords listing all already modified files or []. Optional option benefits/tradeoffs and source context {path,line,description} are accepted. For routine creative decisions you may request allowStudioDecision:true; this is not permission, and the trusted controller independently decides whether author delegation is offered. Other/custom answers are always allowed. Never use a question or delegation to modify protected decisions or broaden your assignment. " +
      "\nAt the END of a completed task, provide a JSON object on its own line with the exact Story-relative paths you changed: " +
      '`{"modifiedRecords":["characters/example.md"],"architecturalConflicts":[],"laterObligations":["Bind the disclosure to an Event"]}` (replace example with reality). ' +
      "Report any blocked architectural conflict in architecturalConflicts and all deferred Event/branch dependencies in laterObligations. " +
      "A truthful, exactly clean no-write with a named original-plan/owner contradiction is valid negative evidence for controller Repair; do not invent files just to return a nonempty modifiedRecords list. " +
      "List ALL paths changed since the beginning of this work item, not just the latest edits. " +
      "Call story_validate with no arguments, inspect diagnostics and coverage, repair and revalidate before reporting. " +
      "The graph will check this claim against the actual Git diff; your self-report is not acceptance evidence.";
    // Do not start a second writer or discard its work. The SAME Pi session can
    // receive bounded, source-located validator feedback before commit.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      const direction = resume?.answer
        ? "AUTHENTICATED AUTHOR ANSWER: " + authorChoiceDirection(resume.question, resume.answer, resume.delegationAllowed === true)
        : null;
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote +
        (direction ? direction + "\nContinue this same Pi session, inspect the current files, and carry out this choice without modifying protected decisions.\n" : "") + prompt : prompt);
      const assistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!assistant || assistant.role !== "assistant" || ["error", "aborted"].includes(assistant.stopReason)) {
        const detail = assistant?.role === "assistant"
          ? `stopReason=${assistant.stopReason}; error=${assistant.errorMessage ?? "none"}`
          : "no assistant turn";
        throw new Error("Foundation specialist did not finish a successful Pi turn (" + detail + ").");
      }
      const pinned = required.map(p => join(snapshot.path, "skills", p));
      const skillReads = await requirePinnedSkillReads(session, project.root, pinned, "Foundation specialist");
      const finalAssistant = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!finalAssistant || finalAssistant.role !== "assistant") throw new Error("Foundation specialist reply is missing.");
      const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
        m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
      const calls = session.messages.flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "toolCall") : []);

      const text = finalAssistant.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const choice = extractSpecialistChoice(text);
      if (choice) {
        const question = parseSpecialistChoice(choice.authorDecisionRequest);
        const files = choice.modifiedRecords ?? [];
        if (!Array.isArray(files) || !files.every(p => typeof p === "string"))
          throw Error("Author question must enumerate the existing changed Story paths.");
        // A question is a completed Pi turn. Record its usage BEFORE pausing,
        // so a budget increase can be requested without consuming the
        // subsequent one-time writer retry.
        await context.completed(sessionFile, session.sessionId);
        return { authorQuestion: question, claimedPaths: files as string[],
          piSessionId: session.sessionId, piSessionFile: sessionFile };
      }
      const edits = calls.filter(c => ["write", "edit"].includes(c.name) && completed.has(c.id) &&
        typeof c.arguments?.path === "string").map(c => relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"));
      const noEdits = edits.length === 0;
      const match = text.match(/\{\s*"modifiedRecords"\s*:\s*\[[^\]]*\][^{}]*\}/g)?.at(-1);
      let declared: unknown;
      try { declared = JSON.parse(match ?? "null"); } catch { /* reject below */ }
      const paths = (declared as { modifiedRecords?: unknown })?.modifiedRecords;
      if (!Array.isArray(paths) || !paths.every(p => typeof p === "string")) {
        if (attempt === 2) throw new Error("Foundation specialist did not provide a valid modifiedRecords manifest.");
        prompt = foundationManifestCorrectionPrompt();
        continue;
      }
      const messages = declared as { architecturalConflicts?: unknown; laterObligations?: unknown };
      const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string" && x.trim());
      if (!strings(messages.architecturalConflicts) || !strings(messages.laterObligations)) {
        if (attempt === 2) throw new Error("Specialist must explicitly report architectural conflicts and downstream obligations.");
        prompt = foundationManifestCorrectionPrompt();
        continue;
      }
      if (noEdits && (paths.length !== 0 || !(messages.architecturalConflicts as string[]).length)) {
        // Missing methodology reads or misunderstood directory ownership can
        // still be repaired in the SAME context; a genuine, settled no-write
        // architectural contradiction is not a writer/protocol failure.
        if (attempt === 2) throw new Error("Foundation specialist produced no edits or authenticated architectural contradiction.");
        prompt = "No canonical files were authored. Check the pinned skill:// references " +
          "and remember absent Story record directories can be CREATED within your " +
          "original lease. If the assignment is feasible, author its required " +
          "canonical files and return the complete manifest. If an exact earlier " +
          "Architecture/owner contradiction prevents this, return modifiedRecords: [] " +
          "with specific architecturalConflicts and laterObligations. Do NOT invent " +
          "a workaround or request permission to change protected scope.";
        continue;
      }
      const evidence: SpecialistEvidence = { claimedPaths: paths, skillReads,
        architecturalConflicts: messages.architecturalConflicts as string[],
        laterObligations: messages.laterObligations as string[],
        piSessionFile: session.sessionManager.getSessionFile() ?? undefined };
      const diagnostics = await verifyDraft(evidence);
      if (diagnostics.length === 0) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
      if (attempt === 2) {
        throw new Error("Specialist failed canonical validation after two bounded repair attempts: " + JSON.stringify(diagnostics));
      }
      prompt = "The independent canonical validator rejected your UNCOMMITTED Story draft. " +
        "Stay within the exact original authorized scope; repair these file/line diagnostics in your existing files. " +
        "Read the relevant pinned catalog references again if necessary. Do not stage or commit. " +
        "Do not change or weaken protected decisions, or fill unknown future routes with fictitious Events. " +
        "After fixing, repeat the COMPLETE modifiedRecords/architecturalConflicts/laterObligations JSON manifest. " +
        "Diagnostics:\n" + diagnostics.join("\n");
    }
    throw new Error("Specialist repair loop terminated unexpectedly.");
  } finally { session.dispose(); }
}
