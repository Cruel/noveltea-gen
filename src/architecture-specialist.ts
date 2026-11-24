import { createPiStatusTool } from "./pi-work-status.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createJobModelRuntime } from "./model-runtime.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { promptStorySpecialist } from "./story-interruption.js";
import type { JobStartResult } from "./job.js";
import { createProjectResourceLoader } from "./pi.js";
import { openStoryProject } from "./project.js";
import { createStoryValidateTool } from "./validator.js";
import { preparePiContext } from "./job-pi-policy.js";
import type { SkillConfig } from "./skills.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { Plan } from "./architecture.js";
import type { CausalBlueprint } from "./architecture-blueprint.js";
import { specialistAuthorInstruction } from "./specialist-author-instruction.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { authorizedArchitectureRecordPath } from "./architecture-record-path.js";
import { selectSandboxPiTools, SANDBOX_TOOLS } from "./sandbox-pi-tools.js";
import { boundedPinnedSources, renderBoundedPrompt } from "./bounded-specialist-prompt.js";
import { guardPiBudget, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import { executeAssignmentRound, AssignmentAuthorPauseError, type AssignmentRoundCommand, type AssignmentDefect } from "./assignment-metadata-recovery.js";
import { readJobControl } from "./job-control.js";
import type { ArchitectureDraftReviewPin } from "./architecture-draft-review.js";

/** A new agent-authored Arc/Milestone decision cannot silently grant itself
 * author protection. Previously pinned author-protected decisions are retained
 * byte-for-byte; only newly claimed protection is rejected here. */
export function unapprovedArchitectureDecisionIds(after: string, before = ""): string[] {
  type Decision = { id?: string; origin?: string; authority?: string; statement?: string };
  const decisions = (text: string): Decision[] => {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return [];
    const end = lines.indexOf("---", 1);
    if (end < 0) return [];
    let inside = false;
    let current: Decision | null = null;
    const records: Decision[] = [];
    for (const line of lines.slice(1, end)) {
      if (/^decisions:\s*$/.test(line)) { inside = true; continue; }
      if (/^[a-z][a-z0-9_-]*:/.test(line)) { inside = false; current = null; }
      if (!inside) continue;
      const item = line.match(/^  - id:\s*(.+?)\s*$/);
      if (item) { current = { id: item[1]!.replace(/^['"]|['"]$/g, "") }; records.push(current); continue; }
      if (!current) continue;
      const field = line.match(/^    (origin|authority|statement):\s*(.+?)\s*$/);
      if (field) (current as Record<string, string>)[field[1]!] = field[2]!.replace(/^['"]|['"]$/g, "");
    }
    return records;
  };
  const prior = new Set(decisions(before).map(d => JSON.stringify(d)));
  return decisions(after).filter(d => d.authority === "user-protected" &&
    (d.origin === "agent" || !prior.has(JSON.stringify(d)))).map(d => d.id ?? "unnamed");
}

/** The same pinned writer supplies a source-bound execution order after its
 * canonical Milestones exist. This changes scheduling only, never record grants
 * or the story's native causal prerequisites. */
export { architectureMilestoneOrder } from "./architecture-order.js";

const REQUIRED = boundedPinnedSources("nt-story-architecture");

/** Architecture is the plan-only unit, not the owner of later Event bindings. */
export function architectureSpecialistPrompt(
  snapshot: SkillSnapshot,
  plan: Plan,
  sandboxed: boolean,
  authorTask?: string,
  blueprint?: CausalBlueprint,
): string {
  return renderBoundedPrompt(snapshot, {
    goal:
      "Author the selected causal Arc/Milestone architecture from the actual " +
      "Creative Direction. On a NEW Story the Arcs and Milestones do NOT yet exist: " +
      "YOU are authorized to CREATE the first Arc and Milestones now, without " +
      "waiting for a separate writer, existing record, or author approval. " +
      "Establish an ordered chain of substantive turning points " +
      "and their enabling conditions, meaningful changes and later payoffs in enduring " +
      "in-world prose, without inventing Event IDs or later-stage records. " +
      "The approved Creative Direction planning is a whole-Story constraint: " +
      "distribute consequential choices and Puzzle work based on its Choice/branching " +
      "profile, target first-playthrough length, Narrative/Exploration pacing, " +
      "and hard/soft illustration and Character artwork limits. " +
      "Do not impose per-Milestone Choice/Puzzle quotas or a fixed three-Act shape. " +
      "For each major decision under a Choice-heavy or lasting-impact profile, " +
      "describe the causal prerequisites, alternatives, and what knowledge, access " +
      "or relationships actually differ after any route reconvergence. Explicitly " +
      "show those decisions in the Arc trajectory AND relevant Milestone prose " +
      "at planning level, not by inventing later Event IDs, Choices or route edges. " +
      "Enumerate every original author-protected choice or welfare constraint " +
      "in the approved Creative Direction in the actual affected Milestones: " +
      "name the supported alternatives and how the protected value survives " +
      "the conclusion, rather than treating it as only a thematic concern.",
    sources: REQUIRED,
    sourceUse:
      "Read Creative Direction and relevant existing canonical Story records IF present. " +
      "A new Story containing ONLY Creative Direction is the expected starting " +
      "state, not an incomplete project or a reason to halt for missing Arcs. " +
      "Never search the noncanonical .story-inbox/ideas directory; only explicitly " +
      "supplied scoped author constraints may influence this unit.",
    writableScope:
      "Only authorized arcs/*.md and milestones/*.md; all other records, " +
      "including Creative Direction and Events, are read-only. Do not change existing " +
      "protected decisions or create new user-protected decisions: new agent decisions " +
      "have origin: agent and authority: delegated. File stems are untyped slugs, not IDs. " +
      (sandboxed
        ? "Use the networkless /story sandbox; no host Git, paths or credentials. " +
          "The story_validate TOOL is provided directly; do not search for or require " +
          "a host-installed noveltea CLI executable."
        : "Do not stage, commit, checkout or reset; Git status/diff inspection is permitted."),
    doneWhen:
      "CREATE canonical Arc and Milestone schema 0.1 Markdown files yourself " +
      "even when no other Arc/Milestone exists. They name plausible prior conditions, " +
      "turning point outcomes and their causal successor (or terminal payoff). " +
      "For investigations distinguish discovery, evidence, inference, confrontation " +
      "and consequential player decision without asserting unsupported facts. " +
      "If a Milestone promises to test conflicting accounts, name a specific " +
      "plausible, player-inspectable independent observation (a concrete ordinary " +
      "trace, physical feature, or record-handling discrepancy), the witness " +
      "claim it can test, and what that observation can and cannot establish. A vague " +
      "promise of a later physical feature is not a causal plan. " +
      "As the delegated fictional story architect, you MAY invent specific " +
      "plausible FUTURE ON-PAGE clues, witness encounters, trace provenance and " +
      "consequences within the approved setting; they become a concrete " +
      "Arc/Milestone design obligation for later Event specialists, not a " +
      "claim that a historical Fact or Event is already authored. A central " +
      "clue cannot be conditional on 'if a record exists' or 'if a witness " +
      "is reachable': CHOOSE a credible planned source and name how the " +
      "player will inspect or test it. Plan the comparison, " +
      "not a prematurely proven inference or a fabricated Event. " +
      "For a disappearance mystery or suspected record alteration, separately " +
      "plan the last-known-presence evidence, the inspectable alteration " +
      "discrepancy, the link between them, and the limits of each inference. " +
      "If the Story promises a resolved disappearance, its planned evidence " +
      "must actually support a bounded account of what happened; do not " +
      "replace that promise with unrelated disclosures or " +
      "a purely thematic uncertainty ending. " +
      "Stage-incomplete Milestones must keep completeness: partial and " +
      "fulfillment: {any_of: []}; no speculative Events or artificial completion. " +
      "End the Arc with a specific, source-supported action the protagonist " +
      "can responsibly take after the final confrontation, what that action " +
      "accomplishes, and its lasting practical or social consequence. A vague " +
      "\"defensible response to uncertainty\" or unnamed \"terminal payoff\" is " +
      "not an ending. Preserve any intended uncertainty about culprit or motive " +
      "without introducing new protected canon or speculative targets. " +
      "Before finishing, audit the whole Arc backward from the final " +
      "action, the actual evidence and every protected/major Choice to the " +
      "first enabling Milestone. For each causal link ask which named " +
      "on-page witness/trace establishes it, what remains uncertain, " +
      "how the player encounters it, and which subsequent decision consumes it. " +
      "Fix unsupported jumps, conditional-only evidence, and contradictions " +
      "in ALL Arc/Milestone files now; do not leave them for Event authors. " +
      "Bodies remain true after subsequent World/Character/Event authorship; never " +
      "describe temporary implementation status. Give each Milestone plausible " +
      "duration_minutes narrative and exploration RANGES; distinguish missing " +
      "evidence from known zero. Arc-wide and first-playthrough durations are " +
      "route estimates, not a sum of mutually exclusive alternatives. Never sum " +
      "all branch routes or claim unsupported precise totals; reconcile shared " +
      "segments and selected alternatives against the approved first-playthrough " +
      "range, and mark uncertainty or provisional coverage explicitly. " +
      "A dialogue-led Story with puzzle_emphasis: none " +
      "must not gain a gratuitous Puzzle; a choice-heavy or substantially divergent " +
      "Story needs meaningful decisions throughout the planned routes, not a " +
      "token ending switch. Stage-only estimates are provisional until native " +
      "route analysis and semantic review. Reuse core cast, logical illustration " +
      "concepts and fictional locations where sound, while retaining justified " +
      "route-exclusive scenes, consequences after convergence and unique visuals. " +
      "If the brief requires more hard-budget art or a MATERIAL soft scope expansion, " +
      "report the conflict rather than silently relaxing protected requirements. " +
      "Validate with story_validate and repair errors before reporting. " +
      "Preserve the plan's depth, targets and protections. " +
      (blueprint ? (blueprint.schema === "noveltea-causal-blueprint/v2" ?
        "The independently reviewed COMPACT Story Blueprint appears below. " +
        "Translate its major Arcs/Milestones, causal answer, turning points, " +
        "meaningful choices, endings and whole-Story feasibility into canonical " +
        "Architecture. Invent plausible future evidence within delegated authority " +
        "when needed, without treating provisional details as protected canon. " +
        "Beat slugs are NOT canonical IDs. Preserve approved author decisions." :
        "The independently reviewed PROVISIONAL causal blueprint appears below. " +
        "Implement its inspectable evidence, causal links, route alternatives, " +
        "consequences and bounded resolution in Arc/Milestone records. Beat " +
        "slugs are NOT canonical IDs and future clues are NOT established facts. " +
        "Do not silently weaken the reviewed conclusion or protected alternatives.") : ""),
    laterObligations:
      "World and Character Foundations, Event prerequisites and " +
      "fulfillment routes, Choice/Puzzle and final prose are later owners. " +
      "Describe their necessary work; do not author it in this unit.",
    requiredOutput:
      "Return the actual selected Milestone execution order as exactly " +
      "one final line: CAUSAL_MILESTONE_ORDER: milestone.first,milestone.next " +
      "(replace with all real ordered Milestone IDs; no other claims on this line). " +
      "The controller verifies source, writes and approval separately.",
    assignmentLabel: "AUTHORIZED PLAN AND SCOPE",
    assignment: plan,
    authorInstruction: specialistAuthorInstruction(authorTask) +
      (blueprint ? "\nINDEPENDENTLY REVIEWED CAUSAL BLUEPRINT (provisional, not canon):\n" +
        JSON.stringify(blueprint) : ""),
  });
}

/** Only a clean zero-write first-Story misunderstanding can receive one more
 * turn in the original Pi session. Never retry a writer that attempted a write,
 * left a draft, or may have crossed the record/scope boundary. */
export function canCorrectEmptyArchitecture(attemptedWrite: boolean, gitDirty: boolean): boolean {
  return !attemptedWrite && !gitDirty;
}
export function emptyArchitectureCorrectionPrompt(): string {
  return "CONTROLLER-CORRECTED NEW STORY OWNERSHIP: No Arcs or Milestones exist " +
    "because this is a NEW Story. This is NOT missing source, an architectural " +
    "conflict, or a need to ask the author to restore records. You are the " +
    "already-authorized nt-story-architecture writer. In the SAME original Pi " +
    "session, read the current Creative Direction and CREATE the first bounded " +
    "Arc and Milestone files now, keeping protected choices unchanged. The " +
    "networkless sandbox intentionally lacks the host CLI; the story_validate " +
    "tool is directly available and must be used without arguments. No new " +
    "write grant, tool, scope expansion or protected authorization was issued. " +
    "Establish a source-grounded causal order, leave fulfillment.any_of empty " +
    "for deferred Event work, and finish with one exact " +
    "CAUSAL_MILESTONE_ORDER: milestone.first,milestone.next line listing all " +
    "actually authored Milestone IDs. If genuinely impossible under the " +
    "existing authorized scope, make no edits and report the reason instead " +
    "of inventing missing records.";
}

/** The specialist authors Markdown; it cannot approve, validate, or commit its own output. */
export async function authorArchitecture(
  job: JobStartResult,
  snapshot: SkillSnapshot,
  plan: Plan,
  provider: string,
  modelId: string,
  onSession: (sessionId: string, path: string) => Promise<void>,
  authorTask: string | undefined,
  blueprint: CausalBlueprint | undefined,
  options: {
    command: AssignmentRoundCommand; sourceDigest: string; sessionFile?: string; sessionId?: string;
    authorize: () => Promise<void>; effect: () => Promise<string | null>;
    reviewPaths?: readonly string[];
    verify: (order: string[], reads: string[], writes: string[], writer: {id: string; file: string}, writerRound: string) =>
      Promise<{ defects: readonly AssignmentDefect[]; draftReview?: ArchitectureDraftReviewPin }>;
  },
) {
  const project = await openStoryProject(job.worktreeStoryRoot);
  const config: SkillConfig = {
    discovery: "explicit-only", novelteaSkills: snapshot.path,
    skillDirs: [], requiredSkills: ["nt-story-architecture", "nt-catalog"],
  };
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, config);
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "error") throw new Error("Architecture skill discovery: " + diagnostic.message);
  }
  for (const name of ["nt-story-architecture", "nt-catalog"]) {
    if (!skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))) {
      throw new Error("Missing pinned architecture skill " + name);
    }
  }
  const runtime = await createJobModelRuntime();
  const sessionDir = join(job.stateDir, "architecture-sessions");
  const context = await preparePiContext(job, project, {
    group: "architecture:" + options.sourceDigest, step: "architecture:" + plan.version,
    paths: ["creative-direction/foundation.md"], snapshot: snapshot.id,
    provider, model: modelId, directory: sessionDir, insideWriter: true,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const permittedTools = (sandboxTools ?? []).filter(t => t.name !== "bash").map(t => {
    if (!["write", "edit"].includes(t.name)) return t;
    const execute = t.execute;
    return { ...t, async execute(...args: Parameters<typeof execute>) {
      await options.authorize();
      const input = args[1] as { path?: unknown };
      const path = typeof input.path === "string" ?
        relative(project.root, resolve(project.root, input.path)).split(sep).join("/") : "";
      if (!authorizedArchitectureRecordPath(path) ||
          plan.causalAmendment && path !== plan.causalAmendment.source.path ||
          options.reviewPaths && !options.reviewPaths.includes(path))
        throw Error("Architecture tool write outside original authorized scope.");
      return execute(...args);
    }};
  });
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: options.sessionFile && existsSync(options.sessionFile) ? SessionManager.open(options.sessionFile, dirname(options.sessionFile), project.root) : context.manager,
    customTools: [...permittedTools, createStoryValidateTool(job), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: [...SANDBOX_TOOLS.filter(t => t !== "bash"), "story_context", "story_validate", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi architecture specialist did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Architecture Pi session transcript cannot be persisted; writer will not begin.");
    if (options.sessionId && options.sessionId !== session.sessionId) {
      const initialGrant = join(job.stateDir, "architecture-assignment", options.sourceDigest, "0.grant.json");
      if (existsSync(initialGrant) || await options.effect() !== null)
        throw Error("Original Architecture writer session changed.");
    }
    if (!existsSync(join(job.stateDir, "architecture-assignment", options.sourceDigest, "0.grant.json"))) {
      await options.authorize();
      if (await options.effect() !== null) throw Error("Unstarted Architecture writer has unexpected effects.");
      await guardPiBudget(job, "architecture:" + plan.version);
    }
    await onSession(session.sessionId, sessionFile);
    let accepted: { skillReads: string[]; milestoneOrder: string[]; draftReview: ArchitectureDraftReviewPin } | undefined;
    const round = await executeAssignmentRound({
      session, directory: join(job.stateDir, "architecture-assignment", options.sourceDigest),
      sourceDigest: options.sourceDigest, sessionRoots: [sessionDir], responseKind: "architecture-order",
      initialPrompt: context.contextNote + architectureSpecialistPrompt(snapshot, plan, Boolean(sandboxTools), authorTask, blueprint),
      authorize: options.authorize, effect: options.effect,
      beforeTurn: async () => {
        const control = await readJobControl(job);
        if (control === "paused") throw new AssignmentAuthorPauseError();
        if (control === "cancelled") { const error = Error("Architecture cancelled."); error.name = "StoryCancelledError"; throw error; }
        const ordinal = options.command.phase === "invoke" ? 0 :
          options.command.proof.ordinal + (options.command.phase === "correct" ? 1 : 0);
        await guardPiBudget(job, ordinal === 0 ? "architecture:" + plan.version :
          "architecture:writer:" + options.sourceDigest + ":" + ordinal, sessionFile);
      },
      prompt: async text => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, text);
        await recordPiSession(job, sessionFile);
      },
      verify: async manifest => {
        const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
          m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
        const calls = session.messages.flatMap(m => m.role === "assistant"
          ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall") : []);
        const reads = calls.filter(c => completed.has(c.id) && c.name === "read" && typeof c.arguments?.path === "string")
          .map(c => canonicalPinnedReadPath(c.arguments.path as string, project.root, snapshot.path));
        const required = REQUIRED.map(p => join(snapshot.path, "skills", p));
        const writes = [...new Set(calls.filter(c => completed.has(c.id) && ["write", "edit"].includes(c.name) &&
          typeof c.arguments?.path === "string").map(c =>
          relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/")))];
        const missing = required.filter(p => !reads.includes(p));
        const order = manifest.milestoneOrder as string[];
        const writerRound = createHash("sha256").update(await readFile(sessionFile)).digest("hex");
        const defects: AssignmentDefect[] = missing.map(p => ({kind: "requirement", path: p, code: "architecture-missing-source"}));
        if (defects.length) return defects;
        const result = await options.verify(order, reads, writes, {id: session.sessionId, file: sessionFile}, writerRound);
        if (!result.defects.length && result.draftReview)
          accepted = { skillReads: reads.filter(p => required.includes(p)), milestoneOrder: order, draftReview: result.draftReview };
        return result.defects;
      },
    }, options.command);
    if (round.status !== "accepted") return { round };
    if (!accepted) throw Error("Architecture acceptance lacks its independently reviewed source.");
    await context.completed(sessionFile, session.sessionId);
    return { round, accepted: { ...(accepted as {skillReads: string[]; milestoneOrder: string[]; draftReview: ArchitectureDraftReviewPin}),
      piSessionId: session.sessionId, piSessionFile: sessionFile } };
  } finally { session.dispose(); }
}
