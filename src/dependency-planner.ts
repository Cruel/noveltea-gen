import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { dependencyBoundary, dependencyTurn, saveDependencyPlan,
  type DependencyEntry, type DependencyPlan } from "./dependency-state.js";
import type { DependencyProposal } from "./dependency-amendments.js";

/** Invoked under the shared writer lock at a clean boundary. Model output is
 * only a proposal; approveDependency independently checks source and scope. */
export async function proposeDependency(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, provider: string, model: string): Promise<DependencyProposal> {
  if (entry.phase !== "reported") throw Error("Interrupted dependency planner; preserve transcript, do not replay.");
  const turn = await dependencyTurn(job);
  if (await dependencyBoundary(job) !== entry.report.sourceSha) throw Error("Stale dependency planning source.");
  const hint = JSON.parse(await readFile(join(job.stateDir, "orchestrator-selection.json"), "utf8"));
  const selection = await loadSelectedStoryOrchestrator(job, hint.graphThreadId,
    { task: turn.originalRequest, kind: turn.contract.scope.kind, turnPlanDigest: turn.digest });
  const snapshot = selection.receipt.skillSnapshot;
  const project = await openStoryProject(job.worktreeStoryRoot);
  const { loader, settingsManager } = createProjectResourceLoader(project, undefined, true,
    { discovery: "explicit-only", novelteaSkills: snapshot.path, skillDirs: [],
      requiredSkills: ["nt-story-orchestrate", "nt-catalog"] }, [], "orchestrator");
  await loader.reload();
  if (loader.getSkills().diagnostics.some(d => d.type === "error")) throw Error("Dependency planner lacks pinned skills.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(job, project, {
    group: "orchestrator:dependency", step: "dependency-plan:" + entry.reportDigest,
    paths: entry.report.sources.map(s => s.path), snapshot: snapshot.id, provider, model,
    directory: join(job.stateDir, "dependency-sessions", entry.reportDigest, "plan"),
  }, runtime);
  const tools = await selectSandboxPiTools(job, snapshot, loader.getSkills().skills, undefined, "read-only", "orchestrator");
  const { session } = await createAgentSession({ cwd: project.root, modelRuntime: runtime,
    model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: tools ?? [], noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS] });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile || context.thinking && context.thinking !== session.thinkingLevel)
      throw Error("Dependency planner lacks a durable session or pinned model policy.");
    entry.phase = "planning"; entry.planner = { snapshot, sessionFile };
    await saveDependencyPlan(job, plan);
    await context.beforeTurn(sessionFile);
    const guidance = ["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
      "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"];
    await promptStorySpecialist(session, context.contextNote +
      "You are the READ-ONLY dependency orchestrator. First read these pinned methods:\n" +
      guidance.map(p => "skill://" + p).join("\n") +
      "\nInspect the cited canonical Story sources. No private inbox access. Determine whether the reported " +
      "prerequisite is causally NECESSARY for the exact original obligation, not optional enrichment. " +
      "Reject protected retcons, material objective changes, invented IDs and unrelated enhancements. " +
      "A source-bound addition to a canonical Event's existing inspection step may establish actual " +
      "knowledge through a typed knowledge effect; do not conflate that bounded on-screen " +
      "causal correction with inventing an off-page occurrence or granting new-record authority. " +
      "You cannot grant authority. Only one directly connected EXISTING record, owned by the proper different " +
      "specialist, can be proposed. New records or changes to protected decisions require separate approval. " +
      "If necessary, return ONLY JSON {sourceSha,reportDigest,target,specialist,outcome,reason}. " +
      "Target MUST be an existing typed canonical ID from the report's affectedIds " +
      "(for example event.ledger-disclosure), NEVER a filesystem path like events/ledger-disclosure.md. " +
      "COPY the exact report.missing string as outcome, verbatim, not a paraphrase or a new directive; " +
      "explain the independently verified causal repair ONLY in reason. " +
      "Use the exact sourceSha and reportDigest provided. If unnecessary or unsafe return " +
      "{rejected: true, reason: ...}; the controller will block, never manufacture a grant.\n" +
      "Original objective and delivery criteria: " + JSON.stringify({ goal: turn.goal, objective: turn.objective }) +
      "\nOriginal assignments: " + JSON.stringify(turn.assignments) +
      "\nDependency evidence: " + JSON.stringify(entry.report) + "\nReport digest: " + entry.reportDigest);
    const completedReads = () => {
      const completed = new Set(session.messages.filter(m => m.role === "toolResult" && !m.isError)
        .map(m => m.role === "toolResult" ? m.toolCallId : ""));
      return session.messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(c =>
        c.type === "toolCall" && c.name === "read" && completed.has(c.id)
          ? [canonicalPinnedReadPath(String(c.arguments.path ?? ""), project.root, snapshot.path)] : []) : []);
    };
    const missingReads = () => guidance.map(p => join(snapshot.path, "skills", p))
      .filter(p => !completedReads().includes(p));
    if (missingReads().length) {
      await promptStorySpecialist(session, "You omitted required pinned orchestrator methodology reads. " +
        "Read EVERY exact file below with the read tool, then independently reconsider the " +
        "causal necessity and return a fresh JSON proposal or rejection. " +
        "Do not modify files or assume the previous answer was correct.\nMISSING READS:\n" +
        missingReads().join("\n"));
    }
    const last = [...session.messages].reverse().find(m => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw Error("Dependency planner was interrupted.");
    const reads = completedReads();
    if (missingReads().length)
      throw Error("Dependency planner did not read pinned methodology.");
    entry.planner.skillReads = reads;
    await saveDependencyPlan(job, plan);
    const lastJson = () => JSON.parse((session.getLastAssistantText() ?? "").trim()
      .replace(/^```(?:json)?\s*\n/i, "").replace(/\n```$/, "")) as DependencyProposal;
    let proposal = lastJson();
    if (proposal && (proposal.outcome !== undefined && proposal.outcome !== entry.report.missing ||
        typeof proposal.target === "string" && !entry.report.affectedIds.includes(proposal.target))) {
      await promptStorySpecialist(session, "Your proposal used an altered missing-work outcome or " +
        "a target that is not an exact typed canonical ID from the evidence. " +
        "Reassess the report and return one fresh JSON proposal only if necessary. " +
        "Copy missing EXACTLY as outcome, choose target as an existing typed record ID " +
        "(NEVER a .md path), and put your causal reasoning in reason. " +
        "Return a rejection if this cannot be safely done. " +
        "Exact missing work: " + JSON.stringify(entry.report.missing) +
        "; allowed affected IDs: " + JSON.stringify(entry.report.affectedIds));
      proposal = lastJson();
    }
    await context.completed(sessionFile, session.sessionId);
    return proposal;
  } finally { session.dispose(); }
}
