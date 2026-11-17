/** Read-only capture of an exact Architecture blueprint review or correction.
 * The persisted controller evidence is checked before a private deterministic
 * replay case is written. It is NEVER a resumable approval or canonical Story
 * checkpoint; verified Git work-item recovery remains the production boundary. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseCausalBlueprint,
  parseBlueprintReview,
  type CausalBlueprint,
  type BlueprintReview,
} from "./architecture-blueprint.js";
import { applyBlueprintPatch, blueprintDigest, type BlueprintPatch } from "./architecture-blueprint-patch.js";
import {
  assembleBlueprintStages, assembleBlueprintOutlineCore, assembleCurrentBlueprintOutline,
  BEAT_BATCH_SIZE, EVIDENCE_BATCH_SIZE, parseBlueprintBeatBatch, parseBlueprintEvidence,
  parseBlueprintOutline, parseBlueprintOutlineCore, parseBlueprintOutlineHeader,
  type BlueprintEvidence, type BlueprintOutlineBeat, type BlueprintRouteConsequence,
} from "./architecture-blueprint-stages.js";
import { executeReplay, replaySha256, writeReplayCase, type ReplayInput } from "./execution-replay.js";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

function regular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4 * 1024 * 1024)
    throw Error("Unsafe or missing private blueprint evidence: " + path);
  return readFileSync(path);
}
function json(path: string): unknown {
  return JSON.parse(regular(path).toString("utf8")) as unknown;
}
function matchingReceipt(receipt: unknown, expected: Record<string, unknown>) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.entries(expected).some(([key, value]) => (receipt as Record<string, unknown>)[key] !== value)
  )
    throw Error("Blueprint replay has stale or inconsistent source lineage.");
}
function validateTranscript(file: unknown, id: unknown, stateDir: string, directory: string) {
  const parent = join(stateDir, directory) + sep;
  if (
    typeof file !== "string" ||
    !file.startsWith(parent) ||
    typeof id !== "string" ||
    !id ||
    realpathSync(file) !== file
  )
    throw Error("Blueprint replay session is missing or crosses the Job boundary.");
  const bytes = regular(file);
  const first = JSON.parse(bytes.toString("utf8").split("\n", 1)[0]!) as { type?: string; id?: string };
  if (first.type !== "session" || first.id !== id) throw Error("Blueprint replay session identity mismatch.");
  return replaySha256(bytes);
}

export type BlueprintReplayKind = "blueprint-review-verdict" | "blueprint-patch";

/** Capture a private case after verifying its persisted stage and review chain.
 * This intentionally accepts a private Job state path, not an author Story path. */
