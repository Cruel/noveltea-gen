import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { loadSelectedStoryOrchestrator } from "./orchestrator-selection.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext, registerPendingPiSession, recordPiSession } from "./job-pi-policy.js";
import { reconcileReadOnlyProtocol } from "./non-specialist-protocol.js";
import { beginProtocolInvocation, recoverResponseContract, inspectCompletedProtocolReads, inspectCompletedProtocolResponse, type ResponseContractFailure } from "./response-contract-recovery.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { canonicalPinnedReadPath, correctReadOnlyPinnedMethodology } from "./pinned-skill-reads.js";
import { reportControllerReviewPhase } from "./controller-review-phase.js";
import { dependencyBoundary, dependencyTurn, dependencyDigest, saveDependencyPlan, blueprintSourceOf, inspectDependencyAdmission, DependencyAuthorizationRefusedError,
  type DependencyEntry, type DependencyPlan } from "./dependency-state.js";
import type { DependencyProposal } from "./dependency-amendments.js";

/** The model proposes semantic work, never an opaque source identity. Model
 * output may omit both identity fields; the trusted controller binds the
 * already verified report. Explicitly conflicting identity fields fail closed.
 * An explicit model rejection is never converted into a grant. */
export type DependencyPlanningResponse = DependencyProposal | { rejected: true; reason: string };

const guidance = ["nt-story-orchestrate/SKILL.md", "nt-story-orchestrate/references/planning.md",
  "nt-catalog/SKILL.md", "nt-catalog/references/records.md", "nt-catalog/references/authority-and-validation.md"] as const;

export function bindDependencyProposalIdentity(
  proposal: DependencyPlanningResponse,
  entry: Pick<DependencyEntry, "report" | "reportDigest">,
): DependencyPlanningResponse {
  if ("rejected" in proposal) return proposal;
  if (
    (proposal.sourceSha !== undefined && proposal.sourceSha !== entry.report.sourceSha) ||
    (proposal.reportDigest !== undefined && proposal.reportDigest !== entry.reportDigest) ||
    (proposal.sourceSha === undefined) !== (proposal.reportDigest === undefined)
  )
    throw Error("Dependency model proposed an untrusted or incomplete source identity.");
  return { ...proposal, sourceSha: entry.report.sourceSha, reportDigest: entry.reportDigest };
}

/** Shape errors alone consume the protocol allowance. Scope and causal
 * disagreements remain controller admission failures, not format retries. */
export function inspectDependencyProposalResponse(text: string, reviewCharacter: boolean, blueprint = false): ResponseContractFailure[] {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return [{ path: "$", expected: "one complete JSON object" }]; }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "$", expected: "proposal or rejection object" }];
  const v = value as Record<string, unknown>;
  const fields = v.rejected === true ? ["rejected", "reason"] :
    ["target", "specialist", "outcome", "reason", ...(reviewCharacter ? ["title"] : []), ...(blueprint ? ["arcIds"] : [])];
  const failures: ResponseContractFailure[] = [];
  if (Object.keys(v).some(k => !fields.includes(k) && !["sourceSha", "reportDigest"].includes(k)))
    failures.push({ path: "$", expected: "no undeclared proposal fields" });
  for (const key of fields.filter(k => k !== "rejected"))
    if (key === "arcIds" ? !Array.isArray(v[key]) || !(v[key] as unknown[]).length ||
        (v[key] as unknown[]).some(id => typeof id !== "string" || !id.trim())
      : typeof v[key] !== "string" || !(v[key] as string).trim())
      failures.push({ path: "$." + key, expected: key === "arcIds" ? "nonempty array of typed Arc IDs" : "nonempty string" });
  if (v.rejected === true && Object.keys(v).some(k => !fields.includes(k)))
    failures.push({ path: "$", expected: "rejected and reason only" });
  for (const key of ["sourceSha", "reportDigest"])
    if (Object.hasOwn(v, key) && typeof v[key] !== "string")
      failures.push({ path: "$." + key, expected: "string" });
  return failures.slice(0, 8);
}

/** Invoked under the shared writer lock at a clean boundary. Model output is
 * only a proposal; approveDependency independently checks source and scope. */
