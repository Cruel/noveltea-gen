import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { TurnEvidence } from "../src/turn-plan-evidence.js";
import { forkDigest, readRecoveryFork } from "../src/recovery-fork-state.js";
import { projectReviewTurn, readReviewTurnEvidence } from "../src/fork-review-turn.js";
import { selectCheckpointReview } from "../src/checkpoint-assurance.js";
import { sealPuzzleNoWrite, readPuzzleNoWrite, readPuzzleNoWriteSync } from "../src/puzzle-obligation.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceSha = "a".repeat(40),
  parentCheckpoint = "b".repeat(40),
  nestedSource = "c".repeat(40);
const contract = {
  scope: { kind: "full-story" as const, depth: "composition" as const, targets: [], branches: [] },
  constraints: ["Preserve the incident's witnessed evidence"],
  envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
};
const turnBody = {
  version: 1 as const,
  kind: "full-story" as const,
  goal: "Complete the original mystery",
  originalRequest: "Write a mystery on an overnight train",
  source: { jobId: null, verifiedSha: sourceSha },
  contract,
  reviewRequired: true,
  assignments: [
    {
      id: "event",
      specialist: "nt-event-design",
      outcome: "Ground incident evidence in-scene",
      targets: ["milestone.incident"],
      dependsOn: [],
      discovery: "canonical-story-read-only" as const,
      authority: { recordTypes: ["event"], existingPaths: [], mayCreate: true },
    },
  ],
};
const original: TurnEvidence = { ...turnBody, digest: hash(turnBody) };

