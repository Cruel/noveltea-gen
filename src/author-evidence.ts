import { execFileSync } from "node:child_process";
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { JobStartResult } from "./job.js";

/** Public key must be part of the author's ORIGINAL Git baseline, never the
 * agent-controlled job worktree, moving HEAD, or job-state JSON. */
export const AUTHOR_KEY_PATH = ".noveltea/approval-author.pub";

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

export interface SignedAuthorEvidence { payload: AuthorDecisionPayload; signature: string; }

function keysEqual(obj: object, allowed: string[]) {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys) === JSON.stringify([...allowed].sort());
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validateEvidenceShape(value: unknown): asserts value is SignedAuthorEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !keysEqual(value, ["payload", "signature"])) throw new Error("Invalid signed author evidence envelope.");
  const data = value as Record<string, unknown>;
  if (!nonempty(data.signature) || !/^[A-Za-z0-9+/]{86}==$/.test(data.signature)) {
    throw new Error("Invalid Ed25519 signature encoding.");
  }
  const payload = data.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Signed author payload must be an object.");
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

function gitOriginalKey(job: JobStartResult): KeyObject {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) {
    delete env[name];
  }
  // The writable job manifest is not a trust anchor by itself. The original
  // base must still belong to the separately managed author's checkout.
  // A job worker cannot promote a private worktree commit containing its own
  // public key into the trusted base merely by rewriting job.json.
  try {
    execFileSync("git", ["-C", job.gitRoot, "merge-base", "--is-ancestor", job.baseSha, "HEAD"], {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error("Recorded author baseline is no longer an ancestor of the author-managed checkout; " +
      "refusing to trust a rebased job signing key.");
  }
  let key: Buffer;
  try {
    key = execFileSync("git", ["show", job.baseSha + ":" + AUTHOR_KEY_PATH], {
      cwd: job.worktreeRoot, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32768,
    });
  } catch {
    throw new Error("Author signing public key is absent from the ORIGINAL Git base. Commit " +
      AUTHOR_KEY_PATH + " in the author repository before starting a revision-capable job.");
  }
  try {
    const publicKey = createPublicKey(key);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return publicKey;
  } catch {
    throw new Error("The author's original Git baseline contains an invalid Ed25519 public key.");
  }
}

export function verifyAuthorEvidence(job: JobStartResult, evidence: unknown): SignedAuthorEvidence {
  validateEvidenceShape(evidence);
  const signature = Buffer.from(evidence.signature, "base64");
  if (signature.length !== 64 || !verify(null, Buffer.from(JSON.stringify(evidence.payload)),
      gitOriginalKey(job), signature)) {
    throw new Error("Author signature is invalid for this exact signed proposal; no authorization was recorded.");
  }
  if (evidence.payload.jobId !== job.jobId || evidence.payload.threadId !== job.threadId ||
      evidence.payload.baseSha !== job.baseSha) {
    throw new Error("Signed author authorization belongs to a different job or trusted baseline.");
  }
  return evidence;
}

export async function readSignedAuthorEvidence(job: JobStartResult, file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) {
    throw new Error("Signed author evidence must be a small regular JSON file.");
  }
  const evidence: unknown = JSON.parse(await readFile(file, "utf8"));
  return verifyAuthorEvidence(job, evidence);
}
