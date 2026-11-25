import { createPiStatusTool } from "./pi-work-status.js";
import { mkdir } from "node:fs/promises";
import { parseSpecialistChoice, extractSpecialistChoice, authorChoiceDirection, type SpecialistChoiceQuestion,
  type SpecialistChoiceReceipt } from "./specialist-choice.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract } from "./architecture.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import { executeAssignmentRound, AssignmentAuthorPauseError, type AssignmentRoundCommand, type AssignmentRoundResult, type AssignmentDefect, type AssignmentInvocationProof } from "./assignment-metadata-recovery.js";
import { parseWriterDependencyFinding } from "./dependency-amendments.js";
import { lastSpecialistManifest } from "./specialist-manifest.js";
import { readJobControl } from "./job-control.js";
import { StoryCancelledError } from "./story-interruption.js";
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
  dependencyObligations?: string[];
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
  dependencyFinding?: import("./dependency-amendments.js").WriterDependencyFinding;
  laterObligations?: string[];
  invocationProof?: AssignmentInvocationProof;
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
  verifyDraft: (evidence: SpecialistEvidence) => Promise<readonly AssignmentDefect[]>,
  invocation: {
    sourceDigest: string;
    directory: (sessionId: string) => string;
    authorize: () => Promise<void>;
    effect: () => Promise<string>;
    savedSession?: { id: string; file: string };
    continuation?: import("./writer-dependency.js").WriterContinuation;
  },
  resume: SpecialistChoiceReceipt | undefined, round: AssignmentRoundCommand): Promise<SpecialistEvidence | SpecialistChoiceProposal | { round: AssignmentRoundResult }> {
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
    paths: assignment.sourcePaths, snapshot: snapshot.id, provider, model: modelId, directory: dir, insideWriter: true,
    task: { kind: "character", ids: assignment.milestoneIds, scope: "related" },
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: invocation.savedSession
      ? SessionManager.open(invocation.savedSession.file, dirname(invocation.savedSession.file), project.root)
      : resume ? SessionManager.open(resume.sessionFile, dirname(resume.sessionFile), project.root)
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
    if (invocation.savedSession && invocation.savedSession.id !== session.sessionId)
      throw Error("World/Character recovery opened a foreign Pi session.");
    await onSession(session.sessionId, sessionFile);
    const prompt =
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
      (assignment.domain === "character" && assignment.dependencyObligations ?
        "If a necessary existing World Fact or World Entity in your sourcePaths blocks your authorized work, return a clean no-write manifest with architecturalConflicts and dependencyFinding: " +
        JSON.stringify({ obligationIndex: 1, targetId: "fact.example", missing: "exact required correction", affectedIds: ["fact.example"],
          sources: [{ path: "facts/example.md", quote: "exact source quote" }], likelySpecialist: "nt-worldbuilding", authorDecisionRequired: false }) +
        ". Select the original obligation by index from dependencyObligations. Never grant yourself a World or Architecture edit. " : "") +
      "List ALL paths changed since the beginning of this work item, not just the latest edits. " +
      "Call story_validate with no arguments, inspect diagnostics and coverage, repair and revalidate before reporting. " +
      "The graph will check this claim against the actual Git diff; your self-report is not acceptance evidence.";
    const direction = resume?.answer
      ? "AUTHENTICATED AUTHOR ANSWER: " + authorChoiceDirection(resume.question, resume.answer, resume.delegationAllowed === true)
      : null;
    const readSkills = () => {
      const reads = completedPinnedSkillReads(session.messages, project.root, snapshot.path);
      const paths = required.map(p => join(snapshot.path, "skills", p));
      if (paths.some(path => !reads.includes(path)))
        throw Error("Original foundation invocation did not read the pinned methodology.");
      return paths;
    };
    const toEvidence = (manifest: Record<string, unknown>, skillReads: string[]): SpecialistEvidence => ({
      claimedPaths: manifest.modifiedRecords as string[], skillReads,
      architecturalConflicts: manifest.architecturalConflicts as string[],
      laterObligations: manifest.laterObligations as string[],
      ...(manifest.dependencyFinding !== undefined ? { dependencyFinding: parseWriterDependencyFinding(manifest.dependencyFinding) } : {}),
      piSessionId: session.sessionId, piSessionFile: sessionFile,
    });
    const result = await executeAssignmentRound({
      session, directory: invocation.directory(session.sessionId),
      sourceDigest: invocation.sourceDigest, sessionRoots: [dir],
      responseKind: "manifest-or-choice",
      initialTranscriptSha256: resume?.sessionSha256 ?? invocation.continuation?.sessionSha256,
      authorize: invocation.authorize, effect: invocation.effect,
      initialPrompt: context.contextNote +
        (invocation.continuation ? "\nAUTHENTICATED VERIFIED PREREQUISITE " + invocation.continuation.reportDigest +
          ": The controller independently verified the World correction. Re-read the current source and continue YOUR original Character assignment in this same session; do not repeat the previous no-write report.\n" : "") +
        (direction ? direction + "\nContinue this same Pi session and carry out this choice without modifying protected decisions.\n" : "") + prompt,
      beforeTurn: async () => {
        const control = await readJobControl(job);
        if (control === "cancelled") throw new StoryCancelledError("foundations:" + assignment.domain);
        if (control !== "running") throw new AssignmentAuthorPauseError();
        await context.beforeTurn(sessionFile);
        if (await readJobControl(job) !== "running") throw new AssignmentAuthorPauseError();
      },
      prompt: async text => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, text);
        await recordPiSession(job, sessionFile);
      },
      verify: async manifest => {
        const skillReads = await readSkills();
        // Author questions are only a settled report; the work-unit
        // controller separately verifies scope, protection and author receipt.
        if ("authorDecisionRequest" in manifest) return [];
        return verifyDraft(toEvidence(manifest, skillReads));
      },
    }, round);
    if (result.status !== "accepted") return { round: result };
    const proof = result.proof;
    const final = session.messages.filter(m => m.role === "assistant").at(-1);
    if (!final || final.role !== "assistant" || final.stopReason !== "stop")
      throw Error("Original foundation specialist response is not settled.");
    const text = final.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const choice = extractSpecialistChoice(text);
    const skillReads = await readSkills();
    await context.completed(sessionFile, session.sessionId);
    if (choice) return { authorQuestion: parseSpecialistChoice(choice.authorDecisionRequest),
      claimedPaths: choice.modifiedRecords as string[], piSessionId: session.sessionId, piSessionFile: sessionFile };
    return { ...toEvidence(lastSpecialistManifest(text)!, skillReads), invocationProof: proof };
  } finally { session.dispose(); }
}
