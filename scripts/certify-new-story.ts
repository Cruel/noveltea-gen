/** Read-only #158 release evidence command.
 * It never starts/resumes generation, refreshes credentials or alters a Story.
 */
import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { startStoryJob, type JobStartResult } from "../src/job.js";
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
async function loadCase(file: string, mode: NewStoryMode): Promise<NewStoryEvidence> {
  const input = JSON.parse(await readFile(resolve(file), "utf8")) as CaseInput;
  if (!input || !input.story || !input.job || !input.quality || !input.studio)
    throw new Error(mode + " must provide story, job, external quality and Studio witness.");
  const job = await startStoryJob({ story: resolve(input.story), job: input.job }, false);
  const report = await inspectJobReport({ story: job.storyRoot, job: job.jobId });
  const approval = await readChatApprovedFoundation(job);
  if (!approval) throw new Error(mode + ": saved exact Chat baseline approval is missing.");
  const planPath = join(job.stateDir, "turn-plan.json");
  const rawTurn = JSON.parse(await readFile(planPath, "utf8")) as TurnEvidence;
  const turn = await readTurnEvidence(job, rawTurn.contract, approval.originalObjective, rawTurn.digest);
  if (!turn) throw new Error(mode + ": original saved Turn is missing.");
  const selectedRaw = JSON.parse(
    await readFile(join(job.stateDir, "orchestrator-selection.json"), "utf8"),
  ) as StoryOrchestratorReceipt;
  const selected = await loadSelectedStoryOrchestrator(job, selectedRaw.graphThreadId, {
    task: turn.originalRequest,
    kind: "full-story",
    turnPlanDigest: turn.digest,
  });
  const planning = await readPinnedObjectivePlanning(job, selected, turn, approval.provider, approval.model);
  // Load the checked, source-bound controller receipts; do not accept author
  // manifest fields as a substitute for the controller's saved identities.
  const verified = await regularFile(planning.sessionFile);
  return {
    mode,
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
          sourceSha: item.report.identity.baseSha,
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
