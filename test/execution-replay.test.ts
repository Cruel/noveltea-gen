import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeReplay, replayCase, writeReplayCase, type ReplayInput } from "../src/execution-replay.js";
import { captureNativeReplayInput } from "../src/execution-replay-native.js";
import { nativeVersion } from "../src/native-cli-version.js";
import type { JobStartResult } from "../src/job.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";
import type { CheckpointAssurance } from "../src/checkpoint-assurance.js";

const sha = "a".repeat(40);
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const path = "events/incident-identified.md";
const assignment = {
  id: "event",
  specialist: "nt-event-design",
  outcome: "Introduce the train's opening clue",
  targets: ["milestone.incident-identified"],
  dependsOn: ["foundations"],
  discovery: "canonical-story-read-only" as const,
  authority: { recordTypes: ["event"], existingPaths: [path], mayCreate: false },
};
const assurance: CheckpointAssurance = {
  version: 1,
  policyVersion: 1,
  jobId: "job-test",
  baseSha: "b".repeat(40),
  commitSha: sha,
  parentSha: "c".repeat(40),
  workItem: "event-incident-identified",
  validationProofDigest: "d".repeat(64),
  validatorVersion: "1.0.0",
  turnDigest: "e".repeat(64),
  assignmentId: "event",
  assignmentDigest: digest(assignment),
  assignmentDependencies: ["foundations"],
  changedPaths: [path],
  changedRecordTypes: ["event"],
  addedLines: 2,
  removedLines: 0,
  diffDigest: "f".repeat(64),
  reviewSelection: { status: "required-pending", reasons: ["high-impact-record"] },
};
const item: SemanticReviewPacket["items"][number] = {
  assignment,
  reviewedWorkItem: "event-incident-identified",
  unitOutcome: "Only the selected Event",
  assurance,
  diff: "+ A broken seal appears",
  canonicalContext: [
    {
      path,
      content: "The player sees a broken seal.\nThe latch is open.",
      blobSha: "1".repeat(40),
      commitSha: sha,
    },
  ],
  readOnlyPaths: [],
  repairTargets: [path],
};
const packet: SemanticReviewPacket = {
  policy: "assignment-fidelity/v1",
  sourceDigest: digest({
    policy: "assignment-fidelity/v1",
    items: [item],
  }),
  items: [item],
};
const response = {
  sourceDigest: packet.sourceDigest,
  verdict: "fail",
  findings: [
    {
      commitSha: sha,
      assignmentId: "event",
      path,
      line: 1,
      kind: "missing-requirement",
      message: "The selected event lacks its required milestone fulfillment.",
      requiredCorrection: "Mark the original incident milestone complete and link the existing event.",
      affectedPaths: [path],
    },
  ],
  evidence: [],
};
const provenance = { sourceJobId: "job-test", checkpointSha: sha, workItem: "event-incident-identified" };
function withTemp(action: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "nt-offline-replay-"));
  try {
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("review replay reproduces the exact failed model verdict and controller receipt with no LLM", () =>
  withTemp((root) => {
    const input: ReplayInput = {
      kind: "review-verdict",
      packet,
      response,
      reviewer: "independent-pi-assignment-review",
    };
    const destination = join(root, "case");
    const beforeFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw Error("Offline replay attempted a network call");
    }) as typeof fetch;
    try {
      writeReplayCase(destination, input, provenance);
      const original = readFileSync(join(destination, "input.json"));
      const first = replayCase(destination);
      const second = replayCase(destination);
      assert.equal(first.matched, true);
      assert.deepEqual(second.actual, first.actual);
      assert.equal(first.actual.status, "returned");
      if (first.actual.status === "returned") {
        const value = first.actual.value as {
          results: Array<{ status: string; findings: Array<{ message: string }> }>;
        };
        assert.equal(value.results[0]?.status, "failed");
        assert.match(value.results[0]!.findings[0]!.message, /milestone fulfillment/);
      }
      assert.deepEqual(
        readFileSync(join(destination, "input.json")),
        original,
        "Replay must leave the recorded input unchanged",
      );
      assert.equal(lstatSync(destination).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(destination, "input.json")).mode & 0o777, 0o600);
      assert.throws(() => writeReplayCase(destination, input, provenance), /EEXIST/);
    } finally {
      globalThis.fetch = beforeFetch;
    }
  }));

