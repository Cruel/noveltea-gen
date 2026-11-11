/**
 * Trusted, explicit selection of the portable Story orchestration methodology.
 *
 * This is a METHOD read, not an execution engine, scheduler, Story writer or
 * model-supplied permission. The existing LangGraph controller owns all of those.
 * Existing selections are restored exclusively from the verified snapshot;
 * a modified checkout is never consulted to reinterpret an active Thread.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import type { JobStartResult } from "./job.js";
import { createSkillReadTool, roleVisibleSkills } from "./skills.js";
import {
  createSkillSnapshot,
  openSkillSnapshot,
  verifiedSkillFiles,
  type SkillSnapshot,
} from "./snapshot.js";

const METHOD = "nt-story-orchestrate";
const ENTRYPOINT = "skills/nt-story-orchestrate/SKILL.md";
const SCHEMA = "noveltea-orchestrator-selection/v1";
const CONTRACT = "noveltea-orchestration-method/v1";
type JobIdentity = Pick<JobStartResult, "jobId" | "threadId" | "baseSha" | "stateDir">;
export interface StoryOrchestratorSource {
  task: string;
  kind: "full-story" | "partial";
  turnPlanDigest?: string;
}
export interface StoryOrchestratorReceipt {
  schema: typeof SCHEMA;
  controllerContract: typeof CONTRACT;
  jobId: string;
  threadId: string;
  graphThreadId: string;
  storySourceSha: string;
  objectiveSha256: string;
  objectiveKind: StoryOrchestratorSource["kind"];
  turnPlanDigest: string | null;
  role: "orchestrator";
  reviewRole: "reviewer";
  writeAuthority: "controller-only";
  skillName: typeof METHOD;
  skillEntrypoint: typeof ENTRYPOINT;
  skillEntrypointSha256: string;
  skillSnapshot: SkillSnapshot;
}
export interface StoryOrchestratorSelection {
  receipt: StoryOrchestratorReceipt;
  /** Portable method instructions for the trusted coordinator only. */
  procedure: string;
}
const digest = (data: string) => createHash("sha256").update(data).digest("hex");
const receiptPath = (job: JobIdentity) => join(job.stateDir, "orchestrator-selection.json");

function matches(
  receipt: StoryOrchestratorReceipt,
  job: JobIdentity,
  graphThreadId: string,
  source: StoryOrchestratorSource,
): boolean {
  return (
    receipt.schema === SCHEMA &&
    receipt.controllerContract === CONTRACT &&
    receipt.jobId === job.jobId &&
    receipt.threadId === job.threadId &&
    receipt.graphThreadId === graphThreadId &&
    receipt.storySourceSha === job.baseSha &&
    receipt.objectiveSha256 === digest(source.task) &&
    receipt.objectiveKind === source.kind &&
    receipt.turnPlanDigest === (source.turnPlanDigest ?? null) &&
    receipt.role === "orchestrator" &&
    receipt.reviewRole === "reviewer" &&
    receipt.writeAuthority === "controller-only" &&
    receipt.skillName === METHOD &&
    receipt.skillEntrypoint === ENTRYPOINT
  );
}

