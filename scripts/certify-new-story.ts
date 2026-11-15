/** Read-only #158 release evidence command.
 * It never starts/resumes generation, refreshes credentials or alters a Story.
 */
import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { openSharedStudioStore } from "../web/src/db/shared-studio-store.js";
import { resolve, join } from "node:path";
import { startStoryJob, type JobStartResult } from "../src/job.js";
import { verifyCertifiedRecoveryLineage } from "../src/certification-lineage.js";
import { inspectJobReport } from "../src/job-report.js";
import { readChatApprovedFoundation } from "../src/chat-approved-foundation.js";
import { readTurnEvidence, type TurnEvidence } from "../src/turn-plan-evidence.js";
import {
  loadSelectedStoryOrchestrator,
  type StoryOrchestratorReceipt,
} from "../src/orchestrator-selection.js";
import { readPinnedObjectivePlanning } from "../src/orchestrator-planner.js";
import {
  auditNewStoryMatrix,
  type ExternalStoryQuality,
  type NewStoryEvidence,
  type NewStoryMode,
  type StudioStoryWitness,
} from "../src/new-story-certification.js";

interface CaseInput {
  story: string;
  job: string;
  /** Optional verified terminal continuation. 'job' remains the original first Turn. */
  finalJob?: string;
  /** Required for a continuation: persisted Studio Thread ownership ledger. */
  certificationRoot?: string;
  quality: ExternalStoryQuality;
  /** Manually verified Studio Chat/recovery evidence, with a private reference. */
  studio: StudioStoryWitness;
}

function git(job: JobStartResult, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"])
    delete env[key];
  return execFileSync("git", args, {
    cwd: job.worktreeRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  });
}
const safePath = /^[a-z][a-z-]*\/[a-z0-9][a-z0-9._-]*\.md$/;
function committedRecords(job: JobStartResult): Record<string, string> {
  const prefix = job.storyRelativePath ? job.storyRelativePath + "/" : "";
  const files = git(job, "ls-tree", "-r", "--name-only", job.headSha, "--", prefix)
    .split("\n")
    .filter(Boolean)
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : ""));
  const records = files.filter((path) => safePath.test(path));
  if (records.length > 128) throw new Error("Canonical Story exceeds the bounded #158 review manifest.");
  const values: Record<string, string> = {};
  let bytes = 0;
  for (const path of records) {
    const content = git(job, "show", job.headSha + ":" + prefix + path);
    bytes += Buffer.byteLength(content);
    if (bytes > 1024 * 1024) throw new Error("Story evidence exceeds the 1 MiB certification budget.");
    values[path] = content;
  }
  return values;
}
async function regularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function verifyStudioLineage(input: CaseInput, mode: NewStoryMode,
  source: JobStartResult, terminal: JobStartResult,
  lineage: NonNullable<NewStoryEvidence["lineage"]>) {
  if (!input.certificationRoot) throw new Error(
    "Continuation acceptance requires the preserved Studio certificationRoot to verify the original Thread.");
  const root = resolve(input.certificationRoot);
  const manifest = JSON.parse(await readFile(join(root, "certification-source.json"), "utf8")) as {
    version: number; ownerId: string; jobId: string; mode: string; sourceSha: string; storyRoot: string;
  };
  if (manifest.version !== 1 || manifest.jobId !== source.jobId ||
      manifest.sourceSha !== source.baseSha || manifest.storyRoot !== source.storyRoot ||
      manifest.mode !== mode || !manifest.ownerId)
    throw new Error("Preserved certification source differs from the approved first Turn.");
  const db = join(root, "app/studio.sqlite");
  if (!await regularFile(db)) throw new Error("Preserved Studio authorization ledger is missing.");
  const store = openSharedStudioStore({ backend: "sqlite", path: db });
  try {
    await store.assertReady();
    const originalThread = await store.persistence.advancedThreads.sourceThread(manifest.ownerId, source.jobId);
    if (originalThread?.id !== "root:" + source.jobId)
      throw new Error("The original Story Chat Thread is not verified in Studio.");
    let previousOrder = await store.persistence.advancedThreads.runOrder(
      manifest.ownerId, originalThread.id, source.jobId);
    if (previousOrder === null) throw new Error("Original Story execution has no source-linked Thread order.");
    for (const hop of lineage.hops) {
      const child = await store.persistence.advancedThreads.sourceThread(manifest.ownerId, hop.childJobId);
      const order = await store.persistence.advancedThreads.runOrder(
        manifest.ownerId, originalThread.id, hop.childJobId);
      if (child?.id !== originalThread.id || order === null || order <= previousOrder)
        throw new Error("Checkpoint recovery changed the visible Story Thread or execution order.");
      previousOrder = order;
    }
    if (lineage.terminalJobId !== terminal.jobId)
      throw new Error("Studio execution lineage does not end at the certified Job.");
  } finally { await store.close(); }
}