function withFork(
  testBody: (ctx: {
    job: JobStartResult;
    bundle: Record<string, any>;
    seal: (value: Record<string, any>) => void;
  }) => Promise<void> | void,
  nested = false,
) {
  const root = mkdtempSync(join(tmpdir(), "nt-fork-review-turn-"));
  const checkpointSha = nested ? nestedSource : parentCheckpoint;
  const sourceBaseSha = nested ? parentCheckpoint : sourceSha;
  const sourceJobId = nested ? "first-child" : "root-parent";
  const turn = nested
    ? projectReviewTurn(original, {
        jobId: sourceJobId,
        baseSha: sourceBaseSha,
      } as JobStartResult)
    : original;
  const base = {
    version: 2,
    sourceJobId,
    sourceBaseSha,
    storyRoot: "/original/story",
    childId: "next-child",
    toolchain: {
      graphSchema: "noveltea-generation/v1",
      runtime: { nodeVersion: process.version, continuationSchema: "noveltea-fork/v2" },
      validator: { implementation: "native-cli", version: "1.0.0" },
      skills: { id: "d".repeat(64) },
    },
    checkpoint: {
      commitSha: checkpointSha,
      workItem: "character-foundations",
      completedWorkItems: ["character-foundations"],
      assurance: { turnDigest: turn.digest },
    },
    reviewCoverage: [{ workItem: "character-foundations", commitSha: checkpointSha, status: "passed" }],
    contract,
    reviewTurn: original,
    receipts: {},
    commits: {},
    completedStages: [],
  };
  const seal = (value: Record<string, any>) => {
    const digest = forkDigest(value);
    writeFileSync(join(root, "recovery-fork.json"), JSON.stringify(value));
    writeFileSync(join(root, "recovery-fork-ready"), digest + "\n");
  };
  seal(base);
  const pin = { sourceJobId, sourceBaseSha, commitSha: checkpointSha, bundleSha256: forkDigest(base) };
  const job = {
    jobId: "next-child",
    baseSha: checkpointSha,
    storyRoot: "/original/story",
    stateDir: root,
    recoveryFork: pin,
  } as JobStartResult;
  return Promise.resolve()
    .then(() => testBody({ job, bundle: base, seal }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("fork retains authenticated original Turn for independent review only, not writer authority", () =>
  withFork(async ({ job }) => {
    const plan = await readReviewTurnEvidence(job);
    assert.ok(plan);
    assert.equal(plan.source.verifiedSha, job.baseSha);
    assert.equal(plan.source.jobId, job.jobId);
    assert.equal(plan.originalRequest, original.originalRequest);
    assert.deepEqual(plan.assignments, original.assignments);
    assert.notEqual(plan.digest, original.digest, "Review is attributed to new Job/source");
    assert.equal(
      existsSync(join(job.stateDir, "turn-plan.json")),
      false,
      "No new author approvals or Turn writer grants may be produced",
    );
    assert.deepEqual(
      selectCheckpointReview({
        workItem: "event-incident",
        paths: ["events/incident.md"],
        addedLines: 2,
        removedLines: 0,
        dependencyCount: 0,
        previousFailure: false,
      }),
      {
        status: "required-pending",
        reasons: ["high-impact-record"],
      },
    );
  }));

test("inherited Turn authorizes a source-bound optional Puzzle no-write seal without a child author grant", () =>
  withFork(async ({ job: bare }) => {
    const job = { ...bare, branch: "noveltea-gen/next-child", threadId: "fork:next-child" } as JobStartResult;
    const turn = await readReviewTurnEvidence(job);
    assert.ok(turn);
    assert.equal(existsSync(join(job.stateDir, "turn-plan.json")), false);
    const payload = {
      version: 1 as const,
      decision: "not-applicable" as const,
      jobId: job.jobId,
      threadId: job.threadId,
      branch: job.branch,
      baseSha: job.baseSha,
      milestoneId: "milestone.incident",
      unitId: "interactive-puzzle-incident",
      eventHead: job.baseSha,
      choiceHead: job.baseSha,
      verifiedHead: job.baseSha,
      planVersion: 1,
      planDigest: "a".repeat(64),
      turnDigest: turn.digest,
      snapshotId: "d".repeat(64),
      worker: "fixture" as const,
      provider: "fixture",
      model: "fixture",
      piSessionFile: null,
      piSessionSha256: null,
      report: {
        modifiedRecords: [] as [],
        architecturalConflicts: ["No original formal Puzzle requirement"],
        laterObligations: ["Preserve source-bound fair clues"],
      },
      skillReads: [],
    };
    const ref = await sealPuzzleNoWrite(job, payload);
    assert.deepEqual(readPuzzleNoWriteSync(job, payload.milestoneId, ref), payload);
    assert.deepEqual(await readPuzzleNoWrite(job, payload.milestoneId, ref), payload);
    assert.throws(
      () => readPuzzleNoWriteSync(job, payload.milestoneId, { ...ref, digest: "f".repeat(64) }),
      /source\/owner\/digest/,
    );
  }));

test("multi-hop fork review preserves original author Turn while rebinding each source separately", () =>
  withFork(async ({ job }) => {
    const turn = await readReviewTurnEvidence(job);
    assert.ok(turn);
    assert.equal(turn.source.jobId, job.jobId);
    assert.equal(turn.source.verifiedSha, nestedSource);
    assert.equal(turn.originalRequest, original.originalRequest);
    assert.notEqual(turn.digest, original.digest);
  }, true));

test("missing, altered, and misbound fork review criteria cannot be laundered into assurance", () =>
  withFork(async ({ job, bundle, seal }) => {
    const saved = readFileSync(join(job.stateDir, "recovery-fork.json"), "utf8");
    seal({
      ...bundle,
      reviewTurn: { ...original, assignments: [{ ...original.assignments[0], outcome: "Invent new canon" }] },
    });
    await assert.rejects(readReviewTurnEvidence(job), /immutable job pin/);
    writeFileSync(join(job.stateDir, "recovery-fork.json"), saved);
    seal({ ...bundle, checkpoint: { ...bundle.checkpoint, assurance: { turnDigest: "0".repeat(64) } } });
    await assert.rejects(readReviewTurnEvidence(job), /immutable job pin/);
    writeFileSync(join(job.stateDir, "recovery-fork.json"), saved);

    const legacy = { ...bundle };
    delete legacy.reviewTurn;
    // Legacy child is an immutable, historically valid fork with NO Turn;
    // it must not invent independent review evidence.
    const legacyPin = forkDigest(legacy);
    seal(legacy);
    const legacyJob = { ...job, recoveryFork: { ...job.recoveryFork!, bundleSha256: legacyPin } };
    assert.equal(await readReviewTurnEvidence(legacyJob), null);
    assert.ok(readRecoveryFork(legacyJob));
  }));
