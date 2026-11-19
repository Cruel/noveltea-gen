/** Pinned, read-only model planning of a controller-authorized Turn objective.
 *
 * The portable method informs assignment ordering and rationale; it never
 * creates a write grant. The original author objective, source, obligations and
 * exact allowed assignments are controller-owned in turn-plan.json.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import type { TurnEvidence } from "./turn-plan-evidence.js";
import type { StoryOrchestratorSelection } from "./orchestrator-selection.js";
import { openStoryProject } from "./project.js";
import { createProjectResourceLoader } from "./pi.js";
import { createJobModelRuntime } from "./model-runtime.js";
import { preparePiContext } from "./job-pi-policy.js";
import { selectSandboxPiTools, SANDBOX_READ_ONLY_TOOLS } from "./sandbox-pi-tools.js";
import { canonicalPinnedReadPath } from "./pinned-skill-reads.js";
import { requiredOrchestratorSkillReads } from "./story-skill-policy.js";
import { promptStorySpecialist } from "./story-interruption.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";
import { readChatApprovedFoundation } from "./chat-approved-foundation.js";
import { beginProtocolInvocation, inspectCompletedProtocolResponse,
  inspectCompletedProtocolReads, ProtocolIntegrityBlockedError,
  recoverWithOneFreshSession, type ResponseContractFailure } from "./response-contract-recovery.js";

const requiredFor = (plan: TurnEvidence): readonly string[] =>
  requiredOrchestratorSkillReads(plan.creativePolicy?.mode ?? "autonomous");
const SCHEMA = "noveltea-objective-planning/v1" as const;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathFor = (job: JobStartResult) => join(job.stateDir, "objective-planning.json");

export type OrchestratorProposal = {
  sourceSha: string;
  turnDigest: string;
  assignments: Array<{ id: string; reason: string }>;
};
export type OrchestratorPlanningReceipt = {
  schema: typeof SCHEMA;
  jobId: string;
  threadId: string;
  sourceSha: string;
  turnDigest: string;
  methodSha256: string;
  snapshotId: string;
  provider: string;
  model: string;
  phase: "planning" | "planned";
  sessionFile: string;
  proposal?: OrchestratorProposal;
  skillReads?: string[];
  digest: string;
};

/** The model may only reorder already authorized assignments. It must neither
 * omit delivery obligations nor insert new tasks, even when its proposal sounds
 * useful. Missing dependencies go to a separate controller-amendment workflow. */
export function verifyOrchestratorProposal(value: unknown, plan: TurnEvidence): OrchestratorProposal {
  const proposal = value as OrchestratorProposal | null;
  if (
    !proposal ||
    typeof proposal !== "object" ||
    Array.isArray(proposal) ||
    Object.keys(proposal).sort().join(",") !== "assignments,sourceSha,turnDigest" ||
    proposal.sourceSha !== plan.source.verifiedSha ||
    proposal.turnDigest !== plan.digest ||
    !Array.isArray(proposal.assignments) ||
    proposal.assignments.length !== plan.assignments.length
  )
    throw new Error("Orchestrator proposal changed the source or authorized assignment set.");
  const known = new Map(plan.assignments.map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const item of proposal.assignments) {
    const assignment = known.get(item?.id);
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "id,reason" ||
      !assignment ||
      seen.has(item.id) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      item.reason.length > 1000 ||
      assignment.dependsOn.some((parent) => !seen.has(parent))
    )
      throw new Error("Orchestrator proposal has unauthorized, duplicate or dependency-inverted work.");
    seen.add(item.id);
  }
  if (seen.size !== known.size)
    throw new Error("Orchestrator omitted a controller-approved delivery assignment.");
  return {
    sourceSha: proposal.sourceSha,
    turnDigest: proposal.turnDigest,
    assignments: proposal.assignments.map((a) => ({ id: a.id, reason: a.reason.trim() })),
  };
}

const seal = (receipt: Omit<OrchestratorPlanningReceipt, "digest">): OrchestratorPlanningReceipt => ({
  ...receipt,
  digest: sha(receipt),
});

