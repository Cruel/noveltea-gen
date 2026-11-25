/** Source-authenticated admission for #212 upstream causality discoveries.
 * The model may request an amendment, but only the trusted generation
 * controller can make it inspectable; this never starts an Architecture writer. */
import { createHash } from "node:crypto";
import { execFileSync } from "./git-read-cache.js";
import { readFile } from "node:fs/promises";
import { authenticateEventNoWrite } from "./event-prerequisite-auth.js";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { Plan } from "./architecture.js";
import type { GenerationInventory } from "./generation-plan.js";
import { buildCausalAmendment, type CausalAmendment, type CausalDiscovery } from "./causal-amendment.js";
import type { MilestoneBlueprintPin } from "./milestone-blueprint.js";
import { readEventSourceBlueprint } from "./event-work.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { executionId, resolvedCheckpointReviews } from "./checkpoint-assurance.js";
import { validateStoryJob } from "./validator.js";
import { trustedHead } from "./revision.js";
import type { EventAssignment } from "./event-specialist.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"])
    delete env[name];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
interface EventSource {
  version: 1; jobId: string; milestoneId: string;
  planVersion: number; planDigest: string; expectedHead: string;
  phase: string; worker: "fixture" | "pi";
  assignment?: EventAssignment; blueprintPin?: MilestoneBlueprintPin;
  snapshot?: { id: string };
  workItemId: string; sessionFile?: string;
  conflicts?: string[]; obligations?: string[];
  prerequisite?: { reportDigest: string; expectedHead: string;
    sessionSha256: string; sessionId: string; assignmentDigest: string;
    snapshotId: string; sessionFile: string; worker: "pi" | "fixture" };
  claimedPaths?: string[]; causalDiscovery?: CausalDiscovery;
}
/** Must be called under the Story writer lock, with no in-flight specialist.
 * Re-reads the settled receipt, private plan, Git and native sources rather
 * than trusting a model-reported path or the graph's last dispatch output. */
export async function inspectCausalAmendment(job: JobStartResult, input: {
  sourceSha: string; reportDigest: string; milestoneId: string;
  inventory: GenerationInventory; plan: Plan;
  validatorSource?: string;
}): Promise<CausalAmendment> {
  if (!/^milestone\.[a-z][a-z0-9-]*$/.test(input.milestoneId) ||
      await trustedHead(job) !== input.sourceSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all").trim()) {
    throw Error("Causal amendment requires a clean, exact verified Story HEAD.");
  }
  const root = input.milestoneId.slice("milestone.".length);
  const event = JSON.parse(await readFile(join(job.stateDir, "event-items", root + ".json"), "utf8")) as EventSource;
  if (event.version !== 1 || event.jobId !== job.jobId ||
      event.milestoneId !== input.milestoneId || event.phase !== "prerequisite-reported" ||
      event.expectedHead !== input.sourceSha || event.planVersion !== input.plan.version ||
      event.planDigest !== sha(input.plan) || !event.assignment || !event.blueprintPin ||
      !event.prerequisite || event.prerequisite.expectedHead !== event.expectedHead ||
      event.prerequisite.reportDigest !== input.reportDigest ||
      event.claimedPaths?.length || !event.causalDiscovery ||
      !Array.isArray(event.conflicts) || !Array.isArray(event.obligations) ||
      !event.snapshot || event.snapshot.id !== event.prerequisite.snapshotId ||
      event.assignment.milestoneId !== event.milestoneId ||
      event.assignment.milestonePath !== event.causalDiscovery.sourcePath ||
      input.inventory.planVersion !== input.plan.version ||
      !input.plan.items.some(item => item.id === "global-architecture" &&
        item.status === "verified" && item.targetIds.includes(event.milestoneId))) {
    throw Error("No current source-bound, clean Event causal discovery is eligible for upstream amendment.");
  }
  await authenticateEventNoWrite(job, event);
  // This verifies the complete original writer/reviewer cycle, exact private
  // source hashes, original model identity, and job/Thread/assignment pins.
  const blueprint = await readEventSourceBlueprint(job, event.blueprintPin, event.assignment, event.expectedHead);
  const validated = await validateStoryJob(job, input.validatorSource, { ...job, baseSha: input.sourceSha });
  const report = validated.report as { records?: Array<{ path: string; metadata: { id: string; status: string } }>;
    diagnostics?: unknown[]; protection?: { status: string; base?: string; changes?: unknown[]; warnings?: unknown[] } } | undefined;
  if (validated.status !== "passed" || !Array.isArray(report?.records) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length ||
      report.protection?.status !== "checked" || report.protection.base !== input.sourceSha ||
      report.protection.changes?.length || report.protection.warnings?.length ||
      !report.records.some(record => record.path === event.causalDiscovery!.sourcePath &&
        record.metadata.id === event.milestoneId && record.metadata.status !== "superseded")) {
    throw Error("Causal amendment lacks current native-validated, protected canonical Milestone evidence.");
  }
  const canonical = git(job, "show", input.sourceSha + ":" +
    (job.storyRelativePath ? job.storyRelativePath + "/" : "") + event.causalDiscovery.sourcePath);
  const checkpoints = (await inspectRecoveryCheckpoints(job))
    .filter(point => point.eligible && point.assurance);
  const resolved = await resolvedCheckpointReviews(job, checkpoints);
  const approved = checkpoints.filter(point =>
    ["passed", "not-required"].includes(resolved.get(point.commitSha) ??
      point.semanticReview));
  const foundationsComplete = ["world-foundations", "character-foundations"].every(unit =>
    approved.some(point => point.workItem === unit));
  const reviewed = approved.map(point => executionId(point.workItem))
    .filter(id => id !== "foundations" || foundationsComplete);
  const proposal = buildCausalAmendment({
    jobId: job.jobId, threadId: job.threadId,
    sourceSha: input.sourceSha, planVersion: input.plan.version,
    reportDigest: input.reportDigest, milestoneId: event.milestoneId,
    sourcePaths: event.assignment.sourcePaths, sourceText: canonical,
    localBlueprint: blueprint, blueprintDigest: event.blueprintPin.digest,
    inventory: input.inventory, reviewedWorkItems: reviewed,
    ...event.causalDiscovery,
  });
  // Detect a concurrent verified-source change between source inspection and
  // preparing an author-visible proposal, including after independent lookups.
  if (await trustedHead(job) !== input.sourceSha ||
      git(job, "status", "--porcelain=v1", "--untracked-files=all").trim())
    throw Error("Causal amendment Story HEAD or worktree changed during admission.");
  return proposal;
}

