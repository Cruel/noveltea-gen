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
import { completedPinnedSkillReads } from "./pinned-skill-reads.js";
import { missingAdaptiveMethodReads, adaptiveMethodCorrectionPrompt } from "./adaptive-method-correction.js";
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import type { AdaptiveProposal } from "./adaptive-assignments.js";

import { correctAdaptiveResponse, initialAdaptiveResponse, type AdaptiveRecovery } from "./adaptive-protocol.js";

export class InvalidAdaptiveProposalError extends Error {}

export async function proposeAdaptiveWork(input: {
  job: JobStartResult; selected: StoryOrchestratorSelection;
  turn: TurnEvidence; inventory: GenerationInventory; planning: StoryPlanning;
  metrics: StoryArchitectureMetrics;
  recovery?: AdaptiveRecovery;
  provider: string; model: string; version: number; signature: string;
  typedEdges: Array<{ item: string; needs: string }>;
  omissionCandidates: Array<{ assignmentId: string; sourcePath: string; evidence: string }>;
  sourceEvidence: Array<{ milestone: string; path: string; sha256: string }>;
}): Promise<{ proposal: AdaptiveProposal; sessionFile: string; skillReads: string[] }> {
  const { job, selected, turn, inventory, planning, metrics, provider, model, version, signature,
    typedEdges, omissionCandidates, sourceEvidence } = input;
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
    // Each admitted plan pins its transcript digest: a later assignment must
    // not append to it. Only its own format repair reopens this conversation.
    group: "orchestrator:adaptive:" + signature,
    resumeSession: input.recovery ? { ...input.recovery.proof, formatOnly: true } : undefined, step: "orchestrator:adaptive:" + signature,
    paths: [], snapshot: snapshot.id, provider, model,
    directory: join(job.stateDir, "adaptive-planning-sessions"),
  }, runtime);
  const tools = await selectSandboxPiTools(job, snapshot, skills, undefined,
    "read-only", "orchestrator", { kind: "adaptive", sourceSha: inventory.headSha });
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
    if (input.recovery) {
      const proposal = await correctAdaptiveResponse(job, input.recovery, session,
        () => context.beforeTurn(sessionFile), feedback => promptStorySpecialist(session, feedback));
      await context.completed(sessionFile, session.sessionId);
      return { proposal, sessionFile, skillReads: completedPinnedSkillReads(session.messages, project.root, snapshot.path) };
    }
    await context.beforeTurn(sessionFile);
    const pending = inventory.items.filter(i => i.status === "pending");
    const prompt = context.contextNote +
      "You are the pinned NovelTea Story orchestrator at a verified safe boundary. " +
      "You are READ-ONLY, not a writer, author approval authority or reviewer. " +
      "Read these exact pinned skills/references with the read tool BEFORE proposing: " +
      required.map(r => "skill://" + r).join(", ") + ". " +
      "Inspect pinned canonical Story sources with safe read/find/grep. The exact tracked " +
      "Story-root README.txt is ancillary context only, NOT a canonical Story record or " +
      "a replacement for required pinned methodology reads. Do not access private .story-inbox. " +
      "Compare the author's ORIGINAL goal and approved whole-Story Creative Direction to current causal " +
      "Event, Choice, Puzzle, Composition and playable-route evidence. " +
      "An observational/short VN can have zero formal Puzzles, or no Choices when approved. " +
      "A choice-heavy Story can need multiple distributed Choices and extra causal Events; " +
      "do not impose uniform per-Milestone quotas or fabricated precise playtime. " +
      "This is a provisional PLAN amendment, NOT approval to modify a protected record. " +
      "You may reorder only remaining pending assignments, refine a PENDING assignment " +
      "with a specific source-grounded outcome (narrow), split an UNSTARTED interactive " +
      "Milestone into an exact pair of Choice then Puzzle decision specialists, or add a " +
      "missing Event/Interactive/Composition unit for a Milestone present in the VERIFIED Architecture " +
      "scope. Each addition needs explicit causal dependency IDs and must remain within the " +
      "original depth and author goal. You may also add a verified Architecture Event-to-Event " +
      "prerequisite to an existing pending Event assignment with a depend action; " +
      "never change a completed assignment or remove existing dependencies. " +
      "'Puzzle' is a decision/possible no-write work unit, " +
      "not an obligation to invent a formal Puzzle. Do not ask routine author questions. " +
      "You MAY omit a still-pending interactive assignment ONLY when it appears in the " +
      "controller-authenticated Event-only omission candidate list below; that list is " +
      "reviewed source evidence, not blanket permission to erase Story-wide gameplay. " +
      "Each listed candidate already has a sealed no-write interactive receipt; you MUST " +
      "acknowledge each with a corresponding omit action rather than schedule a writer " +
      "which cannot run against that receipt. If no candidates are listed, omit none. " +
      "A local omission must not erase required choices, consequential routes, formal Puzzle " +
      "promises or explicit author-targeted work. Never invent or infer a new proof. " +
      "You cannot change a completed or blocked item, add a new canonical target ID, " +
      "or remove the final Story-wide independent review. " +
      "Prefer the minimal change: empty actions when current work is sound. " +
      "The controller will reject unsupported scope changes, invented grants, duplicate IDs, " +
      "missing dependencies and unreviewed omissions. " +
      "Every added Event needs its Character/World foundations; Interactive " +
      "must depend on its matching Milestone Event, and Composition on its " +
      "matching Interactive or Puzzle assessment. Additional cross-Milestone " +
      "dependencies must appear in these VERIFIED Architecture edges: " +
      JSON.stringify(typedEdges) + ". Never invent other causal edges. " +
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
      "\nController-authenticated independently reviewed Event-only omission candidates " +
      "(empty means no omits permitted): " + JSON.stringify(omissionCandidates) +
      "\nNative Milestone immutable planning/body projections eligible for narrowing " +
      "(sha256 hashes exclude only Event-owned completeness/fulfillment slots; not grants): " +
      JSON.stringify(sourceEvidence) +
      "\nProposal format: ONLY a JSON object with EXACT keys sourceSha, turnDigest, " +
      "beforeVersion, reason, actions, order. sourceSha=" + inventory.headSha +
      ", turnDigest=" + turn.digest + ", beforeVersion=" + version + ". " +
      "actions entries must be one of {kind:'add',stage:'event'|'interactive'|'composition'," +
      "milestone:'milestone.<slug>',dependsOn:['existing assignment id']}, " +
      "{kind:'split',item:'interactive:milestone.<slug>',domains:['choice','puzzle']}, " +
      "{kind:'depend',item:'event:milestone.<slug>',needs:'event:milestone.<prerequisite>'}, " +
      "{kind:'narrow',item:'pending assignment id',sourcePath:'listed Milestone path', " +
      "sourceHash:'listed sha256',outcome:'bounded goal within existing authority'}, or " +
      "{kind:'omit',item:'exact authenticated Event-only candidate assignment ID'}. " +
      "Narrowing evidence MUST be the selected assignment's own Milestone and " +
      "cannot grant any path, owner, protected decision or new canonical target. " +
      "Use strict JSON DOUBLE QUOTES. order MUST contain EVERY resulting pending ID " +
      "exactly once in dependency-safe order after all actions. " +
      "No omitted tasks, no extra keys, no invented milestones or quota assumptions.";
    await promptStorySpecialist(session, prompt);
    const reads = () => completedPinnedSkillReads(session.messages, project.root, snapshot.path);
    const missing = () => missingAdaptiveMethodReads(session.messages, project.root, snapshot.path, required);
    // A finished read-only turn can safely perform one bounded correction in
    // its ORIGINAL Pi session. An interrupted turn is never replayed, and a
    // model assertion is not proof of a successful skill read tool result.
    const first = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!first || first.role !== "assistant" || ["aborted", "error"].includes(first.stopReason))
      throw Error("Adaptive orchestrator model turn is interrupted; preserve the exact session without replay.");
    if (missing().length) {
      await context.beforeTurn(sessionFile);
      await promptStorySpecialist(session, adaptiveMethodCorrectionPrompt(missing()));
    }
    const skillReads = reads();
    if (missing().length)
      throw new InvalidAdaptiveProposalError("Adaptive orchestrator skipped required pinned methodology reads after same-session correction.");
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason !== "stop")
      throw Error("Adaptive orchestrator model turn is interrupted; preserve the exact session without replay.");
    await context.completed(sessionFile, session.sessionId);
    return { proposal: await initialAdaptiveResponse(job, session.getLastAssistantText() ?? "", sessionFile, session.sessionId), sessionFile, skillReads };
  } finally {
    session.dispose();
  }
}