test("malformed reviewer output is preserved as a deterministic validation failure", () =>
  withTemp((root) => {
    const input: ReplayInput = {
      kind: "review-verdict",
      packet,
      response: { ...response, sourceDigest: "0".repeat(64) },
      reviewer: "independent-pi-assignment-review",
    };
    writeReplayCase(join(root, "case"), input, provenance);
    const replay = replayCase(join(root, "case"));
    assert.equal(replay.matched, true);
    assert.equal(replay.actual.status, "threw");
    if (replay.actual.status === "threw") assert.match(replay.actual.message, /malformed or stale/);
  }));

test("exact raw reviewer model turns reproduce parser rejection and corrected verdict separately", () =>
  withTemp((root) => {
    const first: ReplayInput = {
      kind: "reviewer-model-turn",
      packet,
      responseText: 'I could not produce complete JSON: {"verdict": "fail"',
      reviewer: "reviewer",
    };
    const corrected: ReplayInput = {
      kind: "reviewer-model-turn",
      packet,
      responseText: "Reviewer response follows:\\n" + JSON.stringify(response),
      reviewer: "reviewer",
    };
    writeReplayCase(join(root, "first"), first, provenance);
    writeReplayCase(join(root, "corrected"), corrected, provenance);
    const rejected = replayCase(join(root, "first"));
    const accepted = replayCase(join(root, "corrected"));
    assert.equal(rejected.matched, true);
    assert.equal(rejected.actual.status, "threw");
    assert.equal(accepted.matched, true);
    assert.equal(accepted.actual.status, "returned");
  }));

test("replay fails closed on modified input, changed outcome, and symlinked evidence", () =>
  withTemp((root) => {
    const input: ReplayInput = { kind: "review-verdict", packet, response, reviewer: "reviewer" };
    const tampered = join(root, "tampered");
    writeReplayCase(tampered, input, provenance);
    writeFileSync(join(tampered, "input.json"), '{"corrupt":true}\n');
    assert.throws(() => replayCase(tampered), /were modified/);

    const mismatch = join(root, "mismatch");
    writeReplayCase(mismatch, input, provenance, {
      status: "threw",
      name: "Error",
      message: "Original known bug",
    });
    const outcome = replayCase(mismatch);
    assert.equal(outcome.matched, false);
    assert.equal(outcome.actual.status, "returned");

    const symlinked = join(root, "symlinked");
    writeReplayCase(symlinked, input, provenance);
    rmSync(join(symlinked, "input.json"));
    symlinkSync(join(mismatch, "input.json"), join(symlinked, "input.json"));
    assert.throws(() => replayCase(symlinked), /unsafe/);
    assert.ok(existsSync(join(mismatch, "input.json")));
  }));

test("review repair policy is replayed from sealed findings without Pi or write grants", () =>
  withTemp((root) => {
    const review = executeReplay({
      kind: "review-verdict",
      packet,
      response,
      reviewer: "independent-pi-assignment-review",
    });
    assert.equal(review.status, "returned");
    if (review.status !== "returned") return;
    const result = (review.value as { results: unknown[] }).results[0]!;
    const input: ReplayInput = {
      kind: "review-repair-plan",
      assurance,
      review: result as Extract<ReplayInput, { kind: "review-repair-plan" }>["review"],
      original: assignment,
      planVersion: 1,
      originWorkItem: "event-incident-identified",
    };
    writeReplayCase(join(root, "repair"), input, provenance);
    const run = replayCase(join(root, "repair"));
    assert.equal(run.matched, true);
    assert.equal(run.actual.status, "returned");
    if (run.actual.status === "returned") {
      const plan = run.actual.value as {
        allowedPaths?: string[];
        assignment: { authority: { existingPaths: string[] } };
      };
      assert.deepEqual(plan.assignment.authority.existingPaths, [path]);
    }
  }));

