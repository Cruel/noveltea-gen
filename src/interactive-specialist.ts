import { createPiStatusTool } from "./pi-work-status.js";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJobModelRuntime } from "./model-runtime.js";
import { promptStorySpecialist, StoryCancelledError } from "./story-interruption.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { lastSpecialistManifest } from "./specialist-manifest.js";
import { recoverSubmittedAssignment, AssignmentAuthorPauseError, type AssignmentInvocationProof } from "./assignment-metadata-recovery.js";
import { readJobControl } from "./job-control.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, guardPiBudget, recordPiSession, registerPendingPiSession } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import { boundedPinnedSources, pinnedSourcePaths, renderBoundedPrompt } from "./bounded-specialist-prompt.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { CHOICE_PAYOFF_AUTHOR } from "./choice-payoff-guidance.js";
import { PUZZLE_GOAL_AUTHOR } from "./puzzle-goal-fidelity.js";
import type { ReviewedMilestoneHandoff } from "./milestone-obligation-handoff.js";

export type InteractiveDomain = "choice" | "puzzle";
export interface InteractiveAssignment {
  workItemId: string;
  authorTask?: string;
  milestoneId: string;
  arcIds: string[];
  characterIds: string[];
  factIds: string[];
  eventIds: string[];
  /** Original verified Event source, not a grant to edit its entry gates. */
  milestoneBlueprint?: ReviewedMilestoneHandoff;
  eventSource?: {
    headSha: string;
    snapshotId: string;
    eventIds: string[];
    milestoneState: "complete" | "partial-choice-pending";
    missingObligations: string[];
  };
  sourcePaths: string[];
  authorContract: unknown;
  /** Controller decision derived from the source-bound Turn, never Pi authority. */
  puzzleObligation?: { required: boolean; reasons: string[] };
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
  invocationProof?: AssignmentInvocationProof;
}
const SPECIALISTS = {
  choice: { name: "nt-interactive-narrative" },
  puzzle: { name: "nt-puzzle-design" },
} as const;
export function parseInteractiveManifest(text: string, domain: InteractiveDomain = "choice") {
  const obj = lastSpecialistManifest(text);
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if (
    !obj ||
    !strings(obj.modifiedRecords) ||
    !strings(obj.architecturalConflicts) ||
    !strings(obj.laterObligations)
  ) {
    throw new Error(
      "Interactive specialist must return complete modifiedRecords, architecturalConflicts and laterObligations JSON.",
    );
  }
  // A clean, explicit contradiction is a negative specialist result, not a
  // malformed protocol response. The controller must verify its source and
  // route it through Repair; it cannot fabricate a Choice to satisfy the task.
  if (domain === "choice" && obj.modifiedRecords.length === 0 &&
      obj.architecturalConflicts.length === 0)
    throw new Error("Interactive Choice cannot report no Story edits without a verified Event-only omission.");
  return {
    paths: obj.modifiedRecords,
    conflicts: obj.architecturalConflicts,
    obligations: obj.laterObligations,
  };
}
/** The same rendered contract is used in live Pi and prompt conformance tests. */
export function interactiveSpecialistPrompt(
  snapshot: SkillSnapshot,
  domain: InteractiveDomain,
  assignment: InteractiveAssignment,
  sandboxed: boolean,
): string {
  const choice = domain === "choice";
  const optionalNoWrite = !choice && assignment.puzzleObligation?.required === false;
  return renderBoundedPrompt(snapshot, {
    goal: choice
      ? "Complete exactly ONE Choice unit: bind real alternatives to the original verified " +
        "Event, using its missing obligations and producing reachable, distinct outcome effects " +
        "and later conditional consumers."
      : "Assess exactly ONE Puzzle unit against the pinned Story and controller objective. " +
        (assignment.puzzleObligation?.required === false
          ? "Only author a solvable Puzzle if the verified Story actually supports its goal. " +
            "Otherwise return an explicit clean no-write report with concrete negative findings; " +
            "NEVER fabricate clue routes or solution Events to satisfy a stage name."
          : "A Puzzle is a required approved obligation; author a genuinely solvable Puzzle " +
            "or return a blocking dependency, never claim completion without it."),
    sources: boundedPinnedSources(SPECIALISTS[domain].name),
    sourceUse:
      "Read ASSIGNMENT.eventSource and the reviewed milestoneBlueprint (when provided), " +
      "its named owner obligations and assigned canonical sources; the private Blueprint is " +
      "provisional and cannot substitute for verified Event, route or clue evidence. Read only " +
      "necessary typed links. Use installed skills for schema fields, craft and validation.",
    writableScope:
      "ASSIGNMENT.sourcePaths and authorContract.scope.targets are read-only context " +
      "and goals; authorizedPaths is only a directory ceiling. Existing Fact, Relationship, " +
      "Character, World Entity, Arc, Milestone and Creative Direction files are read-only. " +
      "Never edit milestones/ or existing Event prerequisites. Only assigned writable Event, " +
      "Choice Point, Revelation and Authored Content records and connected new records may change; " +
      "no author-protected retcons. " +
      (sandboxed
        ? "Tools are confined to the networkless /story sandbox; no host Git or credentials."
        : "Do not stage, commit, reset or checkout; Git status/diff inspection is permitted."),
    doneWhen:
      (choice
        ? "Choice Point outcomes are slug strings, not objects. Use multiple enabled " +
          "conditions: [] Event-step branches with distinct kind: outcome effects for selectable " +
          "alternatives, source-grounded branch consequences and later consumers. Shared prose " +
          "must not leak exclusive information. Preserve the original Event entry gate verbatim. " +
          CHOICE_PAYOFF_AUTHOR +
          " Do not create a Puzzle in this unit."
        : (assignment.puzzleObligation?.required === false
            ? "Choose exactly one truthful outcome: (A) if the verified sources support " +
              "a genuinely playable formal Puzzle, author at least two separately " +
              "reachable solution Events and accessible pre-solution clues; every " +
              "solution must satisfy the SAME Puzzle objective, with distinct " +
              "consequences. (B) if no source-grounded formal Puzzle is justified, " +
              "make ZERO file edits and report the specific negative source evidence " +
              'as modifiedRecords: [], architecturalConflicts: ["specific finding"], ' +
              "laterObligations: [remaining Story requirements]. This is a " +
              "controller-reviewed no-write disposition, NOT a Puzzle pass or " +
              "permission to drop fair clues, Choice consequences or endings. " +
              "Never invent a Puzzle to satisfy the pipeline stage. "
            : "The approved Story requires a formal Puzzle: create at least two " +
              "separately reachable solving Events with accessible pre-solution " +
              "Authored Content clues attached to distinct reachable discovery " +
              "Events, genuine gated consequences and readable clue prose. " +
              "If the original authorized sources cannot support that goal, " +
              "report the exact blocker; do NOT claim success or downgrade it. ") +
          "Reuse existing valid records, not cosmetic duplicates. Do not " +
          "modify original Choice outcomes. " +
          PUZZLE_GOAL_AUTHOR) +
      " Author schema 0.1 Markdown and run story_validate, repair and revalidate. " +
      "Discharge every reviewed interactive-owner Milestone obligation against reachable " +
      "canonical routes and consequences, or report a source-bound blocker. No uniform " +
      "Puzzle/Choice quota is implied by the Milestone plan. " +
      "The controller checks actual final-state coverage, not output-file count.",
    laterObligations: choice
      ? "Leave Milestone fulfillment/completeness for a separately authorized closeout; " +
        "report any required Milestone changes in laterObligations. Puzzle and composition " +
        "belong to later units."
      : "Report downstream prose or other-owner dependencies; do not treat read access or " +
        "review suggestions as write approval.",
    requiredOutput:
      "Return exactly ONE unfenced JSON object with ONLY three arrays, in this exact order: " +
      "modifiedRecords, architecturalConflicts, laterObligations. " +
      (optionalNoWrite
        ? "For a genuine optional no-write use this exact SHAPE, substituting source-specific findings: " +
          '{"modifiedRecords":[],"architecturalConflicts":["No justified Puzzle objective or two distinct source-supported solution Events"],"laterObligations":["Preserve fair clues and consequential choices in composed endings"]}. ' +
          "An empty architecturalConflicts array is INVALID when modifiedRecords is empty. " +
          "If you authored a genuine Puzzle, list the actual changed paths and report no " +
          "unresolved architectural conflicts instead. "
        : "For authored work use this example SHAPE: " +
          '{"modifiedRecords":["events/example.md"],"architecturalConflicts":[],"laterObligations":[]}. ') +
      "ALL three arrays contain ONLY strings, never {id,path} objects. Include every " +
      "changed Story-relative path; report protected or unrelated blockers, never edit them. " +
      "Controller validation, scope audit and independent review decide acceptance.",
    assignmentLabel: "AUTHORIZED ASSIGNMENT",
    assignment,
    authorInstruction: specialistAuthorInstruction(assignment.authorTask),
  });
}

