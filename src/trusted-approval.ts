import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";

/**
 * Transitional trusted-controller ledger (#57). It does NOT authorize an
 * existing protected revision: #58 will migrate the old signed gates to this
 * ledger. Only a controller outside the Pi tool sandbox may call resolve().
 */
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
type SubjectKind = "plan" | "decision";
type Decision = "approved" | "rejected";
export interface ApprovalRequest {
  id: string;
  kind: SubjectKind;
  workItemId?: string;
  changeId?: string;
}
interface Identity {
  version: 1;
  id: string;
  jobId: string;
  threadId: string;
  baseSha: string;
  verifiedHead: string;
  proposalSha256: string;
  kind: SubjectKind;
  workItemId: string;
  changeId?: string;
  nonce: string;
}
interface Pending extends Identity { phase: "awaiting-controller"; }
interface Resolved extends Identity {
  phase: "recorded";
  decision: Decision;
  principal: string;
  source: "trusted-cli";
  recordedAt: string;
}
type Receipt = Pending | Resolved;
export type TrustedApprovalReceipt = Readonly<Receipt>;
const dir = (job: JobStartResult) => join(job.stateDir, "trusted-approvals");
const file = (job: JobStartResult, id: string) => join(dir(job), id + ".json");
const checkpointFile = (job: JobStartResult) => join(dir(job), "checkpoints.sqlite");

