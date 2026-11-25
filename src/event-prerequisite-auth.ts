/** One source-bound attestation for every accepted Event no-write report.
 * Admission and crash recovery must verify identical evidence. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProtocolIntegrityBlockedError } from "./response-contract-recovery.js";
import { verifyJobPiSession } from "./job-session.js";
import type { JobStartResult } from "./job.js";
import type { EventBlueprintFinding } from "./event-manifest.js";
import type { CausalDiscovery } from "./causal-amendment.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface EventNoWriteSource {
  jobId: string; workItemId: string; expectedHead: string; planDigest: string;
  worker: "pi" | "fixture"; sessionFile?: string;
  snapshot?: { id: string }; assignment?: unknown;
  conflicts?: string[]; obligations?: string[]; causalDiscovery?: CausalDiscovery;
  blueprintFinding?: EventBlueprintFinding;
  dependencyFinding?: import("./dependency-amendments.js").WriterDependencyFinding;
  prerequisite?: { expectedHead: string; sessionSha256: string; sessionId: string;
    assignmentDigest: string; snapshotId: string; sessionFile: string;
    worker: "pi" | "fixture"; reportDigest: string; transcriptBytes?: number };
}

export function eventPrerequisiteReportDigest(value: {
  jobId: string; workItemId: string; expectedHead: string; planDigest: string;
  sessionSha256: string; sessionId: string; assignmentDigest: string;
  snapshotId: string; sessionFile: string; worker: "pi" | "fixture";
  conflicts: string[]; obligations: string[]; causalDiscovery?: CausalDiscovery;
  blueprintFinding?: EventBlueprintFinding;
  dependencyFinding?: import("./dependency-amendments.js").WriterDependencyFinding;
}) {
  if (!/^[a-f0-9]{40}$/.test(value.expectedHead) ||
      !/^[a-f0-9]{64}$/.test(value.sessionSha256) ||
      !/^[a-f0-9]{64}$/.test(value.planDigest) ||
      !/^[a-f0-9]{64}$/.test(value.assignmentDigest) ||
      !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
      !["pi", "fixture"].includes(value.worker) ||
      !value.sessionFile.trim() ||
      !value.jobId.trim() || !/^event-[a-z][a-z0-9-]*$/.test(value.workItemId) ||
      !value.sessionId.trim() || !Array.isArray(value.conflicts) ||
      !Array.isArray(value.obligations) ||
      !value.conflicts.length && !value.obligations.length ||
      value.conflicts.length > 8 || value.obligations.length > 8 ||
      [...value.conflicts, ...value.obligations].some(s => typeof s !== "string" ||
        !s.trim() || s.length > 1500))
    throw new ProtocolIntegrityBlockedError("Unverified or unbounded Event no-write prerequisite report.");
  return hash(JSON.stringify(value));
}

/** Does not grant scope, authorize HEAD movement, or replace the caller's
 * phase/plan/history checks; those remain separate at every boundary. */
export async function authenticateEventNoWrite(job: JobStartResult, event: EventNoWriteSource, historical = false) {
  const source = event.prerequisite;
  if (!source || !event.assignment || !event.snapshot ||
      !event.conflicts || !event.obligations ||
      source.expectedHead !== event.expectedHead ||
      source.assignmentDigest !== hash(JSON.stringify(event.assignment)) ||
      source.snapshotId !== event.snapshot.id ||
      source.worker !== event.worker ||
      source.sessionFile !== (event.sessionFile ?? "fixture") ||
      source.reportDigest !== eventPrerequisiteReportDigest({
        jobId: event.jobId, workItemId: event.workItemId,
        expectedHead: event.expectedHead, planDigest: event.planDigest,
        sessionSha256: source.sessionSha256, sessionId: source.sessionId,
        assignmentDigest: source.assignmentDigest, snapshotId: source.snapshotId,
        sessionFile: source.sessionFile, worker: source.worker,
        conflicts: event.conflicts, obligations: event.obligations,
        ...(event.causalDiscovery ? { causalDiscovery: event.causalDiscovery } : {}),
        ...(event.blueprintFinding ? { blueprintFinding: event.blueprintFinding } : {}),
        ...(event.dependencyFinding ? { dependencyFinding: event.dependencyFinding } : {}),
      })) throw new ProtocolIntegrityBlockedError("Event no-write report changed or does not match its sealed source.");
  if (source.worker === "pi") {
    await verifyJobPiSession(job, "event", source.sessionFile, source.sessionId, event.workItemId);
    const transcript = await readFile(source.sessionFile);
    if (historical && (!Number.isSafeInteger(source.transcriptBytes) || source.transcriptBytes! <= 0 ||
        source.transcriptBytes! > transcript.length) ||
        hash(historical ? transcript.subarray(0, source.transcriptBytes) : transcript) !== source.sessionSha256)
      throw new ProtocolIntegrityBlockedError("Event no-write Pi transcript changed after the settled turn.");
  } else if (source.sessionSha256 !== "f".repeat(64) || source.sessionId !== "fixture") {
    throw new ProtocolIntegrityBlockedError("Event no-write deterministic fixture provenance is invalid.");
  }
  return source;
}
