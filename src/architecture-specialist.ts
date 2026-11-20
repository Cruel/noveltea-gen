import { createPiStatusTool } from "./pi-work-status.js";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "./git-read-cache.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { join, relative, resolve, sep } from "node:path";
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
import { guardPiBudget } from "./job-pi-policy.js";
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
export function architectureMilestoneOrder(text: string): string[] | null {
  const lines = text.split(/\r?\n/).filter(line => /^CAUSAL_MILESTONE_ORDER:\s*/.test(line));
  if (lines.length !== 1) return null;
  const raw = lines[0]!.slice('CAUSAL_MILESTONE_ORDER:'.length).trim();
  const ids = raw.split(',').map(s => s.trim());
  if (!ids.length || ids.some(id => !/^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) ||
      new Set(ids).size !== ids.length) return null;
  return ids;
}

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
      (blueprint ? "The independently reviewed PROVISIONAL causal blueprint " +
        "appears below. Implement its inspectable evidence, causal links, route " +
        "alternatives, consequences and bounded resolution in Arc/Milestone records. " +
        "Beat slugs are NOT canonical IDs and future clues are NOT established facts. " +
        "Do not silently weaken the reviewed conclusion or protected alternatives." : ""),
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
  authorTask?: string,
  blueprint?: CausalBlueprint,
): Promise<{ piSessionId: string; piSessionFile?: string; skillReads: string[]; milestoneOrder: string[];
  draftReview: ArchitectureDraftReviewPin }> {
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
    group: "architecture", step: "architecture:" + plan.version,
    paths: ["creative-direction/foundation.md"], snapshot: snapshot.id,
    provider, model: modelId, directory: sessionDir,
  }, runtime);
  const sandboxTools = await selectSandboxPiTools(job, snapshot, skills);
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager,
    customTools: [...(sandboxTools ?? []), createStoryValidateTool(job), context.contextTool, createPiStatusTool()],
    noTools: "all", tools: [...SANDBOX_TOOLS, "story_context", "story_validate", "report_status"],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking) {
      throw new Error("Pi architecture specialist did not honor pinned thinking effort.");
    }
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Architecture Pi session transcript cannot be persisted; writer will not begin.");
    await onSession(session.sessionId, sessionFile);
    await context.beforeTurn(sessionFile);
    await promptStorySpecialist(session, context.contextNote +
      architectureSpecialistPrompt(snapshot, plan, Boolean(sandboxTools), authorTask, blueprint));
    let assistant = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!assistant || assistant.role !== "assistant" ||
        ["error", "aborted"].includes(assistant.stopReason)) {
      throw new Error("Architecture specialist did not complete a successful Pi turn.");
    }
    const attemptedWrite = session.messages.some(m => m.role === "assistant" &&
      m.content.some(c => c.type === "toolCall" && ["write", "edit"].includes(c.name)));
    const newStory = !existsSync(join(project.root, "arcs")) &&
      !existsSync(join(project.root, "milestones"));
    if (newStory && !attemptedWrite) {
      const env = { ...process.env };
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
        delete env[key];
      const dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (canCorrectEmptyArchitecture(attemptedWrite, dirty)) {
        await promptStorySpecialist(session, emptyArchitectureCorrectionPrompt());
        assistant = [...session.messages].reverse().find(m => m.role === "assistant");
        if (!assistant || assistant.role !== "assistant" ||
            ["error", "aborted"].includes(assistant.stopReason))
          throw new Error("Same-session empty Architecture correction did not complete safely.");
      }
    }
    const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const calls = session.messages.flatMap(m => m.role === "assistant"
      ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall")
      : []);
    const reads = calls.filter(c => completed.has(c.id) && c.name === "read" &&
      typeof c.arguments?.path === "string")
      .map(c => canonicalPinnedReadPath(c.arguments.path as string, project.root, snapshot.path));
    const required = REQUIRED.map(p => join(snapshot.path, "skills", p));
    if (required.some(path => !reads.includes(path))) {
      throw new Error("Architecture specialist did not read all required pinned skill references.");
    }
    const authored = calls.some(c => completed.has(c.id) && ["write", "edit"].includes(c.name) &&
      typeof c.arguments?.path === "string" &&
      authorizedArchitectureRecordPath(
        relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"),
      ));
    if (!authored) throw new Error("Architecture specialist did not author canonical Arc/Milestone Markdown.");
    const authoredPaths = [...new Set(calls.filter(c => completed.has(c.id) &&
      ["write", "edit"].includes(c.name) && typeof c.arguments?.path === "string")
      .map(c => relative(project.root, resolve(project.root, c.arguments.path as string)).split(sep).join("/"))
      .filter(authorizedArchitectureRecordPath))];
    const authorityErrors = async () => {
      const result: string[] = [];
      for (const path of authoredPaths) {
        let before = "";
        try {
          const env = { ...process.env };
          for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
            delete env[key];
          before = execFileSync("git", ["show", "HEAD:" +
            (job.storyRelativePath ? job.storyRelativePath + "/" : "") + path], {
            cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        } catch { /* Newly created file: no existing author authority. */ }
        const full = join(project.root, path);
        const stat = await lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink() || await realpath(full) !== full)
          throw new Error("Architecture preflight rejects unsafe record path: " + path);
        const after = await readFile(full, "utf8");
        for (const id of unapprovedArchitectureDecisionIds(after, before))
          result.push(path + " decision " + id);
      }
      return result;
    };
    const errors = await authorityErrors();
    if (errors.length) {
      // One completed-turn correction in the SAME Pi session, not a replay of
      // an uncertain writer or a grant of previously absent user protection.
      await promptStorySpecialist(session,
        "The controller found NEW author-protected decisions that were not " +
        "approved by the author. This is a provenance error, not a schema " +
        "validation exception. In your existing Arc/Milestone files, correct " +
        "each newly authored decision to origin: agent and authority: delegated; " +
        "preserve all truly preexisting author-protected decisions unchanged. " +
        "Do not modify any other records or ask the author for blanket approval. " +
        "Run story_validate and finish normally. Exact new invalid claims:\n" + errors.join("\n"));
      const corrected = [...session.messages].reverse().find(m => m.role === "assistant");
      if (!corrected || corrected.role !== "assistant" || ["error", "aborted"].includes(corrected.stopReason))
        throw new Error("Architecture authority correction turn did not complete safely.");
      const stillInvalid = await authorityErrors();
      if (stillInvalid.length) throw new Error("Architecture invented user protection: " + stillInvalid.join("; "));
    }
    let milestoneOrder = architectureMilestoneOrder(assistant.content.filter(c =>
      c.type === 'text').map(c => c.text).join('\n'));
    if (!milestoneOrder) {
      // Never guess alphabetical order or relaunch the original writer. Request
      // one no-write metadata correction in this same pinned Pi session.
      await promptStorySpecialist(session,
        'The final answer omitted the exact CAUSAL_MILESTONE_ORDER line. Read the Milestones you just authored if necessary. ' +
        'Do not edit any files, create new records or modify the proposed scope. ' +
        'Reply with exactly CAUSAL_MILESTONE_ORDER: followed by all selected milestone IDs ' +
        'in actual dramatic cause-to-consequence order, comma-separated.');
      const latest = [...session.messages].reverse().find(m => m.role === 'assistant');
      if (latest?.role !== 'assistant' || ['error', 'aborted'].includes(latest.stopReason))
        throw new Error('Architecture milestone-order correction did not finish safely.');
      milestoneOrder = architectureMilestoneOrder(latest.content.filter(c =>
        c.type === 'text').map(c => c.text).join('\n'));
      if (!milestoneOrder) throw new Error('Architecture did not declare a valid source-bound causal Milestone order.');
    }
    // Review the ACTUAL uncommitted draft before it becomes a source-verified
    // Architecture checkpoint. The independent read-only reviewer cannot
    // approve canon or weaken the later mandatory postcommit semantic gate.
    const { createArchitectureDraftReviewCycle, verifyArchitectureDraftReviewPin } =
      await import("./architecture-draft-review.js");
    const writer = { id: session.sessionId, file: sessionFile };
    const cycle = await createArchitectureDraftReviewCycle(job, snapshot, plan, provider,
      modelId, authoredPaths, writer, authorTask ?? "", blueprint);
    let draftReview: ArchitectureDraftReviewPin | undefined;
    try {
      for (let iteration = 0; ; iteration++) {
        const result = await cycle.review();
        const review = result.verdict;
        if (review.status === "pass") {
          draftReview = result.pin;
          break;
        }
        if (result.convergence.reassess) throw new Error(
          "Independent Architecture draft review requires independent reassessment " +
          "after two nonproductive corrections; preserve draft and original Pi sessions.");
        await guardPiBudget(job, "architecture:precommit-writer:" + plan.version + ":" + iteration,
          sessionFile);
        await promptStorySpecialist(session,
        "INDEPENDENT PRECOMMIT ARCHITECTURE REVIEW: The read-only reviewer found " +
        "specific problems in the existing Arc/Milestone draft. Within ONLY the " +
        "already authorized files, correct these findings in this SAME original writer " +
        "Pi session. No new files, scope, protected author decisions or write authority " +
        "have been granted. Do not invent Event/Choice IDs, fabricate independent " +
        "observations, or conceal route-duration uncertainty. If a finding truly " +
        "needs author approval or another owner, make NO unauthorized edit and " +
        "explain the conflict. Run story_validate and finish with the exact " +
        "CAUSAL_MILESTONE_ORDER line listing all authored Milestones. " +
        "The subsequent independent rereview remains mandatory.\n" +
        JSON.stringify(review.findings));
        const corrected = [...session.messages].reverse().find(m => m.role === "assistant");
        if (!corrected || corrected.role !== "assistant" ||
            ["error", "aborted"].includes(corrected.stopReason))
          throw Error("Architecture same-session review correction was interrupted; preserve draft.");
        const stillInvalid = await authorityErrors();
        if (stillInvalid.length)
          throw Error("Architecture review correction invented protected decisions: " + stillInvalid.join("; "));
        const candidateOrder = architectureMilestoneOrder(corrected.content.filter(c =>
          c.type === "text").map(c => c.text).join("\n"));
        if (!candidateOrder)
          throw Error("Architecture review correction omitted the exact causal Milestone order; preserve draft.");
        milestoneOrder = candidateOrder;
      }
    } finally { cycle.dispose(); }
    if (!draftReview) throw Error("Architecture precommit review ended without an exact independent pass.");
    await verifyArchitectureDraftReviewPin(job, snapshot, plan, provider, modelId,
      authoredPaths, writer, draftReview, authorTask ?? "", blueprint);
    await context.completed(sessionFile, session.sessionId);
    return { piSessionId: session.sessionId, piSessionFile: session.sessionManager.getSessionFile() ?? undefined,
      skillReads: reads.filter(p => required.includes(p)), milestoneOrder, draftReview };
  } finally {
    session.dispose();
  }
}