function checkId(id: string) {
  if (!ID.test(id) || id.length > 64) throw new Error("Invalid trusted approval ID.");
}
function head(job: JobStartResult) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: job.worktreeRoot, env, encoding: "utf8" }).trim();
}
async function json(path: string): Promise<any> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Trusted approval source/receipt is not a regular bounded file.");
  }
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(job: JobStartResult, receipt: Receipt) {
  await mkdir(dir(job), { recursive: true, mode: 0o700 });
  const path = file(job, receipt.id), tmp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
async function subject(job: JobStartResult, input: ApprovalRequest): Promise<Omit<Identity, "version" | "id" | "nonce">> {
  const current = head(job);
  if (input.kind === "plan") {
    if (input.changeId || (input.workItemId && input.workItemId !== "global-architecture")) {
      throw new Error("Plan approval must target global-architecture without a change ID.");
    }
    const path = join(job.stateDir, "architecture.json");
    if (!existsSync(path)) throw new Error("No current architecture proposal.");
    const r = await json(path);
    const verifiedHead = r.proposal?.baselineHead ?? r.expectedHead;
    const expectedDigest = r.plan && r.proposal?.contract
      ? createHash("sha256").update(JSON.stringify({
        plan: r.plan, head: verifiedHead, contract: r.proposal.contract,
        ...(r.proposal.carryForward !== undefined ? { carryForward: r.proposal.carryForward } : {}),
      })).digest("hex") : undefined;
    if (r.jobId !== job.jobId || r.baseSha !== job.baseSha ||
        (r.threadId && r.threadId !== job.threadId) ||
        !["ready", "committed"].includes(r.phase) ||
        !Number.isSafeInteger(r.plan?.version) ||
        r.proposal?.version !== r.plan.version + 1 ||
        !HASH.test(r.proposal?.digest ?? "") || r.proposal.digest !== expectedDigest ||
        verifiedHead !== current) {
      throw new Error("Architecture proposal does not match this job or current verified Git HEAD.");
    }
    return { kind: "plan", workItemId: "global-architecture", jobId: job.jobId,
      threadId: job.threadId, baseSha: job.baseSha, verifiedHead, proposalSha256: r.proposal.digest };
  }
  if (input.kind !== "decision" || !input.workItemId || !ID.test(input.workItemId) ||
      !input.changeId || !HASH.test(input.changeId)) {
    throw new Error("Protected approval requires an exact work item and change digest.");
  }
  const path = join(job.stateDir, "revisions", input.workItemId + ".json");
  if (!existsSync(path)) throw new Error("No current protected revision proposal.");
  const r = await json(path);
  if (r.jobId !== job.jobId || r.workItemId !== input.workItemId ||
      r.baseSha !== job.baseSha || r.status !== "proposed" ||
      !HASH.test(r.proposalSha256 ?? "") || r.verifiedHead !== current ||
      !Array.isArray(r.changes) || !r.changes.some((c: {id: string}) => c.id === input.changeId)) {
    throw new Error("Protected revision proposal does not match this job, change or verified Git HEAD.");
  }
  return { kind: "decision", workItemId: input.workItemId, changeId: input.changeId,
    jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
    verifiedHead: current, proposalSha256: r.proposalSha256 };
}
async function read(job: JobStartResult, id: string): Promise<Receipt> {
  checkId(id);
  const r = await json(file(job, id)) as Receipt;
  if (r.version !== 1 || r.id !== id || r.jobId !== job.jobId ||
      r.threadId !== job.threadId || r.baseSha !== job.baseSha ||
      !HASH.test(r.proposalSha256) || !/^[a-f0-9]{40,64}$/.test(r.verifiedHead) ||
      !/^[0-9a-f-]{36}$/.test(r.nonce) ||
      !["plan", "decision"].includes(r.kind) ||
      (r.kind === "decision" && (!r.changeId || !HASH.test(r.changeId))) ||
      !["awaiting-controller", "recorded"].includes(r.phase) ||
      (r.phase === "recorded" && (r.source !== "trusted-cli" ||
        !["approved", "rejected"].includes(r.decision) || !r.principal?.trim()))) {
    throw new Error("Saved trusted approval receipt has invalid identity or evidence.");
  }
  return r;
}
const BINDING = ["kind", "workItemId", "changeId", "jobId", "threadId",
  "baseSha", "verifiedHead", "proposalSha256"] as const;
function bindingMatches(a: Partial<Identity>, b: Partial<Identity>) {
  return BINDING.every(key => a[key] === b[key]);
}
async function assertCurrent(job: JobStartResult, r: Identity) {
  const now = await subject(job, { id: r.id, kind: r.kind, workItemId: r.workItemId, changeId: r.changeId });
  if (!bindingMatches(now, r)) {
    throw new Error("Approval is stale: exact proposal, job or verified head changed.");
  }
}

const Channels = Annotation.Root({
  id: Annotation<string>(),
  receipt: Annotation<Receipt>(),
});
async function openGraph(job: JobStartResult) {
  await mkdir(dir(job), { recursive: true, mode: 0o700 });
  const saver = SqliteSaver.fromConnString(checkpointFile(job));
  if (saver.db.pragma("quick_check", { simple: true }) !== "ok") {
    throw new Error("Trusted approval LangGraph checkpoints are corrupt.");
  }
  const graph = new StateGraph(Channels)
    .addNode("await_controller", async ({ receipt }) => {
      const response: unknown = interrupt({ kind: "trusted-approval", receipt });
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("Invalid typed trusted-controller response.");
      }
      const v = response as Record<string, unknown>;
      if (Object.keys(v).sort().join(",") !== "decision,nonce,principal,type" ||
          v.type !== "decision" || v.nonce !== receipt.nonce ||
          !["approved", "rejected"].includes(String(v.decision)) ||
          typeof v.principal !== "string" || !/^uid:[0-9]+:[a-zA-Z0-9_.-]+$/.test(v.principal)) {
        throw new Error("Trusted controller response does not match the pending nonce and principal.");
      }
      await assertCurrent(job, receipt);
      const existing = await read(job, receipt.id);
      if (existing.phase !== "awaiting-controller" || existing.nonce !== receipt.nonce ||
          !bindingMatches(existing, receipt)) {
        throw new Error("Trusted approval was already consumed or changed.");
      }
      const decided: Resolved = { ...receipt, phase: "recorded",
        source: "trusted-cli", decision: v.decision as Decision,
        principal: v.principal, recordedAt: new Date().toISOString() };
      await save(job, decided);
      return { receipt: decided };
    })
    .addEdge(START, "await_controller")
    .addEdge("await_controller", END)
    .compile({ checkpointer: saver });
  return { graph, saver };
}
const config = (job: JobStartResult, id: string) =>
  ({ configurable: { thread_id: "trusted-approval:" + job.threadId + ":" + id } });