/** Reads the exact pinned skill through the same role-isolated resource guard as Pi. */
async function readPinnedMethod(snapshot: SkillSnapshot): Promise<string> {
  if (
    snapshot.id !== snapshot.digest ||
    !/^[a-f0-9]{64}$/.test(snapshot.id) ||
    (await openSkillSnapshot(snapshot.id)) !== snapshot.path
  ) {
    throw new Error("Incompatible orchestrator skill snapshot identity.");
  }
  const verified = await verifiedSkillFiles(snapshot.id);
  const skills = loadSkills({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    skillPaths: [join(snapshot.path, "skills")],
    includeDefaults: false,
  });
  if (skills.diagnostics.some((d) => d.type === "error")) {
    throw new Error("Pinned orchestrator skill package cannot be loaded.");
  }
  const entry = join(snapshot.path, ENTRYPOINT);
  const visible = roleVisibleSkills(skills.skills, "orchestrator");
  const orchestrator = visible.find((skill) => skill.name === METHOD && skill.filePath === entry);
  if (!orchestrator) {
    throw new Error(
      "Incompatible pinned skills: required nt-story-orchestrate method is missing; " +
        "never substitute nt-story-generate.",
    );
  }
  // The orchestrator needs both these portable references. This check is
  // independent of any invocation metadata in a mutable SKILL.md.
  for (const required of ["nt-catalog", "nt-story-discovery"]) {
    if (
      !visible.some(
        (skill) =>
          skill.name === required && skill.filePath === join(snapshot.path, "skills", required, "SKILL.md"),
      )
    ) {
      throw new Error("Incompatible pinned orchestration method: missing " + required + ".");
    }
  }
  const read = createSkillReadTool([orchestrator], verified);
  const result = await read.execute(
    "controller-method-read",
    { path: entry },
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const content = result.content?.[0];
  if (!content || content.type !== "text" || !content.text.trim()) {
    throw new Error("Pinned nt-story-orchestrate procedure is empty or unreadable.");
  }
  return content.text;
}

/** Restore a previously selected method, never consulting a live checkout. */
export async function loadSelectedStoryOrchestrator(
  job: JobIdentity,
  graphThreadId: string,
  source: StoryOrchestratorSource,
): Promise<StoryOrchestratorSelection> {
  let saved: StoryOrchestratorReceipt;
  try {
    saved = JSON.parse(await readFile(receiptPath(job), "utf8")) as StoryOrchestratorReceipt;
  } catch {
    throw new Error("Orchestrator selection receipt is missing or unreadable; no silent repinning.");
  }
  if (!matches(saved, job, graphThreadId, source)) {
    throw new Error(
      "Orchestrator selection identity, role or source objective mismatch; no privilege escalation or repinning.",
    );
  }
  if (!saved.skillSnapshot || typeof saved.skillEntrypointSha256 !== "string") {
    throw new Error("Incompatible orchestrator receipt: skill snapshot identity missing.");
  }
  const procedure = await readPinnedMethod(saved.skillSnapshot);
  if (digest(procedure) !== saved.skillEntrypointSha256) {
    throw new Error("Pinned orchestrator entrypoint digest mismatch.");
  }
  return { receipt: saved, procedure };
}

/**
 * Controller-only selection: exact skill ID and role are constants, never
 * client/model inputs. Concurrent attempts must converge on the same receipt.
 */
export async function selectStoryOrchestrator(
  job: JobIdentity,
  graphThreadId: string,
  source: StoryOrchestratorSource,
  skillsSource: string,
): Promise<StoryOrchestratorSelection> {
  if (!graphThreadId.trim() || !source.task.trim()) {
    throw new Error("Orchestrator selection requires a durable Thread and author objective.");
  }
  if (existsSync(receiptPath(job))) {
    return loadSelectedStoryOrchestrator(job, graphThreadId, source);
  }
  const snapshot = await createSkillSnapshot({
    discovery: "explicit-only",
    novelteaSkills: skillsSource,
    skillDirs: [],
    requiredSkills: [METHOD, "nt-catalog", "nt-story-discovery"],
  });
  if (!snapshot) throw new Error("Orchestrator requires a configured NovelTea skills checkout.");
  const procedure = await readPinnedMethod(snapshot);
  const receipt: StoryOrchestratorReceipt = {
    schema: SCHEMA,
    controllerContract: CONTRACT,
    jobId: job.jobId,
    threadId: job.threadId,
    graphThreadId,
    storySourceSha: job.baseSha,
    objectiveSha256: digest(source.task),
    objectiveKind: source.kind,
    turnPlanDigest: source.turnPlanDigest ?? null,
    role: "orchestrator",
    reviewRole: "reviewer",
    writeAuthority: "controller-only",
    skillName: METHOD,
    skillEntrypoint: ENTRYPOINT,
    skillEntrypointSha256: digest(procedure),
    skillSnapshot: snapshot,
  };
  try {
    await writeFile(receiptPath(job), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return loadSelectedStoryOrchestrator(job, graphThreadId, source);
}

export async function hasStoryOrchestratorSelection(job: JobIdentity) {
  return existsSync(receiptPath(job));
}
