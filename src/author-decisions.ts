import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { inspectFoundationConflict, decideFoundationConflict } from "./foundation-conflict.js";
import { inspectValidatorUpgrade, approveValidatorUpgrade } from "./validator-upgrade.js";

/**
 * Shared trusted-controller author-decision workflow for recoverable job
 * interruptions. Domain adapters establish the exact evidence and execute
 * their own guarded effects. A common durable receipt records the controller
 * action; no model tool can create that receipt or supply an author principal.
 *
 * Existing specialized receipts remain authoritative for replay safety and
 * are read without migration (including approvals made before this workflow).
 */
export type RecoveryDecisionKind = "foundation-conflict" | "validator-upgrade";
export type AuthorVerdict = "approved" | "rejected";
export interface AuthorDecisionReview {
  id: RecoveryDecisionKind;
  title: string;
  description: string;
  proposalSha256: string;
  verifiedHead: string;
  phase: "awaiting-author" | "applying" | "recorded";
  decision?: AuthorVerdict;
  note?: string;
  details: { sourceExcerpt: string; explanation: string } | {
    original: { version: string };
    replacement: { version: string };
    validationDigest: string; diagnostics: number;
  };
}
interface Ledger {
  version: 1; jobId: string; threadId: string; baseSha: string;
  id: RecoveryDecisionKind; proposalSha256: string;
  decision: AuthorVerdict; principal: string; note: string;
  recordedAt: string; phase: "applying" | "recorded";
  completedAt?: string;
}
const SHA = /^[a-f0-9]{64}$/;
const USER = /^user:[A-Za-z0-9_-]{1,128}$/;
const file = (job: JobStartResult, id: RecoveryDecisionKind) =>
  join(job.stateDir, "author-decisions", id + ".json");

async function receipt(job: JobStartResult, id: RecoveryDecisionKind): Promise<Ledger | null> {
  const p = file(job, id);
  if (!existsSync(p)) return null;
  const stat = await lstat(p);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw Error("Author decision receipt must be a regular, bounded file.");
  const r = JSON.parse(await readFile(p, "utf8")) as Ledger;
  if (r.version !== 1 || r.jobId !== job.jobId || r.threadId !== job.threadId ||
      r.baseSha !== job.baseSha || r.id !== id || !SHA.test(r.proposalSha256) ||
      !["approved", "rejected"].includes(r.decision) || !USER.test(r.principal) ||
      typeof r.note !== "string" || r.note.length > 1000 ||
      !["applying", "recorded"].includes(r.phase) || typeof r.recordedAt !== "string" ||
      (r.phase === "recorded" && typeof r.completedAt !== "string"))
    throw Error("Author decision receipt identity or content is invalid.");
  return r;
}
async function save(job: JobStartResult, value: Ledger) {
  const folder = join(job.stateDir, "author-decisions");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const p = file(job, value.id), tmp = p + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tmp, p);
  } finally { await rm(tmp, { force: true }); }
}

/** Pure projection of the underlying evidence and any existing decision. */
async function foundationReview(job: JobStartResult): Promise<AuthorDecisionReview | null> {
  const c = await inspectFoundationConflict(job);
  if (!c) return null;
  return {
    id: "foundation-conflict", title: "Foundation authorization",
    description: "The specialist stopped without editing because the generation task conflicts with an existing user-protected instruction. Authorizing permits one job-scoped retry, not a change to protected Story records.",
    proposalSha256: c.digest, verifiedHead: c.headSha,
    phase: c.status === "awaiting-author" ? "awaiting-author" : "recorded",
    ...(c.status !== "awaiting-author" ? {
      decision: c.status === "authorized" ? "approved" as const : "rejected" as const,
      note: c.authorization?.reason ?? "",
    } : {}),
    details: { sourceExcerpt: c.sourceExcerpt, explanation: c.explanation },
  };
}
async function validatorReview(job: JobStartResult): Promise<AuthorDecisionReview | null> {
  if (!job.validatorVersion) return null;
  const c = await inspectValidatorUpgrade(job);
  if (!c.proposal) return null;
  const p = c.proposal;
  return {
    id: "validator-upgrade", title: "Native validator replacement",
    description: "The installed CLI version differs from the job version. The replacement passed validation of the unchanged Story with zero diagnostics and checked protection. Authorizing updates the job version; it does not restart generation.",
    proposalSha256: p.proposalSha256, verifiedHead: p.headSha,
    phase: c.phase === "committed" ? "recorded" : c.phase === "approved" ? "applying" : "awaiting-author",
    ...(["committed", "approved"].includes(c.phase) ? {
      decision: "approved" as const,
      note: "rationale" in p && typeof p.rationale === "string" ? p.rationale : "",
    } : {}),
    details: { original: p.previous, replacement: p.replacement,
      validationDigest: p.validationDigest, diagnostics: p.diagnostics },
  };
}

interface DecisionAdapter {
  inspect(job: JobStartResult): Promise<AuthorDecisionReview | null>;
  apply(job: JobStartResult, input: {
    proposalSha256: string; decision: AuthorVerdict; principal: string; note: string;
  }): Promise<void>;
  /** Resume old specialized journals without changing their saved consent. */
  canRecoverLegacy?(job: JobStartResult, current: AuthorDecisionReview,
    decision: AuthorVerdict, principal: string, note: string): Promise<boolean>;
  nextJobStatus?(decision: AuthorVerdict): "paused" | "blocked";
}
/**
 * New decision types register evidence and effects here; the authenticated
 * controller, durable lifecycle, GET/POST contract, and UI remain unchanged.
 * Special validation is never replaced with a generic "permission to write".
 */