export async function proposeDependency(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, provider: string, model: string): Promise<DependencyPlanningResponse> {
  if (entry.phase !== "reported" && entry.phase !== "planning") throw Error("Dependency planner is not at its original admission boundary.");
  const turn = await dependencyTurn(job);
  if (await dependencyBoundary(job) !== entry.report.sourceSha) throw Error("Stale dependency planning source.");
  const reviewRequest = entry.reviewSourceSha ? plan.reviewRequests?.find(r =>
    r.sourceSha === entry.reviewSourceSha) : undefined;
  const blueprint = blueprintSourceOf(entry);
  const reviewCharacter = !!blueprint || reviewRequest?.classification === "new-full-story-record";
  if (entry.reviewSourceSha && (!reviewRequest ||
      reviewRequest.action !== "controller-amendment-required"))
    throw Error("Review dependency planner lost its sealed controller request.");
  const hint = JSON.parse(await readFile(join(job.stateDir, "orchestrator-selection.json"), "utf8"));
  const selection = await loadSelectedStoryOrchestrator(job, hint.graphThreadId,
    { task: turn.originalRequest, kind: turn.contract.scope.kind, turnPlanDigest: turn.digest });
  const snapshot = selection.receipt.skillSnapshot;
  const dir = join(job.stateDir, "dependency-sessions", entry.reportDigest, "plan");
  const protocol = { receiptFile: join(dir, "response"), sourceDigest: dependencyDigest({
    jobId: job.jobId, threadId: job.threadId, turn: turn.digest, report: entry.reportDigest,
    source: entry.report.sourceSha, version: plan.version, snapshot: snapshot.id, provider, model,
  }), contract: "dependency.proposal.v1", sessionRoots: [dir],
    validate: (text: string) => inspectDependencyProposalResponse(text, reviewCharacter, !!blueprint),
    parse: (text: string) => JSON.parse(text.trim()) as DependencyPlanningResponse };
  if (entry.phase === "planning") {
    if (!entry.planner || entry.planner.snapshot.id !== snapshot.id)
      throw Error("Original dependency planner snapshot is missing or changed.");
    const proposal = await reconcileReadOnlyProtocol(job, protocol, { provider, model },
      "dependency-plan:" + entry.reportDigest, async () => {
        if (await dependencyBoundary(job) !== entry.report.sourceSha)
          throw Error("Original dependency source changed.");
      }, entry.planner.sessionFile);
    const proof = await inspectCompletedProtocolReads(protocol);
    const reads = proof.reads.map(path => canonicalPinnedReadPath(path, job.worktreeStoryRoot, snapshot.path));
    if (proof.sessionFile !== entry.planner.sessionFile ||
        guidance.some(p => !reads.includes(join(snapshot.path, "skills", p))))
      throw Error("Original dependency planner source inspection changed.");
    entry.planner.skillReads = reads;
    await recordPiSession(job, proof.sessionFile);
    await saveDependencyPlan(job, plan);
    return bindDependencyProposalIdentity(proposal, entry);
  }
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
    directory: dir,
  }, runtime);
  const tools = await selectSandboxPiTools(job, snapshot, loader.getSkills().skills, undefined, "read-only", "orchestrator");
  const { session } = await createAgentSession({ cwd: project.root, modelRuntime: runtime,
    model: context.model, thinkingLevel: context.thinking, resourceLoader: loader, settingsManager,
    sessionManager: context.manager, customTools: tools ?? [], noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS] });
  try {
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile || context.thinking && context.thinking !== session.thinkingLevel)
      throw Error("Dependency planner lacks a durable session or pinned model policy.");
    await context.beforeTurn(sessionFile);
    entry.phase = "planning"; entry.planner = { snapshot, sessionFile };
    await saveDependencyPlan(job, plan);
    await beginProtocolInvocation({ ...protocol, session });
    await registerPendingPiSession(job, sessionFile);
    await promptStorySpecialist(session, context.contextNote +
      "You are the READ-ONLY dependency orchestrator. The complete original " +
      "approved author request, NOT its first sentence or a generic summary, " +
      "is the authoritative requirement to compare against the sealed review. " +
      "Read it verbatim before deciding whether an omitted Character was " +
      "actually requested. ORIGINAL USER REQUEST: " + JSON.stringify(turn.originalRequest) +
      "\nFirst read these pinned methods:\n" +
      guidance.map(p => "skill://" + p).join("\n") +
      "\nInspect the cited canonical Story sources. No private inbox access. Determine whether the reported " +
      "prerequisite is causally NECESSARY for the exact original obligation, not optional enrichment. " +
      "Reject protected retcons, material objective changes and unrelated enhancements. " +
      "A source-bound addition to a canonical Event's existing inspection step may establish actual " +
      "knowledge through a typed knowledge effect; do not conflate that bounded on-screen " +
      "causal correction with inventing an off-page occurrence or granting new-record authority. " +
      (blueprint
        ? "This is an independently reviewed prospective prerequisite. Choose only the necessary " +
          "enclosing Arcs from the authenticated canonical candidate IDs below; inspect the actual " +
          "Milestone and all candidates, and choose the narrowest source-grounded links. " +
          "The Character ID is already fixed by the approved Blueprint; reuse it unchanged if it exists, otherwise create it. Do not rename it or create " +
          "another record. Do not add an Arc link merely because it is a candidate. " +
          "Return ONLY JSON {target,specialist,title,arcIds,outcome,reason}, where arcIds are the " +
          "canonical typed IDs, never filenames. If no bounded causal choice is justified, reject. " +
          "Authenticated candidates and required target: " + JSON.stringify(blueprint) + "\n"
        : reviewCharacter && reviewRequest
        ? "This is a SEALED negative review for a missing central Character under the existing approved " +
          "whole-Story objective, not a request to widen scope. This is an OMISSION " +
          "finding: the named Character may have NO record or mention in the " +
          "existing Event precisely because the original owner omitted required " +
          "work. Absence from existing Event prose is NOT evidence that the " +
          "approved author Turn omitted that requirement. Compare the explicit " +
          "original user objective supplied below to the sealed negative finding " +
          "and existing Character inventory; reject if the author did not require " +
          "the Character or if an existing record already fulfills the role. " +
          "First inspect the cited " +
          (reviewRequest.originalWorkItem.startsWith("event-") ? "Event" : "Arc") +
          " and existing Characters. Reject a duplicate or irrelevant new Character, invented " +
          "history, protected retcon, or unearned knowledge. You cannot grant write authority. " +
          "If necessary return ONLY JSON {target,specialist,title,outcome,reason}: " +
          "target is ONE newly chosen unused typed character.slug ID (not a path), title is a concise " +
          "Character title, specialist is nt-character-development, and outcome must copy the " +
          "report's missing work. The controller separately verifies the exact new path/ID " +
          (reviewRequest.originalWorkItem.startsWith("event-")
            ? "and assigns an Event-only participant/prose correction to its original Event owner " +
              "AFTER independent review of the new Character. No Event write grant belongs to you. "
            : "and the one existing Arc's link-only field. ") :
          "You cannot grant authority. Only one directly connected EXISTING record, owned by the proper different " +
          "specialist, can be proposed. New records or changes to protected decisions require separate approval. " +
          "If necessary, return ONLY JSON {target,specialist,outcome,reason}. " +
          "Target MUST be an existing typed canonical ID from the report's affectedIds " +
          "(for example event.ledger-disclosure), NEVER a filesystem path like events/ledger-disclosure.md. ") +
      "COPY the exact report.missing string as outcome, verbatim, not a paraphrase or a new directive; " +
      "explain the independently verified causal repair ONLY in reason. " +
      "Do NOT include sourceSha or reportDigest in the JSON response. These opaque " +
      "identifiers already belong to the controller; it binds them from the saved " +
      "ledger after independently checking the proposal. You decide only whether " +
      "the work is necessary and its bounded target, specialist and rationale. " +
      "Do NOT reject only because a digest is absent from the model evidence. " +
      "If causally unnecessary, protected or unsafe, return " +
      "{rejected: true, reason: ...}; the controller never manufactures a grant.\n" +
      "Original objective and delivery criteria: " + JSON.stringify({ goal: turn.goal, objective: turn.objective }) +
      "\nOriginal assignments: " + JSON.stringify(turn.assignments) +
      "\nDependency evidence: " + JSON.stringify(entry.report) +
      (reviewRequest ? "\nSealed reviewer request: " + JSON.stringify(reviewRequest) : ""));
    const completedReads = () => {
      const completed = new Set(session.messages.filter(m => m.role === "toolResult" && !m.isError)
        .map(m => m.role === "toolResult" ? m.toolCallId : ""));
      return session.messages.flatMap(m => m.role === "assistant" ? m.content.flatMap(c =>
        c.type === "toolCall" && c.name === "read" && completed.has(c.id)
          ? [canonicalPinnedReadPath(String(c.arguments.path ?? ""), project.root, snapshot.path)] : []) : []);
    };
    const settle = async () => {
      const last = session.messages.at(-1);
      if (!last || last.role !== "assistant" || last.stopReason !== "stop")
        throw Error("Dependency planner was interrupted.");
      await recordPiSession(job, sessionFile);
    };
    await settle();
    await correctReadOnlyPinnedMethodology({
      session, root: project.root, snapshotRoot: snapshot.path, resources: guidance,
      expectedResponse: "the complete original dependency proposal or rejection JSON, with the original contract's exact keys",
      beforeCorrection: async () => {
        if (await dependencyBoundary(job) !== entry.report.sourceSha) throw Error("Dependency source changed.");
        await context.beforeTurn(sessionFile);
        await reportControllerReviewPhase("correcting", { activity: "source-read-correction", role: "planner",
          reason: "Dependency proposal lacks required pinned methodology reads." });
        await registerPendingPiSession(job, sessionFile);
      },
      prompt: async feedback => {
        await promptStorySpecialist(session, feedback);
        await settle();
        if (await dependencyBoundary(job) !== entry.report.sourceSha) throw Error("Dependency source changed.");
      },
    });
    entry.planner.skillReads = completedReads();
    await saveDependencyPlan(job, plan);
    const proposal = await recoverResponseContract({ ...protocol, session,
      receiptFile: protocol.receiptFile + ".initial.json", sealTranscript: true,
      beforeCorrection: () => context.beforeTurn(sessionFile),
      prompt: async feedback => {
        await registerPendingPiSession(job, sessionFile);
        await promptStorySpecialist(session, feedback);
        await settle();
      },
      feedback: failures => "Correct only the JSON format of the original dependency proposal or rejection. " +
        "Preserve the actual decision, scope and causal evidence. No tools or new planning. " +
        failures.map(f => f.path + ": " + f.expected).join("; "),
    });
    if (await dependencyBoundary(job) !== entry.report.sourceSha) throw Error("Dependency source changed.");
    await context.completed(sessionFile, session.sessionId);
    return bindDependencyProposalIdentity(proposal, entry);
  } finally { session.dispose(); }
}

