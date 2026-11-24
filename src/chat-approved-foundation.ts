import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { renderFoundation, type FoundationDraft } from "./foundation-record.js";

const SHA = /^[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;

export type ChatFoundationApproval = {
  version: 1;
  jobId: string;
  sourceSha: string;
  firstTurnId: string;
  scope: "foundation-only" | "whole-story";
  originalObjective: string;
  proposalDigest: string;
  skillId: string;
  foundation: FoundationDraft;
  creativeMode: "autonomous" | "collaborative";
  provider: string;
  model: string;
  authoredSha256: string;
  /** Only the current canonical approved record can authorize execution. */
  canonicalStatus: 'approved';
};

const file = (job: JobStartResult) => join(job.stateDir, "chat-approved-foundation.json");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only the authenticated Chat controller may create this immutable handoff.
 * It is not a writer lease: the normal foundation work-item graph owns Git
 * mutation, native validation and crash reconciliation. */
export async function pinChatApprovedFoundation(job: JobStartResult,
  approval: Omit<ChatFoundationApproval, "version" | "authoredSha256" | "canonicalStatus">): Promise<void> {
  if (approval.jobId !== job.jobId || approval.sourceSha !== job.baseSha ||
      !SHA.test(approval.sourceSha) || !DIGEST.test(approval.proposalDigest) ||
      !DIGEST.test(approval.skillId) || !approval.originalObjective.trim() ||
      !approval.firstTurnId || !["foundation-only", "whole-story"].includes(approval.scope) ||
      !approval.provider || !approval.model)
    throw new Error("Chat foundation handoff identity is invalid.");
  const state: ChatFoundationApproval = {
    ...approval, version: 1, canonicalStatus: 'approved',
    authoredSha256: hash(renderFoundation(approval.foundation, 'approved')),
  };
  try {
    await writeFile(file(job), JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readChatApprovedFoundation(job);
    if (JSON.stringify(existing) !== JSON.stringify(state))
      throw new Error("This job already has a different approved Creative Direction.");
  }
}

export async function readChatApprovedFoundation(job: JobStartResult): Promise<ChatFoundationApproval | null> {
  let raw: string;
  try { raw = await readFile(file(job), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const state = JSON.parse(raw) as ChatFoundationApproval;
  if (!state || state.version !== 1 || state.jobId !== job.jobId ||
      state.sourceSha !== job.baseSha || !DIGEST.test(state.proposalDigest) ||
      !DIGEST.test(state.skillId) || !state.firstTurnId ||
      !["foundation-only", "whole-story"].includes(state.scope) ||
      !state.originalObjective?.trim() ||
      !["autonomous", "collaborative"].includes(state.creativeMode) ||
      !state.provider || !state.model || !DIGEST.test(state.authoredSha256) ||
      state.canonicalStatus !== 'approved' ||
      state.authoredSha256 !== hash(renderFoundation(state.foundation, 'approved')))
    throw new Error("Saved Chat approval differs from its pinned Story foundation.");
  return state;
}
