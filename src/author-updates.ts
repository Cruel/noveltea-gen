import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { startStoryJob, type JobStartResult } from "./job.js";
import { withStoryJobLock } from "./job-lock.js";
import { readJobControl as control, setJobControl as setControl, type JobControl } from "./job-control.js";
import { inspectActiveStorySpecialist } from "./story-interruption.js";
import { captureIdeaUnderJobLock, reconcileCapturedIdeaUnderJobLock } from "./ideas.js";
import { runArchitectureJob } from "./architecture.js";
import { runRevisionAction } from "./revision.js";
import { verifyAuthorEvidence, type AuthorApprovalEvidence } from "./author-evidence.js";

type Kind = "idea" | "change" | "question" | "approval";
type Phase = "queued" | "awaiting-author" | "applied" | "review-required";
type Control = JobControl;
interface Message {
  version: 1; id: string; jobId: string; threadId: string;
  kind: Kind; payload: unknown; digest: string; createdAt: string;
}
interface Receipt {
  version: 1; id: string; jobId: string; threadId: string; digest: string;
  phase: Phase; result?: unknown; pinned?: Pinned;
  /** Authenticated web intent is bound before invoking the interrupt, so a
   * crash/retry cannot change the actor or answer for the saved checkpoint. */
  webController?: { principal: string; responseSha256: string; headSha: string };
}
interface Pinned {
  jobId: string; threadId: string; branch: string; baseSha: string;
  headSha: string; planVersion: number | null; skillSnapshot: string | null;
  piSessions: { foundation?: string; architecture?: string; world?: string; character?: string };
}
interface ResumeAnswer { type: "answer"; messageId: string; answer: string }
interface ResumeDecision { type: "decision"; messageId: string; approval: { receiptId: string; nonce: string } }
type Resume = ResumeAnswer | ResumeDecision;
export interface AuthorAction {
  story: string; job: string; action: "send" | "inspect" | "process" | "resume" | "control" | "plan";
  file?: string; id?: string; state?: Control; limit?: number; carryForward?: string[];
}
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return "{" + Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + stable(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
const root = (job: JobStartResult) => join(job.stateDir, "author-updates");
const incoming = (job: JobStartResult, id: string) => join(root(job), "messages", id + ".json");
const statusFile = (job: JobStartResult, id: string) => join(root(job), "receipts", id + ".json");
const snapshotFile = (job: JobStartResult, name: string) => join(job.stateDir, name + ".json");
function git(job: JobStartResult, ...args: string[]) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8", env }).trim();
}
async function regular(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("Author update state must be a regular file.");
}
async function loadJson(path: string): Promise<any> {
  await regular(path);
  return JSON.parse(await readFile(path, "utf8"));
}
async function persist(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(tmp, path);
}
function parseMessage(value: unknown): { id: string; kind: Kind; payload: unknown; digest: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Author message must be a JSON object.");
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every(k => ["id", "kind", "payload"].includes(k)) ||
      !["idea", "change", "question", "approval"].includes(String(v.kind)) ||
      !v.payload || typeof v.payload !== "object" || Array.isArray(v.payload)) {
    throw new Error("Author message requires kind and object payload; unsupported fields are rejected.");
  }
  const kind = v.kind as Kind;
  const p = v.payload as Record<string, unknown>;
  if (kind === "change" && (typeof p.text !== "string" || !p.text.trim() ||
      !Array.isArray(p.affectedIds) || !p.affectedIds.every(x => typeof x === "string" && x.trim()))) {
    throw new Error("Direct change requires text and explicit affectedIds for impact review.");
  }
  if (kind === "question" && (typeof p.question !== "string" || !p.question.trim())) {
    throw new Error("Author question requires a nonempty question.");
  }
  if (kind === "approval" && (!["plan", "decision"].includes(String(p.requestType)) ||
      typeof p.proposalSha256 !== "string" || !HASH.test(p.proposalSha256) ||
      (p.requestType === "decision" && (typeof p.workItemId !== "string" ||
        typeof p.changeId !== "string" || !HASH.test(p.changeId))))) {
    throw new Error("Approval request must bind an exact proposed plan or protected decision proposal.");
  }
  const digest = sha(stable({ kind, payload: v.payload }));
  const id = v.id ?? "message-" + digest.slice(0, 24);
  if (typeof id !== "string" || !ID.test(id) || id.length > 64) throw new Error("Invalid author message stable ID.");
  return { id, kind, payload: v.payload, digest };
}
async function loadMessage(job: JobStartResult, id: string): Promise<Message> {
  const m = await loadJson(incoming(job, id)) as Message;
  if (m.version !== 1 || m.id !== id || m.jobId !== job.jobId || m.threadId !== job.threadId ||
      !HASH.test(m.digest) || sha(stable({ kind: m.kind, payload: m.payload })) !== m.digest) {
    throw new Error("Saved author message identity or contents changed.");
  }
  return m;
}
async function loadReceipt(job: JobStartResult, m: Message): Promise<Receipt> {
  if (!existsSync(statusFile(job, m.id))) return {
    version: 1, id: m.id, jobId: job.jobId, threadId: job.threadId, digest: m.digest, phase: "queued",
  };
  const r = await loadJson(statusFile(job, m.id)) as Receipt;
  if (r.version !== 1 || r.id !== m.id || r.jobId !== job.jobId ||
      r.threadId !== job.threadId || r.digest !== m.digest ||
      !["queued", "awaiting-author", "applied", "review-required"].includes(r.phase)) {
    throw new Error("Saved author message acknowledgement is invalid.");
  }
  return r;
}
async function saveReceipt(job: JobStartResult, r: Receipt) { await persist(statusFile(job, r.id), r); }
async function readPinned(job: JobStartResult): Promise<Pinned> {
  const arch = existsSync(snapshotFile(job, "architecture")) ? await loadJson(snapshotFile(job, "architecture")) : null;
  const foundation = existsSync(snapshotFile(job, "foundation")) ? await loadJson(snapshotFile(job, "foundation")) : null;
  const cw = existsSync(snapshotFile(job, "character-world")) ? await loadJson(snapshotFile(job, "character-world")) : null;
  return {
    jobId: job.jobId, threadId: job.threadId, branch: job.branch, baseSha: job.baseSha,
    headSha: git(job, "rev-parse", "HEAD"),
    planVersion: arch?.plan?.version ?? null, skillSnapshot: arch?.snapshot?.id ?? foundation?.snapshot?.id ?? cw?.snapshot?.id ?? null,
    piSessions: { foundation: foundation?.piSessionId, architecture: arch?.piSessionId,
      world: cw?.units?.[0]?.piSessionId, character: cw?.units?.[1]?.piSessionId },
  };
}
function matchesPinned(actual: Pinned, pinned: Pinned) {
  return stable(actual) === stable(pinned);
}
async function send(job: JobStartResult, input: unknown) {
  const parsed = parseMessage(input);
  const path = incoming(job, parsed.id);
  // Enqueue never takes the job writer lock: it must work WHILE Pi is editing.
  // A stable ID is atomically created with wx, so parallel sends cannot overwrite.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, JSON.stringify({ version: 1, ...parsed, jobId: job.jobId,
      threadId: job.threadId, createdAt: new Date().toISOString() }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const saved = await loadMessage(job, parsed.id);
  if (saved.digest !== parsed.digest) throw new Error("Stable author message ID collides with different content.");
  return loadReceipt(job, saved);
}
async function messages(job: JobStartResult) {
  const dir = join(root(job), "messages");
  if (!existsSync(dir)) return [] as Message[];
  const files = (await readdir(dir)).sort();
  if (files.some(f => !/^[a-z][a-z0-9-]*\.json$/.test(f))) throw new Error("Unexpected author inbox file.");
  const values = await Promise.all(files.map(f => loadMessage(job, f.slice(0, -5))));
  return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
async function evaluateChange(job: JobStartResult, payload: Record<string, unknown>) {
  const archFile = snapshotFile(job, "architecture");
  const arch = existsSync(archFile) ? await loadJson(archFile) : null;
  const affected = payload.affectedIds as string[];
  const plan = arch?.plan as { version?: number; contract?: { scope?: { targets?: string[]; depth?: string } };
    items?: Array<{ id: string; targetIds: string[]; status: string }> } | undefined;
  const targets = plan?.contract?.scope?.targets ?? [];
  const items = (plan?.items ?? []).filter(item =>
    !affected.length || affected.some(id => item.targetIds?.includes(id)));
  const impact = { request: payload.text, affectedIds: affected, planVersion: plan?.version ?? null,
    scopeDepth: plan?.contract?.scope?.depth ?? null,
    inScope: affected.length > 0 && (targets.length === 0 || affected.every(id => targets.includes(id))),
    impactedWorkItems: items.map(item => ({ id: item.id, status: item.status })),
    action: "independent-impact-review-required", review: "unverified" };
  // A proposed contract is not consent; require the versioned plan's
  // persisted trusted-controller decision.
  if (payload.proposedContract !== undefined) {
    const proposal = await runArchitectureJob({
      story: job.storyRoot, job: job.jobId, action: "propose", contract: payload.proposedContract,
    }, true);
    return { ...impact, proposal, next: "trusted-plan-approval-required" };
  }
  return { ...impact, next: "author-must-review-impact-and-propose-scope-change-if-needed" };
}
async function validateApprovalRequest(job: JobStartResult, payload: Record<string, unknown>) {
  if (payload.requestType === "plan") {
    const file = snapshotFile(job, "architecture");
    if (!existsSync(file)) throw new Error("Approval request has no existing architecture plan proposal.");
    const receipt = await loadJson(file) as {
      jobId?: string; phase?: string; expectedHead?: string; proposal?: { digest?: string; baselineHead?: string };
    };
    if (receipt.jobId !== job.jobId || receipt.proposal?.digest !== payload.proposalSha256 ||
        !["ready", "committed"].includes(receipt.phase ?? "") ||
        (receipt.proposal?.baselineHead ?? receipt.expectedHead) !== git(job, "rev-parse", "HEAD")) {
      throw new Error("Approval request is not bound to a current exact versioned plan proposal.");
    }
    return;
  }
  const file = join(job.stateDir, "revisions", String(payload.workItemId) + ".json");
  if (!existsSync(file)) throw new Error("Protected approval request has no existing revision proposal.");
  const receipt = await loadJson(file) as { jobId?: string; status?: string; proposalSha256?: string;
    verifiedHead?: string; changes?: Array<{ id: string }> };
  if (receipt.jobId !== job.jobId || receipt.status !== "proposed" ||
      receipt.proposalSha256 !== payload.proposalSha256 ||
      receipt.verifiedHead !== git(job, "rev-parse", "HEAD") ||
      !receipt.changes?.some(change => change.id === payload.changeId)) {
    throw new Error("Protected approval request must match a current exact revision proposal and change digest.");
  }
}
function validateResume(message: Message, raw: unknown): Resume {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid typed author response.");
  const v = raw as Record<string, unknown>;
  if (v.messageId !== message.id) throw new Error("Author response belongs to a different pending message.");
  if (message.kind === "question" && v.type === "answer" &&
      Object.keys(v).sort().join(",") === "answer,messageId,type" &&
      typeof v.answer === "string" && v.answer.trim()) return v as unknown as ResumeAnswer;
  if (message.kind === "approval" && v.type === "decision" &&
      Object.keys(v).sort().join(",") === "approval,messageId,type") {
    return v as unknown as ResumeDecision;
  }
  throw new Error("Typed resume must answer the exact question or supply a controller reference for the exact approval.");
}
async function previousApproval(job: JobStartResult, signed: AuthorApprovalEvidence) {
  const payload = signed.payload;
  if (payload.kind === "plan") {
    const file = snapshotFile(job, "architecture");
    if (!existsSync(file)) return null;
    const receipt = await loadJson(file) as { history?: Array<{ signed: AuthorApprovalEvidence }> };
    if (receipt.history?.some(x => x.signed.receiptId === signed.receiptId && x.signed.nonce === signed.nonce)) {
      return { action: "controller-plan-approval", proposalSha256: payload.proposalSha256, recorded: true };
    }
  }
  if (payload.kind === "decision") {
    const file = join(job.stateDir, "revisions", payload.workItemId + ".json");
    if (!existsSync(file)) return null;
    const receipt = await loadJson(file) as { approvals?: Array<{ signed: AuthorApprovalEvidence }> };
    if (receipt.approvals?.some(x => x.signed.receiptId === signed.receiptId && x.signed.nonce === signed.nonce)) {
      return { action: "controller-protected-decision", workItemId: payload.workItemId,
        proposalSha256: payload.proposalSha256, recorded: true };
    }
  }
  return null;
}
async function resolveChangedScope(job: JobStartResult, proposalSha256: string) {
  for (const message of await messages(job)) {
    if (message.kind !== "change") continue;
    const receipt = await loadReceipt(job, message);
    if (receipt.phase !== "review-required") continue;
    const result = receipt.result as { proposal?: { proposal?: { digest?: string } } } | undefined;
    if (result?.proposal?.proposal?.digest !== proposalSha256) continue;
    await saveReceipt(job, { ...receipt, phase: "applied",
      result: { ...receipt.result as object, review: "explicit-controller-plan-approval",
        acceptedProposalSha256: proposalSha256 } });
  }
}
function checkApprovalBinding(job: JobStartResult, message: Message, verified: AuthorApprovalEvidence,
  expectedHead?: string) {
  const request = message.payload as Record<string, unknown>;
  const p = verified.payload;
  if (p.proposalSha256 !== request.proposalSha256 ||
      (expectedHead !== undefined && p.verifiedHead !== expectedHead) ||
      (request.requestType === "plan" && p.kind !== "plan") ||
      (request.requestType === "decision" && (p.kind !== "decision" ||
        p.workItemId !== request.workItemId || p.changeId !== request.changeId))) {
    throw new Error("Controller response is not bound to this exact proposal, change and verified Git HEAD.");
  }
  if (p.jobId !== job.jobId || p.threadId !== job.threadId) {
    throw new Error("Controller response belongs to another job thread.");
  }
}
async function applyApproval(job: JobStartResult, message: Message, raw: ResumeDecision) {
  const verified = verifyAuthorEvidence(job, raw.approval);
  const signed = verified.payload;
  checkApprovalBinding(job, message, verified, git(job, "rev-parse", "HEAD"));
  const previous = await previousApproval(job, verified);
  if (previous) {
    if (signed.kind === "plan") await resolveChangedScope(job, signed.proposalSha256);
    return previous;
  }
  const signedFile = join(root(job), "signed", message.id + ".json");
  if (!existsSync(signedFile)) {
    await mkdir(dirname(signedFile), { recursive: true });
    await writeFile(signedFile, JSON.stringify(verified, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } else if (stable(await loadJson(signedFile)) !== stable(verified)) {
    throw new Error("Previously recorded response reference changed.");
  }
  if (signed.kind === "plan") {
    const result = await runArchitectureJob({ story: job.storyRoot, job: job.jobId, action: "approve",
      proposal: signed.proposalSha256, approvalFile: signedFile }, true);
    await resolveChangedScope(job, signed.proposalSha256);
    return { action: "controller-plan-approval", proposalSha256: signed.proposalSha256, result };
  }
  if (signed.kind === "decision") {
    const result = await runRevisionAction({ story: job.storyRoot, job: job.jobId,
      action: "authorize", workItem: signed.workItemId, proposal: signed.proposalSha256,
      approvalFile: signedFile }, true);
    return { action: "controller-protected-decision", proposalSha256: signed.proposalSha256, result };
  }
  throw new Error("Only exact controller plan/protected-decision approvals may resume this gate.");
}
const Channels = Annotation.Root({
  messageId: Annotation<string>(),
  kind: Annotation<Kind>(),
  pinned: Annotation<Pinned>(),
  phase: Annotation<Phase>(),
  result: Annotation<unknown>(),
});
async function openGraph(job: JobStartResult) {
  const file = join(root(job), "checkpoints.sqlite");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) await regular(file);
  const saver = SqliteSaver.fromConnString(file);
  if (saver.db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Author update checkpoints are corrupt.");
  const graph = new StateGraph(Channels)
    .addNode("process_author_updates", async (state) => {
      const message = await loadMessage(job, state.messageId);
      const receipt = await loadReceipt(job, message);
      if (receipt.phase === "applied" || receipt.phase === "review-required") {
        return { phase: receipt.phase, result: receipt.result };
      }
      if (receipt.phase === "awaiting-author") return { phase: receipt.phase, result: receipt.result };
      const pinned = await readPinned(job);
      if (!matchesPinned(pinned, state.pinned)) {
        // A crash may occur after an exact idea capture's verified commit but
        // before its author-message acknowledgement or graph checkpoint.
        // Only that same persisted capture may reconcile the changed HEAD.
        if (message.kind === "idea") {
          const captured = await reconcileCapturedIdeaUnderJobLock(job, message.payload, state.pinned.headSha);
          if (captured) {
            const acknowledged = { ...receipt, phase: "applied" as const, result: captured, pinned: state.pinned };
            await saveReceipt(job, acknowledged);
            return { phase: acknowledged.phase, result: captured, pinned: state.pinned };
          }
        }
        throw new Error("Story plan, original Pi sessions, or Git HEAD changed before processing an author message.");
      }
      let result: unknown; let phase: Phase;
      if (message.kind === "idea") {
        result = await captureIdeaUnderJobLock(job, message.payload);
        // Test-only crash point: the Git commit and capture receipt are durable,
        // but neither this node nor the message acknowledgement has published.
        if (process.env.NT_TEST_AUTHOR_CRASH_AFTER_CAPTURE === "1") {
          throw new Error("Injected crash after verified author idea capture.");
        }
        phase = "applied";
      } else if (message.kind === "change") {
        result = await evaluateChange(job, message.payload as Record<string, unknown>);
        phase = "review-required";
      } else {
        if (message.kind === "approval") {
          await validateApprovalRequest(job, message.payload as Record<string, unknown>);
        }
        result = { request: message.payload, kind: message.kind,
          prompt: message.kind === "question" ? (message.payload as { question: string }).question :
            "Review the exact proposal and record a trusted controller decision." };
        phase = "awaiting-author";
      }
      await saveReceipt(job, { ...receipt, phase, result, pinned });
      return { phase, result, pinned };
    })
    .addNode("await_author", async (state) => {
      const message = await loadMessage(job, state.messageId);
      const response = interrupt({ messageId: message.id, kind: message.kind,
        prompt: state.result, expected: message.kind === "question" ? "answer" : "decision" });
      const typed = validateResume(message, response);
      const current = await readPinned(job);
      if (!matchesPinned(current, state.pinned)) {
        throw new Error("Paused job's Git HEAD, plan, pinned skill, or Pi session identity changed.");
      }
      const result = typed.type === "answer"
        ? { answer: typed.answer, source: "explicit-author-response" }
        : await applyApproval(job, message, typed);
      const receipt = await loadReceipt(job, message);
      await saveReceipt(job, { ...receipt, phase: "applied", result, pinned: state.pinned });
      return { phase: "applied" as const, result };
    })
    .addEdge(START, "process_author_updates")
    .addConditionalEdges("process_author_updates",
      state => state.phase === "awaiting-author" ? "await_author" : END,
      ["await_author", END])
    .addEdge("await_author", END)
    .compile({ checkpointer: saver });
  return { graph, saver };
}
function config(job: JobStartResult, id: string) {
  return { configurable: { thread_id: "author-update:" + job.threadId + ":" + id } };
}
async function processOne(job: JobStartResult, message: Message, response?: Resume) {
  // This is an independently resumable graph, not a parent-checkpoint subgraph.
  // Inherited Pregel internals otherwise redirect its SQLite checkpoint namespace
  // and bubble its interrupt into the caller, breaking `job author resume`.
  const parent = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: parent?.callbacks, tags: parent?.tags },
    () => processOneIsolated(job, message, response));
}
async function processOneIsolated(job: JobStartResult, message: Message, response?: Resume) {
  const before = await loadReceipt(job, message);
  if (before.phase === "applied" || before.phase === "review-required") return before;
  // The approval side effect may have committed before the graph's interrupt
  // checkpoint and message acknowledgement. Verify the original author
  // reference against the actual versioned approval ledger before reconciling
  // that narrow crash window; never rerun a protected mutation.
  if (response?.type === "decision") {
    const verified = verifyAuthorEvidence(job, response.approval);
    checkApprovalBinding(job, message, verified, before.pinned?.headSha);
    const prior = await previousApproval(job, verified);
    if (prior) {
      if (verified.payload.kind === "plan") await resolveChangedScope(job, verified.payload.proposalSha256);
      const receipt = { ...before, phase: "applied" as const, result: prior };
      await saveReceipt(job, receipt);
      return receipt;
    }
  }
  const { graph, saver } = await openGraph(job);
  try {
    const cfg = config(job, message.id);
    const snapshot = await graph.getState(cfg);
    const next = snapshot.next.map(String);
    if (next.length && (next.length !== 1 ||
        !["await_author", "process_author_updates"].includes(next[0]!))) {
      throw new Error("Unexpected saved author-update graph transition.");
    }
    if (response && next[0] !== "await_author") {
      throw new Error("This author update has no active LangGraph approval/question interrupt.");
    }
    if (snapshot.values.messageId && (snapshot.values.messageId !== message.id ||
        snapshot.values.kind !== message.kind)) {
      throw new Error("Persisted update checkpoint belongs to another author message.");
    }
    if (!response && next[0] === "await_author") {
      if (!matchesPinned(await readPinned(job), snapshot.values.pinned)) {
        throw new Error("Pending author interrupt is bound to changed source/plan state.");
      }
      const waiting = { ...before, phase: "awaiting-author" as const,
        result: snapshot.values.result, pinned: snapshot.values.pinned };
      await saveReceipt(job, waiting);
      return waiting;
    }
    if (!response && !next.length && snapshot.values.messageId) {
      // Node effects may have been durable before the acknowledgement write.
      // Reconcile only an exact existing capture or a checkpoint with unchanged
      // pinned source; never silently rerun a protected approval.
      const savedPhase = snapshot.values.phase;
      const pinned = snapshot.values.pinned;
      if (savedPhase === "applied" && message.kind === "idea") {
        const captured = await reconcileCapturedIdeaUnderJobLock(job, message.payload, pinned.headSha);
        if (!captured) throw new Error("Completed idea graph lacks verified capture evidence.");
        const recovered = { ...before, phase: "applied" as const, result: captured, pinned };
        await saveReceipt(job, recovered);
        return recovered;
      }
      if (savedPhase === "review-required" && message.kind === "change" &&
          matchesPinned(await readPinned(job), pinned)) {
        const result = await evaluateChange(job, message.payload as Record<string, unknown>);
        if (stable(result) !== stable(snapshot.values.result)) {
          throw new Error("Completed impact review cannot be reconciled to the saved result.");
        }
        const recovered = { ...before, phase: "review-required" as const, result, pinned };
        await saveReceipt(job, recovered);
        return recovered;
      }
      if (savedPhase === "applied" && message.kind === "question" &&
          matchesPinned(await readPinned(job), pinned)) {
        const recovered = { ...before, phase: "applied" as const, result: snapshot.values.result, pinned };
        await saveReceipt(job, recovered);
        return recovered;
      }
      if (savedPhase === "applied" && message.kind === "approval") {
        const signedFile = join(root(job), "signed", message.id + ".json");
        if (existsSync(signedFile)) {
          const signed = verifyAuthorEvidence(job, await loadJson(signedFile));
          checkApprovalBinding(job, message, signed, pinned.headSha);
          const previous = await previousApproval(job, signed);
          if (previous) {
            if (signed.payload.kind === "plan") await resolveChangedScope(job, signed.payload.proposalSha256);
            const recovered = { ...before, phase: "applied" as const, result: previous, pinned };
            await saveReceipt(job, recovered);
            return recovered;
          }
        }
      }
      throw new Error("Completed author graph lacks recoverable durable acknowledgement.");
    }
    let input: typeof Channels.State | Command;
    if (response) input = new Command({ resume: response });
    else if (snapshot.values.messageId) {
      // Continue the exact pending graph node, not a new message. A previously
      // committed side effect is reconciled inside process_author_updates.
      input = null as unknown as typeof Channels.State;
    } else {
      input = { messageId: message.id, kind: message.kind, pinned: await readPinned(job),
        phase: "queued", result: null };
    }
    await graph.invoke(input as Parameters<typeof graph.invoke>[0], cfg);
    const after = await loadReceipt(job, message);
    return after;
  } finally {
    await saver.db.close?.();
  }
}
async function drain(job: JobStartResult, limit = 100) {
  const state = await control(job);
  if (state !== "running") return { status: state, processed: [], blockers: [state] };
  const processed: Array<{ id: string; phase: Phase; result?: unknown }> = [];
  const blockers: string[] = [];
  for (const message of await messages(job)) {
    if (processed.length >= limit) break;
    const r = await loadReceipt(job, message);
    if (r.phase === "applied") continue;
    if (r.phase === "review-required") {
      blockers.push("review-required:" + message.id);
      continue;
    }
    if (r.phase === "awaiting-author") {
      blockers.push("awaiting-author:" + message.id);
      break; // New messages cannot implicitly resume a paused approval.
    }
    const current = await processOne(job, message);
    processed.push({ id: message.id, phase: current.phase, result: current.result });
    if (current.phase !== "applied") {
      blockers.push(current.phase + ":" + message.id);
      break;
    }
  }
  return { status: blockers.length ? "blocked" : "ready", processed, blockers };
}
/** Post-work safe boundary: surface a pause/review as author-facing evidence
 * without retroactively marking an independently committed worker as failed. */
export async function processAuthorUpdatesAfterWork(job: JobStartResult) {
  try { return await drain(job); }
  catch (error) {
    // A successful specialist commit must not be reported as uncommitted merely
    // because a newly received author update needs repair or manual review.
    return { status: "blocked", processed: [], blockers: ["author-update-processing-error"],
      error: error instanceof Error ? error.message : String(error) };
  }
}
/** Safe-boundary hook; CALL ONLY while already holding withStoryJobLock. */
export async function processAuthorUpdatesAtBoundary(job: JobStartResult) {
  const result = await drain(job);
  if (result.status !== "ready") throw new Error(
    "Story job cannot advance: queued author update requires action: " + result.blockers.join(", "));
  return result;
}
/** Queues a typed author message without taking the writer lock, allowing
 * ideas and proposed changes while a specialist is actively editing. */
export async function sendAuthorUpdate(job: JobStartResult, input: unknown): Promise<Receipt> {
  const state = await control(job)
  if (state === 'cancelled' || state === 'completed')
    throw new Error('Canceled/completed job cannot accept new narrative messages.')
  return send(job, input)
}

/** Shared CLI/web inspection and typed LangGraph resume. The caller must
 * establish trusted job identity; no request path or principal is accepted here. */
export async function inspectAuthorUpdates(job: JobStartResult): Promise<{
  status: Control; records: Array<{ message: Message; acknowledgement: Receipt }>
}> {
  return { status: await control(job), records: await Promise.all(
    (await messages(job)).map(async message => ({ message, acknowledgement: await loadReceipt(job, message) })),
  ) };
}

export async function resumeAuthorUpdate(job: JobStartResult, value: unknown, principal?: string): Promise<Receipt> {
  return withStoryJobLock(job, "process-author-updates", async () => {
    const id = (value as { messageId?: unknown } | null)?.messageId;
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Typed response needs a valid messageId.");
    const message = await loadMessage(job, id);
    const typed = validateResume(message, value);
    if (typed.type === "decision") verifyAuthorEvidence(job, typed.approval);
    const previous = await loadReceipt(job, message);
    if (principal !== undefined) {
      if (!/^user:[A-Za-z0-9_-]{1,128}$/.test(principal)) throw new Error("Invalid authenticated web controller.");
      const responseSha256 = sha(stable(typed));
      if (previous.webController && (previous.webController.principal !== principal ||
          previous.webController.responseSha256 !== responseSha256)) {
        throw new Error("Author response already bound to another actor or answer.");
      }
      if (previous.phase === "applied") {
        if (!previous.webController) throw new Error("Author response was already handled by another controller.");
        return previous;
      }
      if (await control(job) !== "running") throw new Error("Paused/canceled/completed job cannot resume.");
      const pinned = await readPinned(job);
      if (previous.phase !== "awaiting-author" || !previous.pinned ||
          !matchesPinned(pinned, previous.pinned)) throw new Error("No current matching author interrupt.");
      if (previous.webController && previous.webController.headSha !== pinned.headSha) {
        throw new Error("Controller response bound to a different Git HEAD.");
      }
      if (!previous.webController) await saveReceipt(job, { ...previous,
        webController: { principal, responseSha256, headSha: pinned.headSha } });
    } else {
      if (previous.webController) throw new Error("A web controller already owns this response.");
      if (await control(job) !== "running") throw new Error("Paused/canceled/completed job cannot resume.");
    }
    return processOne(job, message, typed);
  });
}

export async function runAuthorAction(options: AuthorAction): Promise<unknown> {
  const job = await startStoryJob({ story: options.story, job: options.job }, false);
  if (options.action !== "plan" && options.carryForward !== undefined) {
    throw new Error("Only author plan accepts a carry-forward impact review.");
  }
  if (options.action === "send") {
    if (!options.file || options.state) throw new Error("Send requires --file <message.json>.");
    const current = await control(job);
    if (current === "cancelled" || current === "completed") {
      throw new Error("Canceled/completed job cannot accept new narrative messages.");
    }
    return send(job, await loadJson(options.file));
  }
  if (options.action === "inspect") {
    const records = await Promise.all((await messages(job)).map(async message => ({
      message, acknowledgement: await loadReceipt(job, message),
    })));
    return { status: await control(job), jobId: job.jobId, activeSpecialist: await inspectActiveStorySpecialist(job), records };
  }
  if (options.action === "control") {
    if (!options.state || options.file) throw new Error("Execution control requires --state running|paused|cancelled|completed.");
    await setControl(job, options.state);
    return { status: options.state, jobId: job.jobId, activeSpecialist: await inspectActiveStorySpecialist(job) };
  }
  if (options.action === "resume") {
    if (!options.file) throw new Error("Resume requires --file <typed-response.json>.");
    return resumeAuthorUpdate(job, await loadJson(options.file));
  }
  return withStoryJobLock(job, "process-author-updates", async () => {
    if (options.action === "plan") {
      if (!options.id || !ID.test(options.id) || !options.file || options.state || options.limit) {
        throw new Error("Review replanning requires --id <change-message> and --file <contract.json>.");
      }
      if (await control(job) !== "running") throw new Error("Paused/cancelled/completed job cannot replan.");
      const message = await loadMessage(job, options.id);
      const receipt = await loadReceipt(job, message);
      if (message.kind !== "change" || receipt.phase !== "review-required") {
        throw new Error("Only a pending direct-change impact review can receive a scope proposal.");
      }
      if ((receipt.result as { proposal?: unknown })?.proposal) {
        throw new Error("This change already has a proposed scope; approve or reject it explicitly.");
      }
      const contract: unknown = await loadJson(options.file);
      const proposal = await runArchitectureJob({
        story: job.storyRoot, job: job.jobId, action: "propose", contract,
        carryForward: options.carryForward,
      }, true);
      const revised = { ...receipt, result: { ...(receipt.result as object),
        proposal, next: "trusted-plan-approval-required" } };
      await saveReceipt(job, revised);
      return revised;
    }
    if (options.action === "process") {
      if (options.file || options.state) throw new Error("Process takes no author payload.");
      return drain(job, options.limit);
    }
    throw new Error("Unsupported author action.");
  });
}