const adapters: Record<RecoveryDecisionKind, DecisionAdapter> = {
  "foundation-conflict": {
    inspect: foundationReview,
    async apply(job, { proposalSha256, decision, note, principal }) {
      const previous = await inspectFoundationConflict(job);
      const expected = decision === "approved" ? "authorized" : "rejected";
      if (previous?.status === "awaiting-author") {
        await decideFoundationConflict(job, decision === "approved" ? "approve" : "reject",
          proposalSha256, note, principal);
      } else if (previous?.status !== expected) {
        throw Error("Foundation authorization differs from the recorded controller decision.");
      }
    },
    nextJobStatus: decision => decision === "approved" ? "paused" : "blocked",
  },
  "validator-upgrade": {
    async inspect(job) {
      const foundation = await inspectFoundationConflict(job);
      if (foundation?.status !== "authorized" ||
          (foundation.retryUsed && !existsSync(join(job.stateDir, "validator-upgrade.json"))))
        return null;
      return validatorReview(job);
    },
    async apply(job, { proposalSha256, decision, note, principal }) {
      if (decision === "rejected") return;
      const result = await inspectValidatorUpgrade(job);
      if (result.phase !== "committed")
        await approveValidatorUpgrade(job, proposalSha256, note, principal);
    },
    async canRecoverLegacy(job, current, decision, principal, note) {
      if (current.phase !== "applying" || current.decision !== "approved" ||
          decision !== "approved" || current.note !== note) return false;
      const prior = (await inspectValidatorUpgrade(job)).proposal as
        { principal?: string } | null;
      if (prior?.principal !== principal)
        throw Error("Previously authorized validator upgrade belongs to another author.");
      return true;
    },
  },
};
export const recoveryDecisionKinds = ["foundation-conflict", "validator-upgrade"] as const;
export function isRecoveryDecisionKind(value: unknown): value is RecoveryDecisionKind {
  return typeof value === "string" &&
    (recoveryDecisionKinds as readonly string[]).includes(value);
}
export function statusAfterAuthorDecision(id: RecoveryDecisionKind, decision: AuthorVerdict) {
  return adapters[id].nextJobStatus?.(decision) ?? null;
}

/** Safe read-only inspection. No decision state is written from GET. */
export async function inspectAuthorDecisions(job: JobStartResult): Promise<AuthorDecisionReview[]> {
  const items: AuthorDecisionReview[] = [];
  for (const id of recoveryDecisionKinds) {
    const item = await adapters[id].inspect(job);
    if (!item) continue;
    const recorded = await receipt(job, id);
    if (!recorded) { items.push(item); continue; }
    if (recorded.proposalSha256 !== item.proposalSha256)
      throw Error("Author decision proposal changed after its controller receipt was recorded.");
    if (recorded.phase === "applying") {
      items.push({ ...item, phase: "applying", decision: recorded.decision, note: recorded.note });
      continue;
    }
    if (item.phase !== "recorded" &&
        !(id === "validator-upgrade" && recorded.decision === "rejected"))
      throw Error("Author decision receipt is recorded but its domain state is inconsistent.");
    items.push({ ...item, phase: "recorded", decision: recorded.decision, note: recorded.note });
  }
  return items;
}

/**
 * MUST be called inside withStoryJobLock by an authenticated controller with
 * a settled queue. Rechecks the exact proposal before writing a receipt.
 * The generic "applying" phase is crash-recoverable only with the same exact
 * author, action, note and digest; a domain writer is never replayed here.
 */
export async function decideAuthorDecision(job: JobStartResult, input: {
  id: RecoveryDecisionKind; proposalSha256: string; decision: AuthorVerdict;
  principal: string; note?: string;
}): Promise<AuthorDecisionReview> {
  const { id, proposalSha256, decision, principal } = input;
  const note = (input.note ?? "").trim();
  if (!isRecoveryDecisionKind(id) ||
      !SHA.test(proposalSha256) || !["approved", "rejected"].includes(decision) ||
      !USER.test(principal) || note.length > 1000)
    throw Error("Invalid authenticated author decision.");
  const adapter = adapters[id];
  const current = await adapter.inspect(job);
  if (!current || current.proposalSha256 !== proposalSha256)
    throw Error("Stale author decision: exact proposal or Git revision has changed.");
  let recorded = await receipt(job, id);
  if (recorded) {
    if (recorded.proposalSha256 !== proposalSha256 || recorded.decision !== decision ||
        recorded.principal !== principal || recorded.note !== note)
      throw Error("The decision is bound to another author or proposal.");
    if (recorded.phase === "recorded")
      return { ...current, phase: "recorded", decision, note };
  } else {
    const recovering = current.phase === "applying" &&
      !!adapter.canRecoverLegacy &&
      await adapter.canRecoverLegacy(job, current, decision, principal, note);
    if (current.phase !== "awaiting-author" && !recovering)
      throw Error("The requested decision is already resolved or has no pending authorization.");
    recorded = { version: 1, jobId: job.jobId, threadId: job.threadId, baseSha: job.baseSha,
      id, proposalSha256, decision, principal, note,
      recordedAt: new Date().toISOString(), phase: "applying" };
    await save(job, recorded);
  }
  await adapter.apply(job, { proposalSha256, decision, principal, note });
  recorded = { ...recorded, phase: "recorded", completedAt: new Date().toISOString() };
  await save(job, recorded);
  return { ...current, phase: "recorded", decision, note };
}