export function captureBlueprintReplay(
  directory: string,
  version: number,
  iteration: number,
  kind: BlueprintReplayKind,
  destination: string,
) {
  if (
    !Number.isInteger(version) ||
    version < 0 ||
    !Number.isInteger(iteration) ||
    iteration < (kind === "blueprint-patch" ? 1 : 0) ||
    iteration > 2
  )
    throw Error("Blueprint replay requires a valid plan and bounded correction iteration.");
  const root = resolve(directory);
  if (
    basename(root) !== "architecture-blueprints" ||
    !lstatSync(root).isDirectory() ||
    realpathSync(root) !== root
  )
    throw Error("Blueprint replay requires an unlinked private Architecture state directory.");
  const stateDir = dirname(root);
  const file = (suffix: string) => join(root, "plan-" + version + "-" + suffix + ".json");
  const admitted = json(file("admitted")) as Record<string, unknown>;
  if (
    admitted.planVersion !== version ||
    typeof admitted.jobId !== "string" ||
    typeof admitted.threadId !== "string" ||
    typeof admitted.contractDigest !== "string" ||
    !HASH.test(admitted.contractDigest) ||
    typeof admitted.executionHead !== "string" ||
    !SHA.test(admitted.executionHead) ||
    typeof admitted.baseSha !== "string" ||
    !SHA.test(admitted.baseSha)
  )
    throw Error("Blueprint replay admission lacks a source-bound valid identity.");
  const started = json(file("started")) as Record<string, unknown>;
  matchingReceipt(started, admitted);
  validateTranscript(
    started.plannerSessionFile,
    started.plannerSessionId,
    stateDir,
    "architecture-blueprint-sessions",
  );

  // The original outline and evidence batches must reconstruct the recorded
  // initial draft exactly, or a later review cannot be reproduced faithfully.
  const outline = parseBlueprintOutline(JSON.stringify(json(file("outline"))));
  const stage = json(file("stages")) as {
    schema?: string;
    outlineDigest?: string;
    headerDigest?: string;
    beatDigests?: string[];
    coreDigest?: string;
    routesDigest?: string;
    evidenceDigests?: string[];
  };
  const batched = stage.schema === "noveltea-blueprint-stages/v3";
  const split = batched || stage.schema === "noveltea-blueprint-stages/v2";
  if (
    !["noveltea-blueprint-stages/v1", "noveltea-blueprint-stages/v2",
      "noveltea-blueprint-stages/v3"].includes(String(stage.schema)) ||
    Object.keys(stage).sort().join(",") !== (batched ?
      "beatDigests,coreDigest,evidenceDigests,headerDigest,outlineDigest,routesDigest,schema" :
      split ? "coreDigest,evidenceDigests,outlineDigest,routesDigest,schema" :
      "evidenceDigests,outlineDigest,schema") ||
    stage.outlineDigest !== blueprintDigest(outline) ||
    !Array.isArray(stage.evidenceDigests) ||
    stage.evidenceDigests.length !== Math.ceil(outline.beats.length / EVIDENCE_BATCH_SIZE)
  )
    throw Error("Blueprint replay has missing or mismatched stage receipts.");
  if (split) {
    const core = parseBlueprintOutlineCore(JSON.stringify(json(file("outline-core"))));
    const routes = json(file("outline-routes"));
    if (!Array.isArray(routes) ||
        blueprintDigest(core) !== stage.coreDigest ||
        blueprintDigest(routes) !== stage.routesDigest ||
        !isDeepStrictEqual(
          assembleCurrentBlueprintOutline(core, routes as BlueprintRouteConsequence[]), outline))
      throw Error("Blueprint replay causal core or Choice-route receipt changed.");
    if (batched) {
      const header = parseBlueprintOutlineHeader(JSON.stringify(json(file("outline-header"))));
      if (blueprintDigest(header) !== stage.headerDigest ||
          !Array.isArray(stage.beatDigests) ||
          stage.beatDigests.length !== Math.ceil(header.beatIds.length / BEAT_BATCH_SIZE))
        throw Error("Blueprint replay causal header or beat-batch receipts changed.");
      const beats: BlueprintOutlineBeat[] = [];
      for (let first = 0; first < header.beatIds.length; first += BEAT_BATCH_SIZE) {
        const rows = json(file("outline-beats-" + first));
        if (!Array.isArray(rows) ||
            blueprintDigest(rows) !== stage.beatDigests[first / BEAT_BATCH_SIZE])
          throw Error("Blueprint replay causal beat batch changed after planning.");
        beats.push(...parseBlueprintBeatBatch(
          rows.map(row => JSON.stringify(row)).join("\n"), header, first, beats));
      }
      if (!isDeepStrictEqual(assembleBlueprintOutlineCore(header, beats), core))
        throw Error("Blueprint replay causal header and beat batches differ from its core.");
    }
  }
  const evidence: BlueprintEvidence[] = [];
  for (let first = 0; first < outline.beats.length; first += EVIDENCE_BATCH_SIZE) {
    const rows = json(file("evidence-" + first));
    if (!Array.isArray(rows) || blueprintDigest(rows) !== stage.evidenceDigests[first / EVIDENCE_BATCH_SIZE])
      throw Error("Blueprint replay evidence batch changed after planning.");
    evidence.push(
      ...parseBlueprintEvidence(rows.map((row) => JSON.stringify(row)).join("\n"), outline, first),
    );
  }
  let current = assembleBlueprintStages(outline, evidence);
  if (!isDeepStrictEqual(current, json(file("draft-0"))))
    throw Error("Blueprint replay initial draft differs from its staged evidence.");
  // Obligations are not reauthorized here; prove at least their saved presence.
  regular(file("obligations"));

  let preceding: { blueprint: CausalBlueprint; verdict: BlueprintReview } | undefined;
  let latestPatch: BlueprintPatch | undefined;
  const reviewerIdentities = new Set<string>();
  for (let i = 0; i <= iteration; i++) {
    if (i > 0) {
      if (!preceding) throw Error("Blueprint replay lacks a prior independent review.");
      const raw = json(file("patch-" + i));
      const applied = applyBlueprintPatch(preceding.blueprint, preceding.verdict, raw);
      current = applied.blueprint;
      latestPatch = applied.patch;
      if (!isDeepStrictEqual(current, json(file("draft-" + i))))
        throw Error("Blueprint replay patched draft differs from its recorded revision.");
    }
    const verdict = parseBlueprintReview(JSON.stringify(json(file("verdict-" + i))), current);
    const reviewSession = json(file("review-session-" + i)) as Record<string, unknown>;
    if (
      Object.keys(reviewSession).sort().join(",") !== "blueprintDigest,sessionFile,sessionId,verdictDigest" ||
      reviewSession.blueprintDigest !== blueprintDigest(current) ||
      reviewSession.verdictDigest !== blueprintDigest(verdict) ||
      reviewSession.sessionId === started.plannerSessionId ||
      reviewerIdentities.has(String(reviewSession.sessionId)) ||
      reviewerIdentities.has(String(reviewSession.sessionFile))
    )
      throw Error("Blueprint replay independent review digest or identity changed.");
    reviewerIdentities.add(String(reviewSession.sessionId));
    reviewerIdentities.add(String(reviewSession.sessionFile));
    validateTranscript(
      reviewSession.sessionFile,
      reviewSession.sessionId,
      stateDir,
      "architecture-blueprint-review-sessions",
    );
    preceding = { blueprint: current, verdict };
  }

  let input: ReplayInput;
  if (kind === "blueprint-review-verdict") {
    input = { kind, blueprint: current, response: preceding!.verdict };
  } else {
    const previous = parseCausalBlueprint(JSON.stringify(json(file("draft-" + (iteration - 1)))));
    const previousVerdict = parseBlueprintReview(
      JSON.stringify(json(file("verdict-" + (iteration - 1)))),
      previous,
    );
    input = { kind, base: previous, review: previousVerdict, patch: latestPatch! };
  }
  const outcome = executeReplay(input);
  if (
    outcome.status !== "returned" ||
    (kind === "blueprint-patch" && (outcome.value as { digest: string }).digest !== blueprintDigest(current))
  )
    throw Error("Blueprint replay does not reproduce its recorded reviewed version.");
  return writeReplayCase(
    destination,
    input,
    {
      sourceJobId: admitted.jobId as string,
      checkpointSha: admitted.executionHead as string,
      workItem: "architecture-blueprint",
      sessionFileSha256: replaySha256(
        regular((json(file("review-session-" + iteration)) as { sessionFile: string }).sessionFile),
      ),
    },
    outcome,
  );
}