function verifyReceipt(
  receipt: OrchestratorPlanningReceipt,
  job: JobStartResult,
  selection: StoryOrchestratorSelection,
  plan: TurnEvidence,
  provider: string,
  model: string,
): OrchestratorPlanningReceipt {
  const { digest, ...body } = receipt ?? ({} as OrchestratorPlanningReceipt);
  if (
    receipt?.schema !== SCHEMA ||
    receipt.jobId !== job.jobId ||
    receipt.threadId !== job.threadId ||
    receipt.sourceSha !== job.baseSha ||
    receipt.turnDigest !== plan.digest ||
    receipt.methodSha256 !== selection.receipt.skillEntrypointSha256 ||
    receipt.snapshotId !== selection.receipt.skillSnapshot.id ||
    receipt.provider !== provider ||
    receipt.model !== model ||
    (receipt.phase !== "planning" && receipt.phase !== "planned") ||
    typeof receipt.sessionFile !== "string" ||
    !receipt.sessionFile ||
    digest !== sha(body)
  )
    throw new Error("Pinned orchestration planning receipt is corrupt, stale or belongs to another writer.");
  if (receipt.phase === "planned") {
    verifyOrchestratorProposal(receipt.proposal, plan);
    const required = requiredFor(plan).map((p) => join(selection.receipt.skillSnapshot.path, "skills", p));
    if (!Array.isArray(receipt.skillReads) || required.some((p) => !receipt.skillReads!.includes(p)))
      throw new Error("Orchestration planning lacks verified pinned method reads.");
  }
  return receipt;
}

export async function readPinnedObjectivePlanning(
  job: JobStartResult,
  selection: StoryOrchestratorSelection,
  plan: TurnEvidence,
  provider: string,
  model: string,
): Promise<OrchestratorPlanningReceipt> {
  const raw = JSON.parse(await readFile(pathFor(job), "utf8")) as OrchestratorPlanningReceipt;
  return verifyReceipt(raw, job, selection, plan, provider, model);
}

/** A durable parent checkpoint is proof a model turn already settled. Only
 * restore its exact receipt; missing evidence cannot authorize another call. */
export async function restoreCheckpointedObjectivePlanning(
  job: JobStartResult,
  selection: StoryOrchestratorSelection,
  plan: TurnEvidence,
  provider: string,
  model: string,
  checkpointDigest: string | null | undefined,
  checkpointOrder: string[],
): Promise<OrchestratorPlanningReceipt> {
  if (!checkpointDigest || !/^[a-f0-9]{64}$/.test(checkpointDigest))
    throw new Error(
      "Checkpointed objective planner lacks its original receipt digest; model replay refused.",
    );
  let saved: OrchestratorPlanningReceipt;
  try {
    saved = await readPinnedObjectivePlanning(job, selection, plan, provider, model);
  } catch {
    throw new Error(
      "Checkpointed objective planning receipt is missing, corrupt or stale; model replay refused.",
    );
  }
  if (
    saved.phase !== "planned" ||
    saved.digest !== checkpointDigest ||
    JSON.stringify(saved.proposal?.assignments.map((a) => a.id)) !== JSON.stringify(checkpointOrder)
  )
    throw new Error("Checkpointed objective planning receipt differs from the original model turn.");
  return saved;
}

function parseText(text: string): unknown {
  const raw = text
    .trim()
    .replace(/^\x60\x60\x60(?:json)?\s*\n/i, "")
    .replace(/\n\x60\x60\x60\s*$/, "");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Orchestrator did not return the required bounded assignment proposal JSON.");
  }
}

