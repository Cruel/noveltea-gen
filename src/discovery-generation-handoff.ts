import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { PiBudgetUsage } from "./job-pi-policy.js";
import { parseJobLimits, type JobLimits } from "./job-limits.js";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export type DiscoveryHandoff = {
  version: 1;
  owner: string;
  storyId: string;
  repositoryId: string;
  directory: string;
  firstTurnId: string;
  threadId: string;
  sourceSha: string;
  originalObjective: string;
  graphEpoch: string;
  approvalOperation: number;
  reviewedProposalDigest: string;
  approvedProposalDigest: string;
  authorEvidenceDigest: string;
  reviewDigest: string;
  foundationDigest: string;
  skillId: string;
  model: { provider: string; id: string; thinking?: "low" | "medium" | "high" };
  limits: JobLimits;
  usage: PiBudgetUsage;
  usageEvidenceDigest: string;
  turnPlanDigest: string | null;
  digest: string;
};

export function sealDiscoveryHandoff(input: Omit<DiscoveryHandoff, "version" | "digest">): DiscoveryHandoff {
  const body = { version: 1 as const, ...input };
  const receipt = { ...body, digest: sha(body) };
  assertDiscoveryHandoff(receipt);
  return receipt;
}

export function assertDiscoveryHandoff(receipt: DiscoveryHandoff) {
  const { digest: sealed, ...body } = receipt;
  const usage = receipt.usage;
  if (receipt.version !== 1 || sealed !== sha(body) ||
      !receipt.owner || !receipt.storyId || !receipt.repositoryId || !receipt.directory ||
      !receipt.firstTurnId || receipt.threadId !== "root:" + receipt.firstTurnId ||
      !/^[a-f0-9]{40}$/.test(receipt.sourceSha) || !receipt.originalObjective.trim() ||
      !Number.isSafeInteger(receipt.approvalOperation) || receipt.approvalOperation <= 0 ||
      ![receipt.graphEpoch, receipt.reviewedProposalDigest, receipt.approvedProposalDigest,
        receipt.authorEvidenceDigest, receipt.reviewDigest, receipt.foundationDigest,
        receipt.skillId, receipt.usageEvidenceDigest].every(digest) ||
      (receipt.turnPlanDigest !== null && !digest(receipt.turnPlanDigest)) ||
      !receipt.model.provider || !receipt.model.id ||
      (receipt.model.thinking !== undefined && !["low", "medium", "high"].includes(receipt.model.thinking)) ||
      !usage || usage.pause ||
      ![usage.steps, usage.modelCalls, usage.unpricedCalls, usage.unknownTokenCalls,
        ...(["input", "output", "cacheRead", "cacheWrite", "total"] as const).map(key => usage.tokens[key])].every(n => Number.isSafeInteger(n) && n >= 0) ||
      ![usage.activeSeconds, usage.costUsd].every(n => Number.isFinite(n) && n >= 0) ||
      usage.unpricedCalls > usage.modelCalls || usage.unknownTokenCalls > usage.modelCalls)
    throw Error("Discovery handoff approval or metering evidence is invalid.");
  parseJobLimits(receipt.limits);
}

const pathFor = (job: JobStartResult) => join(job.stateDir, "discovery-handoff.json");

export async function readDiscoveryHandoff(job: JobStartResult): Promise<DiscoveryHandoff | null> {
  let raw: string;
  try { raw = await readFile(pathFor(job), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const receipt = JSON.parse(raw) as DiscoveryHandoff;
  assertDiscoveryHandoff(receipt);
  if (receipt.firstTurnId !== job.jobId || receipt.sourceSha !== job.baseSha)
    throw Error("Discovery handoff belongs to another Generation Job or source.");
  return receipt;
}

/** Immutable original phase usage is imported once, not added to a mutable
 * Generation counter. Atomic publication makes a lost response idempotent. */
export async function pinDiscoveryHandoff(job: JobStartResult, receipt: DiscoveryHandoff) {
  assertDiscoveryHandoff(receipt);
  if (receipt.firstTurnId !== job.jobId || receipt.sourceSha !== job.baseSha)
    throw Error("Discovery handoff belongs to another Generation Job or source.");
  const temporary = pathFor(job) + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, pathFor(job)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readDiscoveryHandoff(job);
      if (prior?.digest !== receipt.digest)
        throw Error("Generation Job already has a different Discovery handoff.");
    }
  } finally { await unlink(temporary); }
}
