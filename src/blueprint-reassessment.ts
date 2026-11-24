/** The immutable negative Review handoff to Generation's existing assessor.
 * This is domain evidence, not a second RecoveryCase or authority to write. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Plan } from "./architecture.js";
import type { SkillSnapshot } from "./snapshot.js";
import type { EventAssignment } from "./event-specialist.js";
import type { JobStartResult } from "./job.js";
import { logicalAssignmentKey, type AssignmentIdentity } from "./generation-assignment-lifecycle.js";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = /^[a-f0-9]{64}$/;
type Seal = { id: string; file: string; bytes: number; digest: string };
export type BlueprintAssessmentProof = {
  schema: "noveltea-blueprint-assessment/v1"; identity: AssignmentIdentity;
  parentAssignmentKey: string; round: number; draftDigest: string; reviewDigest: string;
  trigger: string; writer: Seal; reviewer: Seal;
  context: { plan: Plan; snapshot: SkillSnapshot; provider: string; model: string; task: string; assignment?: EventAssignment; cycleId?: string };
};
export type BlueprintAssessmentRef = { key: string; round: number; digest: string };
export type BlueprintAssessmentGrant = { caseId: string; ref: BlueprintAssessmentRef };
export class BlueprintAssessmentRequired extends Error {
  constructor(readonly ref: BlueprintAssessmentRef) {
    super("Original Blueprint requires source-bound independent reassessment.");
    this.name = "BlueprintAssessmentRequired";
  }
}
const pathFor = (job: JobStartResult, ref: Pick<BlueprintAssessmentRef, "key" | "round">) => {
  if (!hex.test(ref.key) || !Number.isSafeInteger(ref.round) || ref.round < 0)
    throw new ProtocolIntegrityBlockedError("Invalid Blueprint assessment reference.");
  return join(job.stateDir, "blueprint-assessments", ref.key + "-" + ref.round + ".json");
};
export async function readBlueprintAssessment(job: JobStartResult, ref: BlueprintAssessmentRef) {
  const file = pathFor(job, ref);
  if (!hex.test(ref.digest) || await realpath(file) !== file || !(await lstat(file)).isFile())
    throw new ProtocolIntegrityBlockedError("Unsafe Blueprint assessment receipt.");
  const proof = JSON.parse(await readFile(file, "utf8")) as BlueprintAssessmentProof;
  if (proof.schema !== "noveltea-blueprint-assessment/v1" || hash(proof) !== ref.digest ||
      logicalAssignmentKey(proof.identity) !== ref.key || proof.round !== ref.round ||
      proof.identity.jobId !== job.jobId || proof.identity.jobThreadId !== job.threadId ||
      !hex.test(proof.identity.turnDigest ?? "") || !hex.test(proof.parentAssignmentKey) ||
      !hex.test(proof.draftDigest) || !hex.test(proof.reviewDigest) ||
      !["stagnation", "review-depth", "late-blockers"].includes(proof.trigger) ||
      proof.writer.id === proof.reviewer.id || proof.writer.file === proof.reviewer.file)
    throw new ProtocolIntegrityBlockedError("Blueprint assessment lost its original source or independent Review.");
  const story = proof.identity.assignmentId === "story-blueprint";
  if (proof.context.plan.version !== proof.identity.planVersion ||
      (story ? !!proof.context.assignment : proof.identity.assignmentId !== "milestone-blueprint:" + proof.context.assignment?.milestoneId || !hex.test(proof.context.cycleId ?? "")))
    throw new ProtocolIntegrityBlockedError("Blueprint reassessment context differs from its original assignment.");
  if (!story && !/^milestone-blueprint:milestone\.[a-z][a-z0-9-]*$/.test(proof.identity.assignmentId))
    throw new ProtocolIntegrityBlockedError("Invalid Blueprint assessment owner.");
  for (const [role, seal] of [["writer", proof.writer], ["reviewer", proof.reviewer]] as const) {
    const dirs = story ? [join(job.stateDir, role === "writer" ? "architecture-blueprint-sessions" : "architecture-blueprint-review-sessions")] :
      (role === "writer" ? ["writer"] : ["reviewer", "replacement"]).map(r => join(job.stateDir, "milestone-blueprint-sessions", r));
    if (!dirs.some(dir => seal.file.startsWith(dir + sep)) || !hex.test(seal.digest) ||
        !Number.isSafeInteger(seal.bytes) || seal.bytes < 1 ||
        await realpath(seal.file) !== seal.file || !(await lstat(seal.file)).isFile())
      throw new ProtocolIntegrityBlockedError("Unsafe Blueprint assessment transcript.");
    const bytes = await readFile(seal.file);
    const header = JSON.parse(bytes.toString("utf8").split("\n")[0]!);
    if (header.type !== "session" || header.id !== seal.id || bytes.length < seal.bytes ||
        createHash("sha256").update(bytes.subarray(0, seal.bytes)).digest("hex") !== seal.digest)
      throw new ProtocolIntegrityBlockedError("Blueprint assessment transcript prefix changed.");
  }
  return proof;
}
export async function blueprintAssessmentSeal(id: string, file: string): Promise<Seal> {
  const bytes = await readFile(file);
  return { id, file, bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
}
export async function requestBlueprintAssessment(job: JobStartResult, proof: BlueprintAssessmentProof): Promise<never> {
  const ref = { key: logicalAssignmentKey(proof.identity), round: proof.round, digest: hash(proof) };
  const file = pathFor(job, ref);
  if (!existsSync(file)) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(proof) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (!isDeepStrictEqual(await readBlueprintAssessment(job, ref), proof))
    throw new ProtocolIntegrityBlockedError("Blueprint assessment evidence changed.");
  throw new BlueprintAssessmentRequired(ref);
}
export async function authenticateBlueprintGrant(job: JobStartResult, grant: BlueprintAssessmentGrant,
  identity: AssignmentIdentity, parentAssignmentKey?: string) {
  const proof = await readBlueprintAssessment(job, grant.ref);
  if (!hex.test(grant.caseId) || !isDeepStrictEqual(proof.identity, identity) ||
      proof.parentAssignmentKey !== parentAssignmentKey)
    throw new ProtocolIntegrityBlockedError("Blueprint assessor grant belongs to another assignment.");
  return proof;
}

/** Revalidate the original independent approval using the domain's historical
 * receipt reader, rather than treating the RecoveryLifecycle digest as proof. */
export async function verifyBlueprintAssessmentResolution(job: JobStartResult, ref: BlueprintAssessmentRef,
  correction: { store: string; ref: string; digest?: string }, sourceHead: string) {
  const proof = await readBlueprintAssessment(job, ref);
  if (sourceHead !== proof.identity.sourceHeadSha || correction.store !== "specialist-receipt") return false;
  const { plan, snapshot, provider, model, task, assignment, cycleId } = proof.context;
  if (!assignment) {
    if (correction.ref !== "architecture-blueprints/plan-" + plan.version + "-approved.json") return false;
    const { readApprovedBlueprint } = await import("./architecture-blueprint.js");
    const approved = await readApprovedBlueprint(job, plan, snapshot, provider, model, task, sourceHead);
    return !!approved && hash(approved.pin) === correction.digest;
  }
  const { readAssessmentMilestoneApproval } = await import("./milestone-blueprint.js");
  if (correction.ref !== "milestone-blueprints/" + assignment.milestoneId.slice(10) + ".json") return false;
  return await readAssessmentMilestoneApproval(job, assignment, cycleId!, sourceHead, ref.key, correction.digest);
}