async function loadCase(file: string, mode: NewStoryMode): Promise<NewStoryEvidence> {
  const input = JSON.parse(await readFile(resolve(file), "utf8")) as CaseInput;
  if (!input || !input.story || !input.job || !input.quality || !input.studio)
    throw new Error(mode + " must provide story, job, external quality and Studio witness.");
  const original = await startStoryJob({ story: resolve(input.story), job: input.job }, false);
  const job = input.finalJob ? await startStoryJob({ story: original.storyRoot, job: input.finalJob }, false) : original;
  const lineage = await verifyCertifiedRecoveryLineage(original, job);
  if (lineage) await verifyStudioLineage(input, mode, original, job, lineage);
  const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId });
  const approval = await readChatApprovedFoundation(original);
  if (!approval) throw new Error(mode + ": saved exact Chat baseline approval is missing.");
  const planPath = join(original.stateDir, "turn-plan.json");
  const rawTurn = JSON.parse(await readFile(planPath, "utf8")) as TurnEvidence;
  const turn = await readTurnEvidence(original, rawTurn.contract, approval.originalObjective, rawTurn.digest);
  if (!turn) throw new Error(mode + ": original saved Turn is missing.");
  const selectedRaw = JSON.parse(
    await readFile(join(original.stateDir, "orchestrator-selection.json"), "utf8"),
  ) as StoryOrchestratorReceipt;
  const selected = await loadSelectedStoryOrchestrator(original, selectedRaw.graphThreadId, {
    task: turn.originalRequest,
    kind: "full-story",
    turnPlanDigest: turn.digest,
  });
  const planning = await readPinnedObjectivePlanning(original, selected, turn, approval.provider, approval.model);
  // Load the checked, source-bound controller receipts; do not accept author
  // manifest fields as a substitute for the controller's saved identities.
  const verified = await regularFile(planning.sessionFile);
  return {
    mode,
    lineage,
    approval,
    turn,
    selection: selected.receipt,
    planning,
    plannerSessionVerified: verified,
    report: {
      identity: report.identity,
      plan: report.plan,
      generation: report.generation,
      evidence: report.evidence,
    } as NewStoryEvidence["report"],
    canonical: committedRecords(job),
    quality: input.quality,
    studio: input.studio,
  };
}

async function main() {
  const [optionA, fileA, optionB, fileB, ...extra] = process.argv.slice(2);
  if (optionA !== "--autonomous" || !fileA || optionB !== "--collaborative" || !fileB || extra.length) {
    throw new Error("Usage: pnpm certify:new-story --autonomous <case.json> --collaborative <case.json>");
  }
  const cases = await Promise.all([loadCase(fileA, "autonomous"), loadCase(fileB, "collaborative")]);
  const result = auditNewStoryMatrix(cases);
  // No raw Story prose, Pi transcripts, tokens or personal filesystem paths.
  console.log(
    JSON.stringify(
      {
        gate: "noveltea-new-story-evidence/v1",
        status: result.status,
        sources: cases.map((item) => ({
          mode: item.mode,
          sourceSha: item.lineage?.originalSourceSha ?? item.report.identity.baseSha,
          terminalJob: item.report.identity.jobId,
          checkpointContinuations: item.lineage?.hops.length ?? 0,
          headSha: item.report.identity.headSha,
          skillSnapshotId: item.selection?.skillSnapshot.id,
          qualityReviewer: item.quality?.reviewer,
          canonicalRecords: Object.keys(item.canonical).length,
        })),
        blockers: result.blockers,
      },
      null,
      2,
    ),
  );
  if (result.status !== "eligible") process.exitCode = 1;
}
main().catch((error) => {
  console.error(
    "New Story evidence blocked: " + (error instanceof Error ? error.message : "unreadable input"),
  );
  process.exitCode = 1;
});