/** Exact path-only feedback; controller verification still owns the work plan. */
export function inspectOrchestratorProposal(text: string, plan: TurnEvidence): ResponseContractFailure[] {
  let value: unknown;
  try { value = parseText(text); }
  catch { return [{ path: "$.JSON", expected: "one complete parseable JSON object" }]; }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return [{ path: "$.JSON", expected: "JSON object with sourceSha, turnDigest, assignments" }];
  const obj = value as Record<string, unknown>;
  const failures: ResponseContractFailure[] = [];
  if (Object.keys(obj).sort().join(",") !== "assignments,sourceSha,turnDigest")
    failures.push({ path: "$", expected: "exactly sourceSha, turnDigest, assignments keys" });
  if (obj.sourceSha !== plan.source.verifiedSha)
    failures.push({ path: "$.sourceSha", expected: "exact controller-pinned verified source SHA" });
  if (obj.turnDigest !== plan.digest)
    failures.push({ path: "$.turnDigest", expected: "exact controller-pinned Turn digest" });
  if (!Array.isArray(obj.assignments) || obj.assignments.length !== plan.assignments.length) {
    failures.push({ path: "$.assignments", expected: "complete authorized assignment array, each ID exactly once" });
  } else {
    const known = new Map(plan.assignments.map(a => [a.id, a]));
    const seen = new Set<string>();
    for (const [index, item] of obj.assignments.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          Object.keys(item).sort().join(",") !== "id,reason" ||
          !known.has(item.id) || seen.has(item.id) ||
          typeof item.reason !== "string" || !item.reason.trim() ||
          item.reason.length > 1000 ||
          known.get(item.id)!.dependsOn.some(parent => !seen.has(parent))) {
        failures.push({ path: "$.assignments[" + index + "]",
          expected: "unique authorized ID, nonempty reason (up to 1000 chars), causal dependency order" });
      }
      if (item && typeof item.id === "string") seen.add(item.id);
    }
  }
  if (!failures.length) {
    try { verifyOrchestratorProposal(value, plan); }
    catch { failures.push({ path: "$.assignments",
      expected: "all authorized IDs once in dependency order, no expanded scope" }); }
  }
  return failures.slice(0, 8);
}

/** Session is replay-safe. A partially delivered model turn is preserved for
 * manual reconciliation instead of generating a second, competing plan. */