test("review dependency gate replays exact blocked work items and prerequisites", () =>
  withTemp((root) => {
    const input: ReplayInput = {
      kind: "review-dependency-gate",
      inventory: [
        { id: "foundations", dependencies: ["architecture"], status: "verified" },
        { id: "event:milestone.incident-identified", dependencies: ["foundations"], status: "pending" },
      ],
      decisions: [{ assignmentId: "foundations", status: "failed" }],
      nextWorkItem: "event-incident-identified",
      workDependencies: { "event-incident-identified": ["character-foundations"] },
      workReviews: [{ workItem: "character-foundations", status: "failed" }],
    };
    writeReplayCase(join(root, "gate"), input, provenance);
    const result = replayCase(join(root, "gate"));
    assert.equal(result.matched, true);
    assert.deepEqual(result.actual, {
      status: "returned",
      value: {
        blockedAssignments: ["event:milestone.incident-identified"],
        blockedPrerequisites: ["character-foundations"],
      },
    });
  }));

test(
  "exact Git native validation replays offline and leaves the source repository untouched",
  {
    skip: !existsSync("/home/thomas/dev/nt/build/cli/linux/noveltea"),
  },
  () =>
    withTemp((root) => {
      const previousCli = process.env.NT_NATIVE_CLI;
      process.env.NT_NATIVE_CLI = "/home/thomas/dev/nt/build/cli/linux/noveltea";
      try {
        const repo = join(root, "source");
        mkdirSync(join(repo, "story", "events"), { recursive: true });
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: repo,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git("init", "-q");
        git("config", "user.email", "offline@example.invalid");
        git("config", "user.name", "Offline replay");
        writeFileSync(join(repo, "story", ".gitkeep"), "");
        git("add", ".");
        git("commit", "-qm", "Original Story baseline");
        const baseSha = git("rev-parse", "HEAD");
        writeFileSync(join(repo, "story", "events", "broken.md"), "invalid: [yaml\\n");
        git("add", ".");
        git("commit", "-qm", "Recorded invalid specialist output");
        const checkpointSha = git("rev-parse", "HEAD");
        const recorded = captureNativeReplayInput(
          {
            worktreeRoot: repo,
            storyRelativePath: "story",
            baseSha,
            validatorVersion: nativeVersion(),
          } as JobStartResult,
          checkpointSha,
        );
        const saved = join(root, "native-case");
        writeReplayCase(saved, recorded, {
          sourceJobId: "fixture-job",
          checkpointSha,
          workItem: "event-broken",
        });
        // The recording must remain replayable even if the original Git
        // checkout disappears after capture. The bundle is self-contained.
        const moved = join(root, "unavailable-source");
        renameSync(repo, moved);
        let first: ReturnType<typeof replayCase>;
        let second: ReturnType<typeof replayCase>;
        try {
          first = replayCase(saved);
          second = replayCase(saved);
        } finally {
          renameSync(moved, repo);
        }
        assert.equal(first.matched, true);
        assert.deepEqual(first.actual, second.actual);
        assert.equal(first.actual.status, "returned");
        if (first.actual.status === "returned") {
          const report = first.actual.value as { status: string; reportSha256: string };
          assert.equal(report.status, "rejected");
          assert.match(report.reportSha256, /^[a-f0-9]{64}$/);
        }
        assert.equal(git("rev-parse", "HEAD"), checkpointSha);
        assert.equal(git("status", "--porcelain"), "");
        assert.throws(
          () =>
            writeReplayCase(
              join(root, "invalid"),
              {
                ...recorded,
                bundleSha256: "f".repeat(64),
              },
              { sourceJobId: "fixture-job", checkpointSha, workItem: "event-broken" },
            ),
          /Native replay recording requires/,
          "A poisoned bundle must not be accepted as a successfully captured replay",
        );
      } finally {
        if (previousCli === undefined) delete process.env.NT_NATIVE_CLI;
        else process.env.NT_NATIVE_CLI = previousCli;
      }
    }),
);