/** Architecture's existing author-approved plan revision reads only the
 * current generation checkpoint, then independently revalidates its source.
 * A local JSON file or a copied proposal digest is never enough. */
export async function readCheckpointedCausalAmendment(job: JobStartResult) {
  const { existsSync } = await import("node:fs");
  const path = join(job.stateDir, "generation.sqlite");
  if (!existsSync(path)) throw Error("No source-bound generation Thread to amend.");
  const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
  const { createGenerationGraph } = await import("./generation.js");
  const saver = SqliteSaver.fromConnString(path);
  let state: { causalAmendment?: CausalAmendment | null; inventory?: GenerationInventory | null;
    request?: { validatorSource?: string; skillsSource?: string };
    planVersion?: number | null };
  try {
    const graph = createGenerationGraph(saver, "cli");
    state = (await graph.getState({ configurable: { thread_id: job.threadId + ":generation" } }))
      .values as typeof state;
  } finally { saver.db.close(); }
  const sealed = state.causalAmendment;
  if (!sealed || !state.inventory || !state.planVersion ||
      sealed.jobId !== job.jobId || sealed.threadId !== job.threadId ||
      state.planVersion !== sealed.source.planVersion)
    throw Error("Generation has no checkpointed causal amendment in this job/Thread.");
  const saved = JSON.parse(await readFile(join(job.stateDir, "architecture.json"), "utf8")) as {
    plan?: Plan; history?: unknown[]; jobId?: string; phase?: string;
  };
  const { verifyPlanHistory } = await import("./architecture.js");
  verifyPlanHistory(job, saved as Parameters<typeof verifyPlanHistory>[1]);
  if (saved.jobId !== job.jobId || saved.phase !== "committed" ||
      saved.plan?.version !== state.planVersion)
    throw Error("Causal amendment does not belong to the current committed Architecture plan.");
  const rebuilt = await inspectCausalAmendment(job, {
    sourceSha: sealed.source.sha, reportDigest: sealed.source.reportDigest,
    milestoneId: sealed.source.milestoneId,
    inventory: state.inventory, plan: saved.plan,
    validatorSource: state.request?.validatorSource ?? state.request?.skillsSource,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(sealed))
    throw Error("Causal amendment differs from the reverified Story sources.");
  return rebuilt;
}
