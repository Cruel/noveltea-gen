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
import { promptStorySpecialist } from "./story-interruption.js";
import { withStoryJobLock } from "./job-lock.js";
import { trustedHead } from "./revision.js";

const REQUIRED = [
  "nt-story-orchestrate/SKILL.md",
  "nt-story-orchestrate/references/planning.md",
  "nt-catalog/SKILL.md",
  "nt-catalog/references/records.md",
  "nt-catalog/references/progression.md",
  "nt-catalog/references/authority-and-validation.md",
] as const;
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
    const required = REQUIRED.map((p) => join(selection.receipt.skillSnapshot.path, "skills", p));
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
    if (saved.phase !== "planned")
      throw new Error("Interrupted orchestrator planning session; inspect its transcript before replay.");
    return saved;
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
      requiredSkills: ["nt-story-orchestrate", "nt-catalog", "nt-story-discovery"],
    },
    [],
    "orchestrator",
  );
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  if (
    diagnostics.some((d) => d.type === "error") ||
    ["nt-story-orchestrate", "nt-catalog"].some(
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
  const tools = await selectSandboxPiTools(job, snapshot, skills, undefined, "read-only", "orchestrator");
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
    const currentHead = await trustedHead(job);
    const prompt =
      context.contextNote +
      "You are the read-only NovelTea objective orchestrator, not a Story writer. " +
      "Read these exact pinned methods and references using read before planning:\n" +
      REQUIRED.map((p) => "skill://" + p).join("\n") +
      "\nInspect relevant existing canonical Story through read/find/grep without touching " +
      "the private .story-inbox or another Thread. You have NO file write, shell, reviewer, " +
      "or approval authority. Follow the pinned methodology to identify which of the " +
      "controller-authorized assignments are currently relevant and their causal order. " +
      "You may explain a missing prerequisite in a reason; you may NOT add, remove, " +
      "rename, modify or invent an assignment. The controller will revalidate and " +
      "enforce all dependencies and the complete delivery obligation.\n" +
      "Source base SHA: " +
      job.baseSha +
      "\nCurrent verified HEAD: " +
      currentHead +
      "\nAuthor objective: " +
      plan.goal +
      "\nDelivery requirements: " +
      JSON.stringify(plan.objective) +
      "\nAuthorized bounded plan: " +
      JSON.stringify(plan.assignments) +
      "\nReturn ONLY JSON with fields sourceSha (the source base SHA), turnDigest " +
      "(the exact plan digest), assignments (every authorized assignment, in causal order, " +
      "each as an object with id and a concise source-grounded reason). No other keys.\n" +
      "Plan digest: " +
      plan.digest;
    await withStoryJobLock(job, "orchestrator:objective", () => promptStorySpecialist(session, prompt));
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.role !== "assistant" || ["error", "aborted"].includes(last.stopReason))
      throw new Error("Pinned orchestrator planning turn did not complete successfully.");
    const completed = new Set(
      session.messages
        .filter((m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && !m.isError)
        .map((m) => m.toolCallId),
    );
    const reads = session.messages
      .flatMap((m) =>
        m.role === "assistant"
          ? m.content.filter(
              (c): c is Extract<typeof c, { type: "toolCall" }> =>
                c.type === "toolCall" &&
                c.name === "read" &&
                completed.has(c.id) &&
                typeof c.arguments?.path === "string",
            )
          : [],
      )
      .map((c) => canonicalPinnedReadPath(c.arguments.path as string, project.root, snapshot.path));
    const required = REQUIRED.map((p) => join(snapshot.path, "skills", p));
    if (required.some((p) => !reads.includes(p)))
      throw new Error("Orchestrator did not actually read the selected pinned method and catalog.");
    const proposal = verifyOrchestratorProposal(parseText(session.getLastAssistantText() ?? ""), plan);
    await context.completed(file, session.sessionId);
    const finished = seal({ ...original, phase: "planned", proposal, skillReads: reads });
    await writeFile(pathFor(job), JSON.stringify(finished, null, 2) + "\n", { mode: 0o600 });
    return verifyReceipt(finished, job, selection, plan, provider, model);
  } finally {
    session.dispose();
  }
}
