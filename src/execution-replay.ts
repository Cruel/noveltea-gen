/**
 * Offline, deterministic replay of already-observed execution boundaries.
 *
 * Replay is NOT a Pi retry: it consumes the same captured input and model
 * output bytes, never resolves model credentials, calls an agent or seals
 * production review state. Artifacts are private (they may contain Story
 * content and original model responses). Hashes detect accidental mutation,
 * not a malicious author with write access to the recording directory.
 */
import { createHash } from "node:crypto";
import { replayNativeValidation, type NativeReplayInput } from "./execution-replay-native.js";
import { parseSpecialistJson } from "./composition-specialist.js";
import {
  parseCausalBlueprint,
  parseBlueprintReview,
  type CausalBlueprint,
  type BlueprintReview,
} from "./architecture-blueprint.js";
import { applyBlueprintPatch, blueprintDigest, type BlueprintPatch } from "./architecture-blueprint-patch.js";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  blockedByRequiredReview,
  unresolvedNativePrerequisites,
  type SemanticReviewStatus,
} from "./checkpoint-assurance.js";
import { deriveReviewRepairAmendment } from "./review-repair-amendment.js";
import {
  independentReviewResults,
  normalizeFailedSemanticFindingKinds,
  validateSemanticVerdict,
  type SemanticReviewPacket,
} from "./semantic-assignment-review.js";
import type { CheckpointAssurance, IndependentReviewResult } from "./checkpoint-assurance.js";
import type { TurnAssignmentEvidence } from "./turn-plan-evidence.js";

export type ReplayInput =
  | { kind: "blueprint-review-verdict"; blueprint: CausalBlueprint; response: unknown }
  | { kind: "blueprint-patch"; base: CausalBlueprint; review: BlueprintReview; patch: BlueprintPatch }
  | { kind: "review-verdict"; packet: SemanticReviewPacket; response: unknown; reviewer: string }
  | { kind: "reviewer-model-turn"; packet: SemanticReviewPacket; responseText: string; reviewer: string }
  | {
      kind: "review-repair-plan";
      assurance: CheckpointAssurance;
      review: IndependentReviewResult;
      original: TurnAssignmentEvidence;
      planVersion: number;
      originWorkItem: string;
    }
  | NativeReplayInput
  | {
      kind: "review-dependency-gate";
      inventory: Array<{ id: string; dependencies: string[]; status: string }>;
      decisions: Array<{ assignmentId: string; status: SemanticReviewStatus }>;
      nextWorkItem: string;
      workDependencies: Record<string, string[]>;
      workReviews: Array<{ workItem: string; status: SemanticReviewStatus }>;
    };

export type ReplayOutcome =
  { status: "returned"; value: unknown } | { status: "threw"; name: string; message: string };

export interface ReplayProvenance {
  /** Origin information is for identification, never a source of authority. */
  sourceJobId: string;
  checkpointSha: string;
  workItem: string;
  sessionFileSha256?: string;
}
export interface ReplayManifest {
  version: 1;
  format: "noveltea-step-replay/v1";
  kind: ReplayInput["kind"];
  source: ReplayProvenance;
  /** All bytes are content-addressed, including the original output/error. */
  inputSha256: string;
  expectedSha256: string;
}
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX = 16 * 1024 * 1024;
export const replaySha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function regular(path: string, max = MAX): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max)
    throw Error("Recorded replay file is absent, unsafe, empty or oversized: " + path);
  return readFileSync(path);
}
function parse<T>(bytes: Buffer): T {
  return JSON.parse(bytes.toString("utf8")) as T;
}
function checkSource(source: ReplayProvenance) {
  if (
    !source ||
    !source.sourceJobId ||
    !SHA.test(source.checkpointSha) ||
    !/^[a-z][a-z0-9.:_-]*$/.test(source.workItem) ||
    (source.sessionFileSha256 !== undefined && !DIGEST.test(source.sessionFileSha256))
  )
    throw Error("Replay needs source Job, exact checkpoint SHA and work-item identity.");
}
function checkInput(value: ReplayInput) {
  if (
    !value ||
    ![
      "review-verdict",
      "reviewer-model-turn",
      "blueprint-review-verdict",
      "blueprint-patch",
      "review-repair-plan",
      "review-dependency-gate",
      "native-validation",
    ].includes(value.kind)
  )
    throw Error("Unsupported deterministic replay boundary.");
}

/** Deterministic only: pure controller decisions, or native validation in a
 * disposable exact-Git checkout. No agents, provider calls or source writes. */