/** An unresolved plan may never confer a writer grant. Reauthenticate its
 * original accepted read-only protocol, including pinned source and reads. */
export async function inspectDependencyPlanningRefusal(job: JobStartResult, plan: DependencyPlan,
  entry: DependencyEntry, provider: string, model: string, validatorSource?: string): Promise<boolean> {
  if (entry.phase !== "rejected" || entry.amendment || entry.approval || entry.commitSha ||
      !entry.planner || !entry.rejection ||
      !["planning-needed", "authorization-refused"].includes(entry.rejection.kind ?? "")) return false;
  const turn = await dependencyTurn(job);
  const index = plan.entries.indexOf(entry);
  if (index < 0) return false;
  const version = 1 + plan.entries.slice(0, index).filter(e => e.amendment).length;
  const hint = JSON.parse(await readFile(join(job.stateDir, "orchestrator-selection.json"), "utf8"));
  const selection = await loadSelectedStoryOrchestrator(job, hint.graphThreadId,
    { task: turn.originalRequest, kind: turn.contract.scope.kind, turnPlanDigest: turn.digest });
  const snapshot = selection.receipt.skillSnapshot;
  if (snapshot.id !== entry.planner.snapshot.id) return false;
  const dir = join(job.stateDir, "dependency-sessions", entry.reportDigest, "plan");
  const blueprint = blueprintSourceOf(entry);
  const reviewCharacter = !!blueprint || plan.reviewRequests?.find(r =>
    r.sourceSha === entry.reviewSourceSha)?.classification === "new-full-story-record";
  const protocol = { receiptFile: join(dir, "response"), sourceDigest: dependencyDigest({
    jobId: job.jobId, threadId: job.threadId, turn: turn.digest, report: entry.reportDigest,
    source: entry.report.sourceSha, version, snapshot: snapshot.id, provider, model,
  }), contract: "dependency.proposal.v1", sessionRoots: [dir],
    validate: (text: string) => inspectDependencyProposalResponse(text, reviewCharacter, !!blueprint),
    parse: (text: string) => JSON.parse(text.trim()) as DependencyPlanningResponse };
  const response = await inspectCompletedProtocolResponse({ ...protocol, requireSealedTranscript: true });
  const proof = await inspectCompletedProtocolReads(protocol);
  const reads = proof.reads.map(path => canonicalPinnedReadPath(path, job.worktreeStoryRoot, snapshot.path));
  const bound = bindDependencyProposalIdentity(response, entry);
  if (proof.sessionFile !== entry.planner.sessionFile ||
      guidance.some(p => !reads.includes(join(snapshot.path, "skills", p))) ||
      JSON.stringify(reads) !== JSON.stringify(entry.planner.skillReads) ||
      JSON.stringify(bound) !== JSON.stringify(entry.rejection.proposal)) return false;
  if ("rejected" in bound)
    return entry.rejection.kind === "planning-needed" && bound.reason === entry.rejection.reason;
  if (entry.rejection.kind !== "authorization-refused") return false;
  try { await inspectDependencyAdmission(job, plan, entry, bound, validatorSource, true); }
  catch (error) { return error instanceof DependencyAuthorizationRefusedError && error.message === entry.rejection.reason; }
  return false;
}
