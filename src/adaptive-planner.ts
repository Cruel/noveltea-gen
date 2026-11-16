/** Read-only, pinned adaptive Story planning. The model proposes; the
 * controller separately authorizes each pending action against native sources.
 * This session never owns Story write tools or review approval. */
import { join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { GenerationInventory } from "./generation-plan.js";
import type { TurnEvidence } from "./turn-plan-evidence.js";
import type { StoryOrchestratorSelection } from "./orchestrator-selection.js";
import type { StoryPlanning } from "./story-planning.js";
import type { StoryArchitectureMetrics } from "./story-metrics.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import type { AdaptiveProposal } from "./adaptive-assignments.js";

export class InvalidAdaptiveProposalError extends Error {}
function parseReply(message: string): AdaptiveProposal {
  const raw = message.trim().replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, "");
  try { return JSON.parse(raw) as AdaptiveProposal; }
  catch { throw new InvalidAdaptiveProposalError("Adaptive orchestrator did not return a bounded JSON plan proposal."); }
}

export async function proposeAdaptiveWork(input: {
  job: JobStartResult; selected: StoryOrchestratorSelection;
  turn: TurnEvidence; inventory: GenerationInventory; planning: StoryPlanning;
  metrics: StoryArchitectureMetrics;
  provider: string; model: string; version: number; signature: string;
}): Promise<{ proposal: AdaptiveProposal; sessionFile: string; skillReads: string[] }> {
  const { job, selected, turn, inventory, planning, metrics, provider, model, version, signature } = input;
  if (selected.receipt.storySourceSha !== job.baseSha ||
      selected.receipt.turnPlanDigest !== turn.digest ||
      inventory.headSha === job.baseSha ||
      turn.kind !== "full-story" || !turn.objective ||
      metrics.metricsVersion !== 1)
    throw Error("Adaptive planner lacks a source-bound original whole-Story objective and verified Architecture.");
  const snapshot = selected.receipt.skillSnapshot;
  const project = await openStoryProject(job.worktreeStoryRoot);
  const required = requiredOrchestratorSkillReads(turn.creativePolicy?.mode ?? "autonomous");
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true, {
    discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [],
    requiredSkills: ["nt-story-orchestrate", "nt-catalog", "nt-story-discovery",
      ...(turn.creativePolicy?.mode === "collaborative" ? ["nt-story-collaborate"] : [])],
  }, [], "orchestrator", turn.creativePolicy?.mode === "collaborative");
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (diagnostics.some(d => d.type === "error") ||
      !["nt-story-orchestrate", "nt-catalog"].every(name =>
        skills.some(s => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep))))
    throw Error("Pinned adaptive Story orchestrator methodology is unavailable.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: "orchestrator:adaptive", step: "orchestrator:adaptive:" + signature,
    paths: [], snapshot: snapshot.id, provider, model,
    directory: join(job.stateDir, "adaptive-planning-sessions"),
  }, runtime);
  const tools = await selectSandboxPiTools(job, snapshot, skills, undefined,
    "read-only", "orchestrator");
  const { session } = await createAgentSession({
    cwd: project.root, modelRuntime: runtime, model: context.model,
    thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: tools ?? [],
    noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw Error("Adaptive orchestrator violated the pinned model thinking policy.");
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw Error("Adaptive planning cannot preserve its original Pi session.");
    await context.beforeTurn(sessionFile);
    const pending = inventory.items.filter(i => i.status === "pending");
    const prompt = context.contextNote +
      "You are the pinned NovelTea Story orchestrator at a verified safe boundary. " +
      "You are READ-ONLY, not a writer, author approval authority or reviewer. " +
      "Read these exact pinned skills/references with the read tool BEFORE proposing: " +
      required.map(r => "skill://" + r).join(", ") + ". " +
      "Inspect actual canonical Story sources with safe read/find/grep. Do not access private .story-inbox. " +
      "Compare the author's ORIGINAL goal and approved whole-Story Creative Direction to current causal " +
      "Event, Choice, Puzzle, Composition and playable-route evidence. " +
      "An observational/short VN can have zero formal Puzzles, or no Choices when approved. " +
      "A choice-heavy Story can need multiple distributed Choices and extra causal Events; " +
      "do not impose uniform per-Milestone quotas or fabricated precise playtime. " +
      "This is a provisional PLAN amendment, NOT approval to modify a protected record. " +
      "You may reorder only remaining pending assignments, split an UNSTARTED interactive " +
      "Milestone into an exact pair of Choice then Puzzle decision specialists, or add a " +
      "missing Event/Interactive/Composition unit for a Milestone present in the VERIFIED Architecture " +
      "scope. Each addition needs explicit causal dependency IDs and must remain within the " +
      "original depth and author goal. 'Puzzle' is a decision/possible no-write work unit, " +
      "not an obligation to invent a formal Puzzle. Do not ask routine author questions. " +
      "Never omit an assignment unless the controller has ALREADY supplied an independently sealed " +
      "Event-only omission proof. NO such omissions are preauthorized here. " +
      "You cannot change a completed or blocked item, add a new canonical target ID, " +
      "or remove the final Story-wide independent review. " +
      "Prefer the minimal change: empty actions when current work is sound. " +
      "The controller will reject unsupported scope changes, invented grants, duplicate IDs, " +
      "missing dependencies and unreviewed omissions. " +
      "\nOriginal author goal: " + turn.goal +
      "\nOriginal author requirements: " + JSON.stringify(turn.objective) +
      "\nOriginal completion contract: " + JSON.stringify(turn.contract) +
      "\nApproved Creative Direction planning: " + JSON.stringify(planning) +
      "\nNative source-bound metrics (uncertainty is not zero): " + JSON.stringify({
        foundation: metrics.foundation, coverage: metrics.coverage,
        route: metrics.route, routeCoverage: metrics.routeCoverage,
        contentFootprint: metrics.contentFootprint, budgetFindings: metrics.budgetFindings,
      }) +
      "\nCurrent controller inventory (verified work stays immutable): " + JSON.stringify(inventory.items) +
      "\nOnly currently pending IDs: " + JSON.stringify(pending.map(i => i.id)) +
      "\nProposal format: ONLY a JSON object with EXACT keys sourceSha, turnDigest, " +
      "beforeVersion, reason, actions, order. sourceSha=" + inventory.headSha +
      ", turnDigest=" + turn.digest + ", beforeVersion=" + version + ". " +
      "actions entries must be one of {kind:'add',stage:'event'|'interactive'|'composition'," +
      "milestone:'milestone.<slug>',dependsOn:['existing assignment id']}, " +
      "{kind:'split',item:'interactive:milestone.<slug>',domains:['choice','puzzle']}. " +
      "Use strict JSON DOUBLE QUOTES. order MUST contain EVERY resulting pending ID " +
      "exactly once in dependency-safe order after all actions. " +
      "No omitted tasks, no extra keys, no invented milestones or quota assumptions.";
    await promptStorySpecialist(session, prompt);
    const completed = new Set(session.messages.filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
      m.role === "toolResult" && !m.isError).map(m => m.toolCallId));
    const skillReads = session.messages.flatMap(m => m.role === "assistant"
      ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
        c.type === "toolCall" && c.name === "read" && completed.has(c.id) &&
        typeof c.arguments?.path === "string") : [])
      .map(c => canonicalPinnedReadPath(c.arguments.path as string, project.root, snapshot.path));
    if (required.some(p => !skillReads.includes(join(snapshot.path, "skills", p))))
      throw new InvalidAdaptiveProposalError("Adaptive orchestrator skipped required pinned methodology reads.");
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["aborted", "error"].includes(last.stopReason))
      throw Error("Adaptive orchestrator model turn is interrupted; preserve the exact session without replay.");
    await context.completed(sessionFile, session.sessionId);
    return { proposal: parseReply(session.getLastAssistantText() ?? ""), sessionFile, skillReads };
  } finally {
    session.dispose();
  }
}
