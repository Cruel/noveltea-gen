import { execFileSync } from "./git-read-cache.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readRecoveryFork } from "./recovery-fork-state.js";
import type { JobStartResult } from "./job.js";
import type { CompletionContract, Plan } from "./architecture.js";
import { readPuzzleNoWriteSync, type PuzzleNoWriteRef } from "./puzzle-obligation.js";
import { verifyAuthorEvidence, type AuthorApprovalEvidence } from "./author-evidence.js";

export interface PlanHistoryStep {
  plan: Plan;
  proposal: string;
  approvedContract: CompletionContract;
  verifiedHead: string;
  carryForward?: string[];
  causalAmendment?: import("./causal-amendment.js").CausalAmendment;
  source: "trusted-controller";
  signed: AuthorApprovalEvidence;
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
  const base = job.stateDir;
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
    if (receipt.units?.length !== 2 || receipt.units[0]?.phase !== "committed") return;
    // The controller's separately sealed optional Puzzle no-write receipt
    // leaves Choice as the last authored interactive commit.
    if (receipt.units[1]?.phase === "not-applicable" && receipt.units[1]?.noWrite &&
        receipt.units[1]?.beforeHead) return receipt.units[0].commitSha;
    if (receipt.units[1]?.phase !== "committed") return;
    return receipt.units[1].commitSha;
  }
  return receipt.phase === "committed" ? receipt.commitSha : undefined;
}

/** Verify a requested carry-forward is backed by the exact immutable specialist
 * receipt and a commit still on the current verified branch. No writer is replayed. */
function checkHistoricalWork(job: JobStartResult, stage: string, version: number, head: string) {
  const path = receiptFile(job, stage);
  if (!existsSync(path)) throw new Error("Cannot carry forward missing " + stage + " receipt.");
  const receipt = JSON.parse(readFileSync(path, "utf8")) as {
    jobId?: string; planVersion?: number; planDigest?: string; milestoneId?: string;
    units?: Array<{ phase?: string; commitSha?: string; beforeHead?: string; noWrite?: PuzzleNoWriteRef }>;
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
  if (stage.startsWith("interactive:") && receipt.units?.[1]?.phase === "not-applicable") {
    const proof = readPuzzleNoWriteSync(job, stage.split(":")[1]!, receipt.units[1].noWrite);
    if (proof.unitId !== "interactive-puzzle-" + stage.split(".").at(-1) ||
        proof.choiceHead !== commit || proof.verifiedHead !== receipt.units[1].beforeHead ||
        proof.planDigest !== receipt.planDigest || proof.planVersion !== receipt.planVersion)
      throw new Error("Historical optional Puzzle lacks exact controller no-write provenance.");
    git(job, "merge-base", "--is-ancestor", proof.verifiedHead, head);
  }
  const expected = stage === "foundations" ? "character-foundations"
    : stage.startsWith("interactive:") ? (receipt.units?.[1]?.phase === "not-applicable"
      ? "interactive-choice-" : "interactive-puzzle-") + stage.split(".").at(-1)
    : stage.startsWith("event:") ? "event-" + stage.split(".").at(-1)
    : "composition-" + stage.split(".").at(-1);
  if (!git(job, "log", "-1", "--format=%B", commit).split("\n").includes("NovelTea-Work-Item: " + expected)) {
    throw new Error("Cannot carry forward work without the matching historical commit trailer: " + stage);
  }
  return receipt;
}

/** The author's persisted controller decision binds an explicit list of reviewed
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

/** Both the controller receipt and proposal digest are verified on every historical
 * carry-forward, so changing a receipt or an approval ledger cannot silently
 * upgrade old work to a newer plan version. */
export function hasPlanContinuity(
  job: JobStartResult, architecture: PlanSnapshot,
  stage: string, receiptVersion: number, fingerprint?: string, contractOnly = false,
) {
  const latest = architecture.plan;
  if (!latest || architecture.jobId !== job.jobId || architecture.phase !== "committed") return false;
  const fork = readRecoveryFork(job);
  if (fork && (stage === "foundations" || /^(event|interactive|composition):/.test(stage)) &&
      digest(latest) === fork.checkpoint.planDigest) {
    const original = fork.receipts[relative(job.stateDir, receiptFile(job, stage))];
    if (original?.planVersion === receiptVersion &&
        (fingerprint === undefined || fingerprint === (contractOnly ? original.contractDigest : original.planDigest))) return true;
  }
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
      ...(step.carryForward !== undefined ? { carryForward: parseCarryForward(step.carryForward) } : {}),
      ...(step.causalAmendment ? { causalAmendment: step.causalAmendment } : {}) };
    if (payload.kind !== "plan" || payload.planVersion !== version + 1 ||
        payload.proposalSha256 !== step.proposal || payload.verifiedHead !== step.verifiedHead ||
        step.proposal !== digest(proposed) ||
        (version === receiptVersion && fingerprint !== undefined &&
          fingerprint !== digest(contractOnly ? step.plan.contract : step.plan))) {
      throw new Error("Historical plan carry-forward does not match its signed proposal or original work.");
    }
    // Every signed transition must explicitly retain this historical work,
    // not just the most recent replan. Otherwise a v1 receipt can silently
    // skip a v2 decision that revoked its continuity.
    if (!step.carryForward?.includes(stage)) return false;
    if (version < latest.version - 1) {
      const successor = history.find(h => h.plan?.version === version + 1);
      if (!successor || JSON.stringify(step.approvedContract) !== JSON.stringify(successor.plan.contract))
        return false;
    } else {
      if (JSON.stringify(step.approvedContract) !== JSON.stringify(latest.contract)) return false;
    }
  }
  checkHistoricalWork(job, stage, latest.version - 1, git(job, "rev-parse", "HEAD"));
  return true;
}

/** Revalidate the original foundation's exact Architecture source across
 * every signed carry-forward, never just the most recent History entry. */
export function assertFoundationArchitectureContinuity(
  job: JobStartResult, architecture: PlanSnapshot & { expectedHead: string },
  foundation: { planVersion: number; architectureHead: string },
  fingerprint?: string,
) {
  assertPlanContinuity(job, architecture, "foundations", foundation.planVersion,
    fingerprint, fingerprint !== undefined);
  if (foundation.planVersion === architecture.plan?.version) {
    if (foundation.architectureHead !== architecture.expectedHead)
      throw Error("Current Foundations receipt refers to a different Architecture HEAD.");
    return;
  }
  const origin = architecture.history?.find(step => step.plan.version === foundation.planVersion);
  if (!origin || origin.plan.items[0]?.verifiedSha !== foundation.architectureHead)
    throw Error("Carried Foundations do not match their original signed Architecture source.");
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
