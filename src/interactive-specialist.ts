import { createPiStatusTool } from "./pi-work-status.js";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJobModelRuntime } from "./model-runtime.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { lastSpecialistManifest, requireSpecialistManifest } from "./specialist-manifest.js";
import { requirePinnedSkillReads } from "./pinned-skill-reads.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext, piNarrativeGroup } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import { boundedPinnedSources, pinnedSourcePaths, renderBoundedPrompt } from "./bounded-specialist-prompt.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { CHOICE_PAYOFF_AUTHOR, CHOICE_PAYOFF_REPAIR } from "./choice-payoff-guidance.js";
import { PUZZLE_GOAL_AUTHOR, PUZZLE_GOAL_REPAIR } from "./puzzle-goal-fidelity.js";

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
    (domain === "choice" && !obj.modifiedRecords.length) ||
    !strings(obj.architecturalConflicts) ||
    !strings(obj.laterObligations)
  ) {
    throw new Error(
      "Interactive specialist must return complete modifiedRecords, architecturalConflicts and laterObligations JSON.",
    );
  }
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
      "Read ASSIGNMENT.eventSource (when provided), assigned canonical sources and only " +
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
  onSession: (file: string) => Promise<void>,
  verifyDraft: (evidence: InteractiveEvidence) => Promise<string[]>,
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
      group: piNarrativeGroup("interactive:" + domain, assignment.sourcePaths, assignment.milestoneId),
      step: "interactive:" + assignment.workItemId + ":" + domain,
      paths: assignment.sourcePaths,
      snapshot: snapshot.id,
      provider,
      model: modelId,
      task: { kind: "puzzle", ids: [...assignment.eventIds, assignment.milestoneId], scope: "related" },
      thinking,
      directory: dir,
    },
    runtime,
  );
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root,
    modelRuntime: runtime,
    model: context.model,
    thinkingLevel: context.thinking,
    resourceLoader: loader,
    settingsManager,
    sessionManager: context.manager,
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
    if (sessionFile) await onSession(sessionFile);
    const pinned = pinnedSourcePaths(snapshot, required);
    let prompt = interactiveSpecialistPrompt(snapshot, domain, assignment, Boolean(sandboxTools));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) await context.beforeTurn(session.sessionManager.getSessionFile() ?? undefined);
      await promptStorySpecialist(session, attempt === 0 ? context.contextNote + prompt : prompt);
      const skillReads = await requirePinnedSkillReads(
        session,
        project.root,
        pinned,
        "Interactive specialist",
      );
      const last = [...session.messages].reverse().find((m) => m.role === "assistant");
      if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) {
        throw new Error(
          "Interactive Pi turn failed: " +
            (last?.role === "assistant"
              ? last.stopReason + ": " + (last.errorMessage ?? "")
              : "no assistant response"),
        );
      }
      const completed = new Set(
        session.messages
          .filter(
            (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && !m.isError,
          )
          .map((m) => m.toolCallId),
      );
      const calls = session.messages.flatMap((m) =>
        m.role === "assistant" ? m.content.filter((c) => c.type === "toolCall") : [],
      );

      const edits = calls
        .filter(
          (c) =>
            ["write", "edit"].includes(c.name) &&
            completed.has(c.id) &&
            typeof c.arguments?.path === "string",
        )
        .map((c) =>
          relative(project.root, resolve(project.root, c.arguments.path as string))
            .split(sep)
            .join("/"),
        );
      // A linked Choice/Puzzle may already exist. The independent audit must
      // check its final state; tool-call evidence need not show a cosmetic edit
      // to that particular record type.
      const data = await requireSpecialistManifest(
        session,
        (text) => parseInteractiveManifest(text, domain),
        "Interactive",
        domain === "puzzle" && assignment.puzzleObligation?.required === false,
      );
      if (data.paths.length === 0) {
        if (
          domain !== "puzzle" ||
          assignment.puzzleObligation?.required !== false ||
          edits.length ||
          !data.conflicts.length
        )
          throw new Error("Only an optional Puzzle may return a genuine, untouched no-write report.");
      } else if (!edits.length) {
        throw new Error("Interactive specialist made no canonical Story edits.");
      }
      const evidence: InteractiveEvidence = {
        modifiedRecords: data.paths,
        conflicts: data.conflicts,
        obligations: data.obligations,
        skillReads,
        piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
      };
      const diagnostics = await verifyDraft(evidence);
      if (!diagnostics.length) {
        await context.completed(session.sessionManager.getSessionFile()!, session.sessionId);
        return evidence;
      }
      if (attempt === 2)
        throw new Error(
          "Interactive specialist exhausted bounded repair attempts: " + diagnostics.join("; "),
        );
      prompt =
        "The INDEPENDENT graph audit rejected your uncommitted work. " +
        "In this SAME Pi session, repair only the specific diagnostics below without touching " +
        "existing Event prerequisite gates or protected decisions. If a READ-ONLY file was edited, " +
        "restore precisely that file using read/edit/write tools, not git checkout/restore/reset; " +
        "retain your authorized changes. The sourcePaths inventory and scope.targets are READ-ONLY context/goals, " +
        "not edit permissions. Compare changed files against the originally read sources and provide " +
        "the FULL cumulative modifiedRecords manifest EXCLUDING restored files. " +
        "Do not claim a conditional or unverified path is proven. " +
        (domain === "puzzle" && assignment.puzzleObligation?.required === false
          ? "If there is NO source-grounded solvable Puzzle, restore every draft edit and " +
            "return modifiedRecords: [] with specific architecturalConflicts. " +
            "Do not fabricate missing clue or solution evidence. "
          : "") +
        (domain === "choice" ? CHOICE_PAYOFF_REPAIR : PUZZLE_GOAL_REPAIR) +
        " " +
        "Diagnostics:\n" +
        diagnostics.join("\n");
    }
    throw new Error("Unexpected interactive repair loop termination.");
  } finally {
    session.dispose();
  }
}