export async function authorInteractive(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  domain: InteractiveDomain,
  assignment: InteractiveAssignment,
  provider: string,
  modelId: string,
  thinking: "low" | "medium" | "high" | undefined,
  onSession: (file: string, id: string) => Promise<void>,
  verifyDraft: (evidence: InteractiveEvidence) => Promise<string[]>,
  original: { sourceDigest: string; sessionFile?: string; sessionId?: string;
    authorize: () => Promise<void>; effect: () => Promise<string | null> },
): Promise<InteractiveEvidence> {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const selected = SPECIALISTS[domain];
  const required = boundedPinnedSources(selected.name);
  const config: SkillConfig = {
    discovery: "explicit-only",
    novelteaSkills: snapshot.path,
    skillDirs: [],
    requiredSkills: [selected.name, "nt-catalog"],
  };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diag of diagnostics)
    if (diag.type === "error") throw new Error("Interactive skill discovery: " + diag.message);
  for (const name of [selected.name, "nt-catalog"]) {
    if (!skills.some((s) => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned interactive specialist " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const dir = join(job.stateDir, "interactive-sessions", assignment.workItemId, domain);
  const context = await preparePiContext(
    job,
    project,
    {
      group: "interactive:" + assignment.workItemId + ":" + domain + ":" + original.sourceDigest,
      step: "interactive:" + assignment.workItemId + ":" + domain,
      paths: assignment.sourcePaths,
      snapshot: snapshot.id,
      provider,
      model: modelId,
      task: { kind: "puzzle", ids: [...assignment.eventIds, assignment.milestoneId], scope: "related" },
      thinking,
      directory: dir,
      insideWriter: true,
    },
    runtime,
  );
  if (original.sessionFile && (await realpath(original.sessionFile) !== original.sessionFile ||
      !original.sessionFile.startsWith(dir + sep) || !(await lstat(original.sessionFile)).isFile()))
    throw Error("Original Interactive session is outside its assignment");
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root,
    modelRuntime: runtime,
    model: context.model,
    thinkingLevel: context.thinking,
    resourceLoader: loader,
    settingsManager,
    sessionManager: original.sessionFile
      ? SessionManager.open(original.sessionFile, dirname(original.sessionFile), project.root)
      : context.manager,
    customTools: [
      ...(sandboxTools ?? []),
      createStoryValidateTool(job),
      context.contextTool,
      createPiStatusTool(),
    ],
    noTools: "all",
    tools: [...SANDBOX_TOOLS, "story_context", "story_validate", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi did not honor requested " + thinking + " thinking level.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile || original.sessionId && original.sessionId !== session.sessionId)
      throw Error("Interactive writer lost its original persisted session");
    await onSession(sessionFile, session.sessionId);
    const pinned = pinnedSourcePaths(snapshot, required);
    let accepted: InteractiveEvidence | undefined;
    const invocationProof = await recoverSubmittedAssignment({
      session, directory: interactiveInvocationDirectory(job, assignment.workItemId, domain, session.sessionId),
      sourceDigest: original.sourceDigest, sessionRoots: [dir],
      initialPrompt: context.contextNote + interactiveSpecialistPrompt(snapshot, domain, assignment, Boolean(sandboxTools)),
      authorize: original.authorize, effect: original.effect,
      beforeTurn: async () => {
        const control = await readJobControl(job);
        if (control === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (control !== "running") throw new AssignmentAuthorPauseError();
        await guardPiBudget(job, "interactive:" + assignment.workItemId + ":" + domain, sessionFile);
        const after = await readJobControl(job);
        if (after === "cancelled") throw new StoryCancelledError(assignment.workItemId);
        if (after !== "running") throw new AssignmentAuthorPauseError();
      },
      prompt: async prompt => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, prompt);
        await recordPiSession(job, sessionFile);
      },
      verify: async manifest => {
        const data = parseInteractiveManifest(JSON.stringify(manifest), domain);
        const skillReads = await requirePinnedSkillReads(session, project.root, pinned, "Interactive specialist");
        const completed = new Set(session.messages
          .filter(m => m.role === "toolResult" && !m.isError)
          .map(m => (m as Extract<typeof m, { role: "toolResult" }>).toolCallId));
        const edits = session.messages.flatMap(m => m.role === "assistant"
          ? m.content.filter(c => c.type === "toolCall" && ["write", "edit"].includes(c.name) &&
              completed.has(c.id) && typeof c.arguments?.path === "string")
            .map(c => c.type === "toolCall" ? relative(project.root, resolve(project.root, c.arguments.path as string)) : "")
          : []);
        if (!data.paths.length && !data.conflicts.length)
          throw Error("A negative Interactive report requires specific conflicts");
        if (data.paths.length && !edits.length)
          throw Error("Interactive specialist made no canonical Story edits");
        const evidence: InteractiveEvidence = { modifiedRecords: data.paths, conflicts: data.conflicts,
          obligations: data.obligations, skillReads, piSessionFile: sessionFile };
        const diagnostics = await verifyDraft(evidence);
        if (!diagnostics.length) accepted = evidence;
        return diagnostics.map(detail => ({
          kind: "semantic" as const, path: assignment.milestoneId,
          code: createHash("sha256").update(detail).digest("hex"), detail,
        }));
      },
    });
    if (!accepted) throw Error("Original Interactive invocation has no independently checked result");
    await context.completed(sessionFile, session.sessionId);
    return { ...accepted, invocationProof };
  } finally {
    session.dispose();
  }
}

/** Invocation receipt namespace is unique to the original subunit/session. */
export function interactiveInvocationDirectory(job: JobStartResult, workItem: string, domain: InteractiveDomain, sessionId: string) {
  if (!/^interactive-[a-z][a-z0-9-]*$/.test(workItem) || !["choice", "puzzle"].includes(domain) || !/^[a-zA-Z0-9-]+$/.test(sessionId))
    throw Error("Invalid Interactive invocation identity");
  return join(job.stateDir, "interactive-invocations", workItem, domain, sessionId);
}
