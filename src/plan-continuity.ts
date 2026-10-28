import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobStartResult } from "./job.js";
import type { CompletionContract, Plan } from "./architecture.js";
import { verifyAuthorEvidence, type SignedAuthorEvidence } from "./author-evidence.js";

export interface PlanHistoryStep {
  plan: Plan;
  proposal: string;
  approvedContract: CompletionContract;
  verifiedHead: string;
  carryForward?: string[];
  source: "author-ed25519";
  signed: SignedAuthorEvidence;
}
export interface PlanSnapshot {
  jobId: string;
  phase: string;
  plan?: Plan;
  history?: PlanHistoryStep[];
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA = /^[a-f0-9]{40,64}$/;
const MILESTONE = /^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function receiptFile(job: JobStartResult, stage: string) {
  const base = dirname(job.worktreeRoot);
  if (stage === "foundations") return join(base, "character-world.json");
  const [kind, milestone] = stage.split(":");
  if (!["event", "interactive", "composition"].includes(kind ?? "") ||
      !milestone || !MILESTONE.test(milestone)) throw new Error("Invalid plan carry-forward work item: " + stage);
  return join(base, kind + "-items", milestone.slice("milestone.".length) + ".json");
}
function parentStages(stage: string) {
  if (stage.startsWith("event:")) return ["foundations"];
  if (stage.startsWith("interactive:")) return ["foundations", stage.replace(/^interactive:/, "event:")];
  if (stage.startsWith("composition:")) return [
    "foundations", stage.replace(/^composition:/, "event:"), stage.replace(/^composition:/, "interactive:"),
  ];
  return [];
}
function historicalCommit(stage: string, receipt: any): string | undefined {
  if (stage === "foundations") {
    if (receipt.units?.length !== 2 || receipt.units.some((u: any) => u.phase !== "committed")) return;
    return receipt.units[1]?.commitSha;
  }
  if (stage.startsWith("interactive:")) {
    if (receipt.units?.length !== 2 || receipt.units.some((u: any) => u.phase !== "committed")) return;
    return receipt.units[1]?.commitSha;
  }
  return receipt.phase === "committed" ? receipt.commitSha : undefined;
}

/** Verify a requested carry-forward is backed by the exact immutable specialist
 * receipt and a commit still on the current verified branch. No writer is replayed. */
function checkHistoricalWork(job: JobStartResult, stage: string, version: number, head: string) {
  const path = receiptFile(job, stage);
  if (!existsSync(path)) throw new Error("Cannot carry forward missing " + stage + " receipt.");
  const receipt = JSON.parse(readFileSync(path, "utf8")) as {
    jobId?: string; planVersion?: number; milestoneId?: string; units?: unknown[];
    commitSha?: string; phase?: string;
  };
  const commit = historicalCommit(stage, receipt);
  if (receipt.jobId !== job.jobId || !receipt.planVersion ||
      receipt.planVersion > version || !commit || !SHA.test(commit) ||
      (stage !== "foundations" && receipt.milestoneId !== stage.split(":")[1])) {
    throw new Error("Cannot carry forward unfinished, mismatched or unverified " + stage + " work.");
  }
  git(job, "cat-file", "-e", commit + "^{commit}");
  git(job, "merge-base", "--is-ancestor", commit, head);
  const expected = stage === "foundations" ? "character-foundations"
    : stage.startsWith("interactive:") ? "interactive-puzzle-" + stage.split(".").at(-1)
    : stage.startsWith("event:") ? "event-" + stage.split(".").at(-1)
    : "composition-" + stage.split(".").at(-1);
  if (!git(job, "log", "-1", "--format=%B", commit).split("\n").includes("NovelTea-Work-Item: " + expected)) {
    throw new Error("Cannot carry forward work without the matching historical commit trailer: " + stage);
  }
  return receipt;
}

/** The author's Ed25519 plan signature binds an explicit list of reviewed
 * unaffected work items. Omitted items are never implicitly authorized. */
export function parseCarryForward(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== "string") ||
      value.some(x => x !== "foundations" && !/^(event|interactive|composition):milestone\.[a-z][a-z0-9-]*$/.test(x)) ||
      new Set(value).size !== value.length) {
    throw new Error("Carry-forward must be a unique JSON array of foundations or event|interactive|composition:milestone.<id> work items.");
  }
  for (const stage of value) {
    if (parentStages(stage).some(parent => !value.includes(parent))) {
      throw new Error("Carry-forward must include every upstream dependency of " + stage);
    }
  }
  return value;
}
export function verifyCarryForwardCandidates(
  job: JobStartResult, version: number, head: string, selected: string[],
) {
  for (const stage of selected) checkHistoricalWork(job, stage, version, head);
}

