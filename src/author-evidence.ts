import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import type { JobStartResult } from "./job.js";

export type AuthorDecisionPayload =
  | {
    version: 1; kind: "plan"; jobId: string; threadId: string; workItemId: "global-architecture";
    baseSha: string; verifiedHead: string; proposalSha256: string; planVersion: number;
    reason: string;
  }
  | {
    version: 1; kind: "decision"; jobId: string; threadId: string; workItemId: string;
    baseSha: string; verifiedHead: string; proposalSha256: string;
    decision: string; changeId: string; action: "approved" | "rejected"; reason: string;
  }
  | {
    version: 1; kind: "editorial"; jobId: string; threadId: string; workItemId: string;
    baseSha: string; verifiedHead: string; proposalSha256: string;
    verdict: "pass" | "block"; evidence: string; notes: string;
  };

export interface AuthorApprovalReference { receiptId: string; nonce: string; }
export interface AuthorApprovalEvidence extends AuthorApprovalReference { payload: AuthorDecisionPayload; }

function keysEqual(obj: object, allowed: string[]) {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys) === JSON.stringify([...allowed].sort());
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function validateAuthorPayload(payload: unknown): asserts payload is AuthorDecisionPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Author request payload must be an object.");
  }
  const p = payload as Record<string, unknown>;
  const common = ["version", "kind", "jobId", "threadId", "workItemId", "baseSha", "verifiedHead", "proposalSha256"];
  const extra = p.kind === "plan" ? ["planVersion", "reason"]
    : p.kind === "decision" ? ["decision", "changeId", "action", "reason"]
    : p.kind === "editorial" ? ["verdict", "evidence", "notes"] : [];
  if (!extra.length || !keysEqual(payload, [...common, ...extra]) || p.version !== 1 ||
      ![p.jobId, p.threadId, p.workItemId, p.baseSha, p.verifiedHead, p.proposalSha256].every(nonempty) ||
      !/^[a-f0-9]{64}$/.test(String(p.proposalSha256)) ||
      !/^[a-f0-9]{40,64}$/.test(String(p.baseSha)) ||
      !/^[a-f0-9]{40,64}$/.test(String(p.verifiedHead))) {
    throw new Error("Invalid or incomplete author approval payload.");
  }
  if (p.kind === "plan" &&
      (p.workItemId !== "global-architecture" || !Number.isSafeInteger(p.planVersion) ||
       Number(p.planVersion) < 2 || !nonempty(p.reason) || p.reason.trim().length < 12)) {
    throw new Error("Plan approval requires a versioned proposal and substantive author rationale.");
  }
  if (p.kind === "decision" &&
      (!nonempty(p.decision) || !/^[a-f0-9]{64}$/.test(String(p.changeId)) ||
       !["approved", "rejected"].includes(String(p.action)) ||
       !nonempty(p.reason) || p.reason.trim().length < 12)) {
    throw new Error("Decision evidence requires stable decision ID, change digest, action and rationale.");
  }
  if (p.kind === "editorial" &&
      (!["pass", "block"].includes(String(p.verdict)) ||
       !nonempty(p.evidence) || !nonempty(p.notes) || p.notes.trim().length < 20)) {
    throw new Error("Editorial evidence requires verdict, source reference and substantive notes.");
  }
}

/** Historical verification deliberately does not compare moving HEAD. Consumers
 * check the current proposal before application; history remains verifiable after
 * a commit. The ledger MUST reside outside every model-directed tool boundary. */
export function verifyAuthorEvidence(job: JobStartResult, evidence: unknown): AuthorApprovalEvidence {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("A persisted controller approval reference is required.");
  }
  const ref = evidence as Record<string, unknown>;
  if ((!keysEqual(ref, ["receiptId", "nonce"]) && !keysEqual(ref, ["receiptId", "nonce", "payload"])) ||
      typeof ref.receiptId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(ref.receiptId) ||
      typeof ref.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(ref.nonce)) {
    throw new Error("Invalid controller approval receipt reference; signatures and inline decisions are not authority.");
  }
  const path = join(job.stateDir, "trusted-approvals", ref.receiptId + ".json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid approval receipt file.");
  const r = JSON.parse(readFileSync(path, "utf8"));
  validateAuthorPayload(r.payload);
  if (r.version !== 1 || r.id !== ref.receiptId || r.nonce !== ref.nonce ||
      r.phase !== "recorded" || !["approved", "rejected"].includes(r.decision) ||
      !["trusted-cli", "trusted-web"].includes(r.source) || !r.principal || !r.recordedAt ||
      r.jobId !== job.jobId || r.threadId !== job.threadId || r.baseSha !== job.baseSha ||
      r.payload.jobId !== r.jobId || r.payload.threadId !== r.threadId || r.payload.baseSha !== r.baseSha ||
      r.payload.verifiedHead !== r.verifiedHead || r.payload.proposalSha256 !== r.proposalSha256 ||
      r.payload.workItemId !== r.workItemId || r.payload.kind !== r.kind ||
      (r.kind === "decision" && (r.payload.changeId !== r.changeId || r.payload.action !== r.decision)) ||
      (r.kind === "editorial" && r.payload.verdict !== (r.decision === "approved" ? "pass" : "block")) ||
      (r.kind === "plan" && r.decision !== "approved") ||
      (ref.payload !== undefined && JSON.stringify(ref.payload) !== JSON.stringify(r.payload))) {
    throw new Error("Controller approval receipt nonce, decision or exact job/proposal binding differs.");
  }
  return { receiptId: r.id, nonce: r.nonce, payload: r.payload };
}

export async function readAuthorApproval(job: JobStartResult, file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) {
    throw new Error("Approval reference must be a small regular JSON file.");
  }
  const evidence: unknown = JSON.parse(await readFile(file, "utf8"));
  return verifyAuthorEvidence(job, evidence);
}
