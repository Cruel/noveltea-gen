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


/** Source-bound approval evidence for the exact materialized root Foundation.
 * The original proposal remains immutable even if a later bounded body
 * correction is independently reviewed. No model-generated approval. */
export async function verifyMaterializedChatFoundation(job: JobStartResult,
  point: import("./recovery-checkpoints.js").RecoveryCheckpoint) {
  const approval = await readChatApprovedFoundation(job);
  if (!approval) return null;
  const { readDiscoveryHandoff } = await import("./discovery-generation-handoff.js");
  const handoff = await readDiscoveryHandoff(job);
  const { readReviewTurnEvidence } = await import("./fork-review-turn.js");
  const turn = await readReviewTurnEvidence(job);
  const state = JSON.parse(await readFile(join(job.stateDir,"foundation.json"),"utf8"));
  const assurance = point.assurance;
  const { execFileSync } = await import("./git-read-cache.js");
  const path = assurance?.changedPaths[0];
  if (point.workItem !== "foundation" || point.jobId !== job.jobId ||
      !assurance || assurance.jobId !== job.jobId || assurance.turnDigest !== turn?.digest ||
      assurance.changedPaths.length !== 1 || !path?.startsWith("creative-direction/") ||
      state.jobId !== job.jobId || state.stage !== "committed" || state.validation !== "passed" ||
      state.commitSha !== point.commitSha || state.target !== path ||
      state.chatApprovalDigest !== approval.proposalDigest ||
      state.snapshot?.id !== approval.skillId || state.provider !== approval.provider ||
      state.model !== approval.model || state.task !== approval.originalObjective ||
      !handoff || handoff.approvedProposalDigest !== approval.proposalDigest ||
      handoff.reviewedProposalDigest !== approval.proposalDigest ||
      handoff.foundationDigest !== hash(JSON.stringify(approval.foundation)) ||
      handoff.originalObjective !== approval.originalObjective ||
      handoff.turnPlanDigest !== turn?.digest ||
      handoff.firstTurnId !== approval.firstTurnId || handoff.skillId !== approval.skillId ||
      handoff.model.provider !== approval.provider || handoff.model.id !== approval.model)
    throw Error("Materialized Foundation lacks its exact authenticated Discovery approval.");
  const env = {...process.env};
  for (const key of ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_COMMON_DIR","GIT_PREFIX"]) delete env[key];
  const content = execFileSync("git",["show",point.commitSha+":"+
    (job.storyRelativePath?job.storyRelativePath+"/":"")+path],
    {cwd:job.worktreeRoot,env,encoding:"utf8",maxBuffer:512000});
  if (hash(content) !== approval.authoredSha256 ||
      content !== renderFoundation(approval.foundation,"approved"))
    throw Error("Materialized Foundation differs from the exact approved proposal.");
  return {approval, handoff, path, snapshot:state.snapshot as import("./snapshot.js").SkillSnapshot};
}

/** Corrections to a materialized approved Foundation may improve its
 * explanatory body, never change the author-approved metadata/decisions. */
export function assertChatFoundationBodyOnly(before: string, after: string) {
  const header = (value:string)=>/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(value)?.[0];
  if (!header(before) || header(before) !== header(after))
    throw Error("Chat-approved Foundation correction may not change approved metadata or protected decisions.");
}