export function executeReplay(input: ReplayInput): ReplayOutcome {
  try {
    checkInput(input);
    if (input.kind === "blueprint-review-verdict") {
      const blueprint = parseCausalBlueprint(JSON.stringify(input.blueprint));
      const verdict = parseBlueprintReview(JSON.stringify(input.response), blueprint);
      return { status: "returned", value: { verdict, digest: blueprintDigest(verdict) } };
    }
    if (input.kind === "blueprint-patch") {
      const base = parseCausalBlueprint(JSON.stringify(input.base));
      const review = parseBlueprintReview(JSON.stringify(input.review), base);
      const { blueprint } = applyBlueprintPatch(base, review, input.patch);
      return {
        status: "returned",
        value: { digest: blueprintDigest(blueprint), beatCount: blueprint.beats.length },
      };
    }
    if (input.kind === "review-verdict" || input.kind === "reviewer-model-turn") {
      const response =
        input.kind === "reviewer-model-turn"
          ? normalizeFailedSemanticFindingKinds(parseSpecialistJson(input.responseText))
          : input.response;
      const verdict = validateSemanticVerdict(input.packet, response);
      return {
        status: "returned",
        value: {
          verdict,
          results: independentReviewResults(input.packet, verdict, input.reviewer),
        },
      };
    }
    if (input.kind === "review-repair-plan") {
      return { status: "returned", value: deriveReviewRepairAmendment(input) };
    }
    if (input.kind === "native-validation") {
      return { status: "returned", value: replayNativeValidation(input) };
    }
    return {
      status: "returned",
      value: {
        blockedAssignments: [...blockedByRequiredReview(input.inventory, input.decisions)].sort(),
        blockedPrerequisites: unresolvedNativePrerequisites(
          input.nextWorkItem,
          input.workDependencies,
          input.workReviews,
        ),
      },
    };
  } catch (error) {
    return {
      status: "threw",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Capture a reviewed observation into a private write-once directory. */
export function writeReplayCase(
  directory: string,
  input: ReplayInput,
  source: ReplayProvenance,
  expected = executeReplay(input),
) {
  checkInput(input);
  checkSource(source);
  if (input.kind === "native-validation" && input.checkpointSha !== source.checkpointSha)
    throw Error("Native replay source identity must match its captured Git commit.");
  if (input.kind === "native-validation" && expected.status !== "returned")
    throw Error(
      "Native replay recording requires a readable, verified Git bundle and installed native validator.",
    );
  const inputBytes = serialize(input),
    expectedBytes = serialize(expected);
  if (Buffer.byteLength(inputBytes) > MAX || Buffer.byteLength(expectedBytes) > MAX)
    throw Error("Replay exceeds the bounded recording limit.");
  const destination = resolve(directory);
  // The recording directory must not already exist, protecting previous runs.
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination, "input.json"), inputBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(join(destination, "expected.json"), expectedBytes, { flag: "wx", mode: 0o600 });
  const manifest: ReplayManifest = {
    version: 1,
    format: "noveltea-step-replay/v1",
    kind: input.kind,
    source,
    inputSha256: replaySha256(inputBytes),
    expectedSha256: replaySha256(expectedBytes),
  };
  writeFileSync(join(destination, "manifest.json"), serialize(manifest), { flag: "wx", mode: 0o600 });
  return manifest;
}

/** Replay never creates any output file, mutates source or sends a model call. */
export function replayCase(directory: string) {
  const root = resolve(directory);
  const dir = lstatSync(root);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error("Unsafe replay directory.");
  const manifest = parse<ReplayManifest>(regular(join(root, "manifest.json"), 16_384));
  if (
    manifest.version !== 1 ||
    manifest.format !== "noveltea-step-replay/v1" ||
    !DIGEST.test(manifest.inputSha256) ||
    !DIGEST.test(manifest.expectedSha256)
  )
    throw Error("Unsupported or malformed immutable replay manifest.");
  checkSource(manifest.source);
  const data = regular(join(root, "input.json"));
  const expectedData = regular(join(root, "expected.json"));
  if (replaySha256(data) !== manifest.inputSha256 || replaySha256(expectedData) !== manifest.expectedSha256)
    throw Error("Recorded replay inputs or expected results were modified.");
  const input = parse<ReplayInput>(data),
    expected = parse<ReplayOutcome>(expectedData);
  checkInput(input);
  if (manifest.kind !== input.kind || !expected || !["returned", "threw"].includes(expected.status))
    throw Error("Replay boundary metadata differs from its saved inputs.");
  const actual = executeReplay(input);
  return { matched: serialize(actual) === serialize(expected), expected, actual, manifest };
}