/** Both the signature and proposal digest are verified on every historical
 * carry-forward, so changing a receipt or an approval ledger cannot silently
 * upgrade old work to a newer plan version. */
export function hasPlanContinuity(
  job: JobStartResult, architecture: PlanSnapshot,
  stage: string, receiptVersion: number, fingerprint?: string, contractOnly = false,
) {
  const latest = architecture.plan;
  if (!latest || architecture.jobId !== job.jobId || architecture.phase !== "committed") return false;
  if (receiptVersion === latest.version) {
    return fingerprint === undefined || fingerprint === digest(contractOnly ? latest.contract : latest);
  }
  if (!Number.isSafeInteger(receiptVersion) || receiptVersion < 1 || receiptVersion > latest.version) return false;
  const history = architecture.history ?? [];
  for (let version = receiptVersion; version < latest.version; version++) {
    const step = history.find(h => h.plan?.version === version);
    if (!step) return false;
    const signed = verifyAuthorEvidence(job, step.signed);
    const payload = signed.payload;
    const proposed = { plan: step.plan, head: step.verifiedHead,
      contract: step.approvedContract,
      ...(step.carryForward !== undefined ? { carryForward: parseCarryForward(step.carryForward) } : {}) };
    if (payload.kind !== "plan" || payload.planVersion !== version + 1 ||
        payload.proposalSha256 !== step.proposal || payload.verifiedHead !== step.verifiedHead ||
        step.proposal !== digest(proposed) ||
        (version === receiptVersion && fingerprint !== undefined &&
          fingerprint !== digest(contractOnly ? step.plan.contract : step.plan))) {
      throw new Error("Historical plan carry-forward does not match its signed proposal or original work.");
    }
    if (version < latest.version - 1) {
      const successor = history.find(h => h.plan?.version === version + 1);
      if (!successor || JSON.stringify(step.approvedContract) !== JSON.stringify(successor.plan.contract))
        return false;
    } else {
      if (JSON.stringify(step.approvedContract) !== JSON.stringify(latest.contract)) return false;
      // The latest signed transition explicitly reviews the retained work.
      // A subsequent replan without this declaration invalidates it again.
      if (!step.carryForward?.includes(stage)) return false;
    }
  }
  checkHistoricalWork(job, stage, latest.version - 1, git(job, "rev-parse", "HEAD"));
  return true;
}

/** Report an explicit, actionable stale-plan error instead of changing old
 * commit trailers or loosening downstream version checks. */
export function assertPlanContinuity(
  job: JobStartResult, architecture: PlanSnapshot,
  stage: string, receiptVersion: number, fingerprint?: string, contractOnly = false,
) {
  if (!hasPlanContinuity(job, architecture, stage, receiptVersion, fingerprint, contractOnly)) {
    throw new Error(stage + " was authored under plan v" + receiptVersion +
      " and is not included in a signed carry-forward for plan v" + architecture.plan?.version +
      ". Review the impact and submit a new signed scope proposal with --carry-forward, " +
      "or reconcile affected canonical work through an author-reviewed revision and new Story job.");
  }
}
