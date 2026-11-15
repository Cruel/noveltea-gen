/**
 * Extract a replayable reviewer boundary from saved, sealed production state.
 * The source Job and Pi transcripts are read-only; no new model invocation.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JobStartResult } from "./job.js";
import { inspectRecoveryCheckpoints } from "./recovery-checkpoints.js";
import { readIndependentReview } from "./checkpoint-assurance.js";
import {
  independentReviewResults,
  normalizeFailedSemanticFindingKinds,
  validateSemanticVerdict,
  type SemanticReviewPacket,
} from "./semantic-assignment-review.js";
import { writeReplayCase, replaySha256, type ReplayInput } from "./execution-replay.js";

const SHA = /^[a-f0-9]{40}$/;
const marker = "\nIMMUTABLE REVIEW PACKET\n";
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

type PiMessage = { role?: string; content?: Array<{ type?: string; text?: string }> };
function messages(path: string): PiMessage[] {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw Error("Unsafe or oversized original Pi reviewer transcript.");
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type?: string; message?: PiMessage })
    .filter((row) => row.type === "message" && row.message)
    .map((row) => row.message!);
}
function texts(message: PiMessage): string[] {
  if (typeof message.content === "string") return [message.content];
  return Array.isArray(message.content)
    ? message.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text!)
    : [];
}
function responseObject(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Model may send a JSON fenced response. Only a complete, single fenced
    // object is accepted, not arbitrary prose or partial JSON extraction.
    const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(raw);
    if (!match) return null;
    try {
      return JSON.parse(match[1]!);
    } catch {
      return null;
    }
  }
}

/** A reviewer may produce several malformed or corrected model turns while
 * working on ONE immutable packet. Each raw turn can be replayed independently
 * through the exact production parser and verdict checks, without a model. */
export async function recordedReviewerTurns(job: JobStartResult, sha: string) {
  if (!SHA.test(sha)) throw Error("Reviewer turn replay requires a commit SHA.");
  const point = (await inspectRecoveryCheckpoints(job)).find(
    (entry) => entry.commitSha === sha && entry.eligible && entry.assurance,
  );
  if (!point?.assurance) throw Error("Reviewer turn is not bound to a verified checkpoint.");
  const directory = join(job.stateDir, "review-sessions", "assignment-fidelity");
  const turns: Array<{ packet: SemanticReviewPacket; responseText: string; sessionDigest: string }> = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()) {
    const path = join(directory, file);
    const sessionDigest = replaySha256(readFileSync(path));
    let packet: SemanticReviewPacket | null = null;
    for (const message of messages(path))
      for (const content of texts(message)) {
        if (message.role === "user" && content.includes(marker)) {
          try {
            packet = JSON.parse(
              content.slice(content.lastIndexOf(marker) + marker.length),
            ) as SemanticReviewPacket;
          } catch {
            throw Error("Original reviewer packet is malformed.");
          }
          if (packet.sourceDigest !== hash({ policy: packet.policy, items: packet.items }))
            throw Error("Original reviewer input packet changed.");
        }
        if (
          message.role === "assistant" &&
          packet &&
          content.includes("verdict") &&
          packet.items.length === 1 &&
          JSON.stringify(packet.items[0]!.assurance) === JSON.stringify(point.assurance)
        )
          turns.push({ packet, responseText: content, sessionDigest });
      }
  }
  return turns;
}

export async function captureRecordedReviewerTurn(
  job: JobStartResult,
  sha: string,
  index: number,
  directory: string,
) {
  if (!Number.isSafeInteger(index) || index < 0) throw Error("Reviewer turn index must be nonnegative.");
  const turns = await recordedReviewerTurns(job, sha);
  const chosen = turns[index];
  if (!chosen) throw Error("Requested reviewer model turn was not found in the preserved session.");
  const input: ReplayInput = {
    kind: "reviewer-model-turn",
    packet: chosen.packet,
    responseText: chosen.responseText,
    reviewer: "independent-pi-assignment-review",
  };
  return writeReplayCase(directory, input, {
    sourceJobId: job.jobId,
    checkpointSha: sha,
    workItem: chosen.packet.items[0]!.reviewedWorkItem,
    sessionFileSha256: chosen.sessionDigest,
  });
}

export async function captureSealedReview(job: JobStartResult, sha: string, directory: string) {
  if (!SHA.test(sha)) throw Error("Reviewer replay requires an exact checkpoint SHA.");
  const point = (await inspectRecoveryCheckpoints(job)).find(
    (entry) => entry.commitSha === sha && entry.eligible && entry.assurance,
  );
  if (!point?.assurance)
    throw Error("Reviewer replay requires a finalized, independently verified checkpoint.");
  const sealed = await readIndependentReview(job, point.assurance);
  if (!sealed.result || !["passed", "failed"].includes(sealed.status))
    throw Error("Reviewer replay needs a finished, independently sealed review.");
  const reviewDir = join(job.stateDir, "review-sessions", "assignment-fidelity");
  const candidates: Array<{ packet: SemanticReviewPacket; response: unknown; sessionDigest: string }> = [];
  for (const file of readdirSync(reviewDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()) {
    const path = join(reviewDir, file);
    const sessionDigest = replaySha256(readFileSync(path));
    let packet: SemanticReviewPacket | null = null;
    for (const message of messages(path)) {
      for (const content of texts(message)) {
        if (message.role === "user" && content.includes(marker)) {
          const raw = content.slice(content.lastIndexOf(marker) + marker.length);
          try {
            packet = JSON.parse(raw) as SemanticReviewPacket;
          } catch {
            throw Error("Recorded reviewer packet is not parseable JSON.");
          }
          if (packet?.sourceDigest !== hash({ policy: packet?.policy, items: packet?.items }))
            throw Error("Recorded reviewer packet digest does not match its original content.");
        }
        if (
          message.role !== "assistant" ||
          !packet ||
          !packet.items.some((item) => item.assurance.commitSha === sha)
        )
          continue;
        const response = responseObject(content);
        if (
          response &&
          typeof response === "object" &&
          "sourceDigest" in response &&
          response.sourceDigest === packet.sourceDigest
        )
          candidates.push({ packet, response, sessionDigest });
      }
    }
  }
  const reviewer = sealed.result.reviewer;
  const selected = [...candidates].reverse().find(({ packet, response }) => {
    try {
      const verdict = validateSemanticVerdict(packet, normalizeFailedSemanticFindingKinds(response));
      const result = independentReviewResults(packet, verdict, reviewer).find(
        (item) => item.source.commitSha === sha,
      );
      return JSON.stringify(result) === JSON.stringify(sealed.result);
    } catch {
      return false;
    }
  });
  if (!selected)
    throw Error("No original recorded Pi reviewer response reproduces the sealed checkpoint verdict.");
  if (
    selected.packet.items.length !== 1 ||
    JSON.stringify(selected.packet.items[0]!.assurance) !== JSON.stringify(point.assurance)
  )
    throw Error("Recorded reviewer packet does not match this verified checkpoint assurance.");
  const input: ReplayInput = {
    kind: "review-verdict",
    packet: selected.packet,
    response: normalizeFailedSemanticFindingKinds(selected.response),
    reviewer,
  };
  return writeReplayCase(directory, input, {
    sourceJobId: job.jobId,
    checkpointSha: sha,
    workItem: point.workItem,
    sessionFileSha256: selected.sessionDigest,
  });
}