/** Stage one exact request. Staging never creates permission to commit Story bytes. */
export async function requestTrustedApproval(job: JobStartResult, input: ApprovalRequest): Promise<TrustedApprovalReceipt> {
  checkId(input.id);
  return withStoryJobLock(job, "trusted-approval", async () => {
    const binding = await subject(job, input);
    const path = file(job, input.id);
    let receipt: Receipt;
    if (existsSync(path)) {
      receipt = await read(job, input.id);
      if (!bindingMatches(receipt, binding)) throw new Error("Approval ID already binds a different proposal.");
    } else {
      receipt = { version: 1, id: input.id, ...binding, nonce: randomUUID(), phase: "awaiting-controller" };
      await save(job, receipt);
    }
    if (receipt.phase === "recorded") return receipt;
    const { graph, saver } = await openGraph(job);
    try {
      const state = await graph.getState(config(job, input.id));
      if (state.next.length === 0 && state.values.id) {
        throw new Error("Approval checkpoint completed but its durable receipt is unresolved.");
      }
      if (!state.values.id) {
        await graph.invoke({ id: input.id, receipt }, config(job, input.id));
      } else if (state.values.id !== input.id || state.values.receipt?.nonce !== receipt.nonce ||
          !bindingMatches(state.values.receipt ?? {}, receipt) ||
          state.next.join(",") !== "await_controller") {
        throw new Error("Trusted approval checkpoint identity differs from pending request.");
      }
      return receipt;
    } finally {
      await saver.db.close?.();
    }
  });
}
export async function inspectTrustedApproval(job: JobStartResult, id: string): Promise<TrustedApprovalReceipt> {
  return read(job, id);
}
/** Called only by an authenticated trusted CLI controller, never from Pi tools or author-message JSON. */
async function persistControllerDecision(
  job: JobStartResult, id: string, decision: Decision, principal: string,
): Promise<TrustedApprovalReceipt> {
  checkId(id);
  if (!["approved", "rejected"].includes(decision) ||
      !/^uid:[0-9]+:[a-zA-Z0-9_.-]+$/.test(principal)) {
    throw new Error("Authenticated local controller principal and typed decision required.");
  }
  return withStoryJobLock(job, "trusted-approval", async () => {
    const receipt = await read(job, id);
    if (receipt.phase === "recorded") {
      if (receipt.decision !== decision || receipt.principal !== principal) {
        throw new Error("Approval nonce was consumed by a different decision or principal.");
      }
      return receipt;
    }
    await assertCurrent(job, receipt);
    const { graph, saver } = await openGraph(job);
    try {
      const state = await graph.getState(config(job, id));
      if (state.next.join(",") !== "await_controller" ||
          state.values.id !== id || state.values.receipt?.nonce !== receipt.nonce ||
          !bindingMatches(state.values.receipt ?? {}, receipt)) {
        throw new Error("No matching pending typed LangGraph interrupt to resume.");
      }
      await graph.invoke(new Command({ resume: { type: "decision", nonce: receipt.nonce,
        principal, decision } }), config(job, id));
      const after = await read(job, id);
      if (after.phase !== "recorded") throw new Error("Trusted controller decision was not durably recorded.");
      return after;
    } finally {
      await saver.db.close?.();
    }
  });
}

/** Trusted CLI entry: OS identity and confirmation are not supplied in JSON or
 * by model-invocable flags. Deploy outside the agent sandbox under the author's
 * OS account; a local TTY alone cannot isolate a same-UID unsandboxed Pi agent. */
export async function decideTrustedCliApproval(job: JobStartResult, id: string): Promise<TrustedApprovalReceipt> {
  const receipt = await inspectTrustedApproval(job, id);
  if (receipt.phase === "recorded") return receipt;
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.getuid?.() === undefined) {
    throw new Error("Trusted CLI approval requires an interactive authenticated local terminal; unattended CLI remains paused.");
  }
  const username = userInfo().username;
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error("Unsupported local controller account name.");
  const principal = "uid:" + process.getuid() + ":" + username;
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let response: string;
  try {
    response = (await rl.question(
      "Type APPROVE or REJECT followed by the FULL proposal SHA-256 to record this decision: "
    )).trim();
  } finally {
    rl.close();
  }
  const decision = response === "APPROVE " + receipt.proposalSha256 ? "approved" :
    response === "REJECT " + receipt.proposalSha256 ? "rejected" : undefined;
  if (!decision) throw new Error("Approval not confirmed; pending interrupt is unchanged.");
  return persistControllerDecision(job, id, decision, principal);
}