export async function runPinnedObjectivePlanner(
  job: JobStartResult,
  selection: StoryOrchestratorSelection,
  plan: TurnEvidence,
  provider: string,
  model: string,
): Promise<OrchestratorPlanningReceipt> {
  if (
    plan.source.verifiedSha !== job.baseSha ||
    !plan.objective ||
    selection.receipt.storySourceSha !== job.baseSha ||
    selection.receipt.turnPlanDigest !== plan.digest
  )
    throw new Error("Orchestrator planning requires an exact source-bound modern Turn plan.");
  if (existsSync(pathFor(job))) {
    const saved = await readPinnedObjectivePlanning(job, selection, plan, provider, model);
    if (saved.phase === "planned") return saved;
    const receiptFile = join(job.stateDir, "objective-plan-protocol");
    const sessionRoots = [join(job.stateDir, "orchestrator-planning-sessions"),
      join(job.stateDir, "orchestrator-planning-fresh-sessions")];
    const proposal = await inspectCompletedProtocolResponse({
      receiptFile, sourceDigest: plan.digest, contract: "orchestrator.work-plan.v1",
      sessionRoots, validate: text => inspectOrchestratorProposal(text, plan),
      parse: text => verifyOrchestratorProposal(parseText(text), plan),
    });
    const evidence = await inspectCompletedProtocolReads({
      receiptFile, sourceDigest: plan.digest, contract: "orchestrator.work-plan.v1",
      sessionRoots,
    });
    const required = requiredFor(plan).map(p => join(selection.receipt.skillSnapshot.path, "skills", p));
    const readPaths = evidence.reads.map(path =>
      canonicalPinnedReadPath(path, job.worktreeStoryRoot, selection.receipt.skillSnapshot.path));
    if (required.some(path => !readPaths.includes(path)))
      throw new ProtocolIntegrityBlockedError("Recovered planner omitted its original pinned skill reads");
    const { digest: _priorDigest, ...original } = saved;
    const finished = seal({ ...original, phase: "planned", sessionFile: evidence.sessionFile,
      proposal, skillReads: readPaths });
    await writeFile(pathFor(job), JSON.stringify(finished, null, 2) + "\n", { mode: 0o600 });
    return verifyReceipt(finished, job, selection, plan, provider, model);
  }
  const project = await openStoryProject(job.worktreeStoryRoot);
  const snapshot = selection.receipt.skillSnapshot;
  const { loader, settingsManager } = createProjectResourceLoader(
    project,
    undefined,
    true,
    {
      discovery: "explicit-only",
      novelteaSkills: snapshot.path,
      skillDirs: [],
      requiredSkills: ["nt-story-orchestrate", "nt-catalog", "nt-story-discovery",
        ...(plan.creativePolicy?.mode === "collaborative" ? ["nt-story-collaborate"] : [])],
    },
    [],
    "orchestrator",
    plan.creativePolicy?.mode === "collaborative",
  );
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (
    diagnostics.some((d) => d.type === "error") ||
    ["nt-story-orchestrate", "nt-catalog",
      ...(plan.creativePolicy?.mode === "collaborative" ? ["nt-story-collaborate"] : [])].some(
      (name) =>
        !skills.some((s) => s.name === name && s.filePath.startsWith(join(snapshot.path, "skills") + sep)),
    )
  )
    throw new Error("Pinned orchestrator and catalog skills are unavailable for planning.");
  const runtime = await createJobModelRuntime();
  const context = await preparePiContext(
    job,
    project,
    {
      group: "orchestrator:objective",
      step: "orchestrator:objective:" + plan.digest,
      paths: [],
      snapshot: snapshot.id,
      provider,
      model,
      directory: join(job.stateDir, "orchestrator-planning-sessions"),
    },
    runtime,
  );
  // Resource discovery and sandbox reads enforce the same Turn-scoped role policy.
  // A model cannot opt into the optional method through skill discovery.
  const visible = skills;
  const tools = await selectSandboxPiTools(job, snapshot, visible, undefined, "read-only", "orchestrator");
  const { session } = await createAgentSession({
    cwd: project.root,
    modelRuntime: runtime,
    model: context.model,
    thinkingLevel: context.thinking,
    resourceLoader: loader,
    settingsManager,
    sessionManager: context.manager,
    customTools: tools ?? [],
    noTools: "all",
    tools: [...SANDBOX_READ_ONLY_TOOLS],
  });
  try {
    if (context.thinking && session.thinkingLevel !== context.thinking)
      throw new Error("Orchestrator did not honor the pinned model policy.");
    const file = session.sessionManager.getSessionFile();
    if (!file) throw new Error("Orchestrator cannot persist its read-only planning transcript.");
    const original: Omit<OrchestratorPlanningReceipt, "digest"> = {
      schema: SCHEMA,
      jobId: job.jobId,
      threadId: job.threadId,
      sourceSha: job.baseSha,
      turnDigest: plan.digest,
      methodSha256: selection.receipt.skillEntrypointSha256,
      snapshotId: snapshot.id,
      provider,
      model,
      phase: "planning",
      sessionFile: file,
    };
    await writeFile(pathFor(job), JSON.stringify(seal(original), null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await context.beforeTurn(file);
    await beginProtocolInvocation({ receiptFile: join(job.stateDir, "objective-plan-protocol"),
      sourceDigest: plan.digest, contract: "orchestrator.work-plan.v1", session });
    const currentHead = await trustedHead(job);
    const approvedFoundation = await readChatApprovedFoundation(job);
    const foundationCommitted = approvedFoundation?.scope === "whole-story" &&
      approvedFoundation.firstTurnId === job.jobId && currentHead !== job.baseSha;
    const requiredIds = plan.assignments.map((assignment) => assignment.id);
    const prompt =
      context.contextNote +
      "You are the read-only NovelTea objective orchestrator, not a Story writer. " +
      "Read these exact pinned methods and references using read before planning:\n" +
      requiredFor(plan).map((p) => "skill://" + p).join("\n") +
      "\nInspect relevant existing canonical Story through read/find/grep without touching " +
      "the private .story-inbox or another Thread. You have NO file write, shell, reviewer, " +
      "or approval authority. Follow the pinned methodology to identify which of the " +
      "ALL controller-authorized assignments in a causal order, including already " +
      "completed assignments. This is a COMPLETE ordering and rationale annotation, " +
      "NOT a filtered list of only the remaining unblocked work. " +
      (plan.creativePolicy?.mode === "collaborative"
        ? "Apply nt-story-collaborate ONLY to how consequential author choices should be presented. " +
          "Reuse established foundation, protected decisions and delegated details. " +
          "A routine edit, validator fix or already delegated detail needs no question. " +
          "The assigned specialist and authenticated controller handle any actual " +
          "choice/pause/resume; do not start another scheduler, issue a permission, or " +
          "replace the bounded plan with an interview. "
        : "Autonomous mode: do not invoke nt-story-collaborate or proactively ask " +
          "for ordinary authoring choices. ") +
      "You may explain a missing prerequisite in a reason; you may NOT add, remove, " +
      "rename, modify or invent an assignment. The controller will revalidate and " +
      "enforce all dependencies and the complete delivery obligation.\n" +
      "Source base SHA: " +
      job.baseSha +
      "\nCurrent verified HEAD: " +
      currentHead +
      (foundationCommitted
        ? "\nThe authenticated Chat controller has already recorded exact author approval " +
          "for this whole-Story objective, and the Foundation is independently " +
          "native-validated and committed. Do not ask for a second approval or " +
          "treat that completed assignment as an unmet prerequisite. "
        : "\nNo pre-graph whole-Story Foundation handoff is recorded; the graph " +
          "will handle its authorized Foundation assignment. ") +
      "\nAuthor objective: " +
      plan.goal +
      "\nDelivery requirements: " +
      JSON.stringify(plan.objective) +
      "\nAuthorized bounded plan: " +
      JSON.stringify(plan.assignments) +
      "\nREQUIRED exact assignment IDs (" + requiredIds.length + " total): " +
      JSON.stringify(requiredIds) +
      "\nYou MUST return every one of these IDs exactly once, even if a stage has " +
      "already been verified or a downstream task has a dependency. No omissions. " +
      "\nReturn ONLY JSON with fields sourceSha (the source base SHA), turnDigest " +
      "(the exact plan digest), assignments (every authorized assignment, in causal order, " +
      "each as an object with id and a concise source-grounded reason). No other keys.\n" +
      "Plan digest: " +
      plan.digest;
    await withStoryJobLock(job, "orchestrator:objective", () => promptStorySpecialist(session, prompt));
    let activeSession = session;
    const completedReads = () => {
      const completed = new Set(activeSession.messages
        .filter((m): m is Extract<typeof m, { role: "toolResult" }> =>
          m.role === "toolResult" && !m.isError).map((m) => m.toolCallId));
      return activeSession.messages.flatMap((m) => m.role === "assistant"
        ? m.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> =>
          c.type === "toolCall" && c.name === "read" && completed.has(c.id) &&
          typeof c.arguments?.path === "string") : [])
        .map((c) => canonicalPinnedReadPath(c.arguments.path as string, project.root, snapshot.path));
    };
    const required = requiredFor(plan).map((p) => join(snapshot.path, "skills", p));
    const missingReads = () => required.filter(p => !completedReads().includes(p));
    if (missingReads().length) {
      await context.beforeTurn(file);
      await withStoryJobLock(job, "orchestrator:objective-reads", () => promptStorySpecialist(session,
        "Before your proposal can be accepted, read EVERY exact missing pinned skill reference " +
        "with the read tool and return a fresh bounded proposal. This is still read-only and " +
        "cannot authorize new work.\nMISSING READS:\n" + missingReads().join("\n")));
    }
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw new Error("Pinned orchestrator planning turn did not complete successfully.");
    if (missingReads().length)
      throw new Error("Orchestrator did not actually read the selected pinned method and catalog.");
    const contract = "orchestrator.work-plan.v1";
    const feedback = (failures: readonly ResponseContractFailure[]) =>
      "RESPONSE-CONTRACT CORRECTION ONLY (" + contract + "). In this same Pi " +
      "conversation return one complete unfenced JSON work plan. No tools or new " +
      "Story work, permission, approval, or assignment changes. Exact failed " +
      "paths:\n" + failures.map(f => f.path + ": " + f.expected).join("\n") +
      "\nRequired IDs (each once, respecting dependencies): " + JSON.stringify(requiredIds) +
      "\nController sourceSha=" + job.baseSha + " turnDigest=" + plan.digest;
    let acceptedReads: string[] | undefined;
    let acceptedSessionFile: string | undefined;
    const proposal = await recoverWithOneFreshSession({
      receiptFile: join(job.stateDir, "objective-plan-protocol"),
      sourceDigest: plan.digest,
      initial: {
        session, contract, validate: text => inspectOrchestratorProposal(text, plan),
        parse: text => verifyOrchestratorProposal(parseText(text), plan), feedback,
        prompt: correction => withStoryJobLock(job, "orchestrator:objective-protocol",
          () => promptStorySpecialist(session, correction)),
        beforeCorrection: () => context.beforeTurn(file),
      },
      fresh: async () => {
        const freshContext = await preparePiContext(job, project, {
          group: "orchestrator:objective:protocol-fresh",
          step: "orchestrator:objective:protocol-fresh:" + plan.digest,
          paths: [], snapshot: snapshot.id, provider, model,
          directory: join(job.stateDir, "orchestrator-planning-fresh-sessions"),
        }, runtime);
        const opened = await createAgentSession({
          cwd: project.root, modelRuntime: runtime, model: freshContext.model,
          thinkingLevel: freshContext.thinking, resourceLoader: loader, settingsManager,
          sessionManager: freshContext.manager, customTools: tools ?? [],
          noTools: "all", tools: [...SANDBOX_READ_ONLY_TOOLS],
        });
        const freshSession = opened.session;
        if (freshContext.thinking && freshSession.thinkingLevel !== freshContext.thinking) {
          freshSession.dispose(); throw Error("Fresh planner did not honor pinned thinking policy.");
        }
        activeSession = freshSession;
        const freshFile = freshSession.sessionManager.getSessionFile();
        if (!freshFile) { freshSession.dispose(); throw Error("Fresh planner lacks transcript."); }
        return {
          session: freshSession,
          start: async () => {
            await freshContext.beforeTurn(freshFile);
            await withStoryJobLock(job, "orchestrator:objective-protocol-fresh",
              () => promptStorySpecialist(freshSession, prompt));
            if (missingReads().length)
              throw Error("Fresh planner omitted required pinned methodology reads.");
          },
          prompt: correction => withStoryJobLock(job, "orchestrator:objective-protocol-fresh",
            () => promptStorySpecialist(freshSession, correction)),
          beforeCorrection: () => freshContext.beforeTurn(freshFile),
          completed: async () => {
            if (missingReads().length)
              throw Error("Fresh planner response lost required pinned source reads.");
            acceptedReads = completedReads();
            acceptedSessionFile = freshFile;
            await freshContext.completed(freshFile, freshSession.sessionId);
          },
          dispose: () => freshSession.dispose(),
        };
      },
    });
    await context.completed(file, session.sessionId);
    if (activeSession === session) {
      acceptedReads = completedReads();
      acceptedSessionFile = file;
    }
    if (!acceptedSessionFile || !acceptedReads ||
        required.some(path => !acceptedReads!.includes(path)))
      throw Error("Accepted planner lacks pinned method receipts or transcript.");
    const finished = seal({ ...original, sessionFile: acceptedSessionFile, phase: "planned",
      proposal, skillReads: acceptedReads });
    await writeFile(pathFor(job), JSON.stringify(finished, null, 2) + "\n", { mode: 0o600 });
    return verifyReceipt(finished, job, selection, plan, provider, model);
  } finally {
    session.dispose();
  }
}
