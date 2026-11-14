/**
 * Verify an existing live Event→Character recovery without rerunning any
 * writer, reviewer, or model call. This is generic: no job, SHA, or issue ID
 * is hardcoded. The source must have been produced by a separate live run.
 *
 * NT_EVENT_CHARACTER_REPLAY_ROOT=/path/to/preserved/run \
 *   pnpm exec tsx --test test/event-character-dependency-replay.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { inspectDependencyPlan } from "../src/dependency-state.js";
import {
  readIndependentReview,
  readRepairCommitProof,
  resolvedCheckpointReviews,
} from "../src/checkpoint-assurance.js";
import { auditEventParticipantCorrection } from "../src/event-participant-correction.js";

test(
  "a preserved live Event→Character recovery reopens, verifies and retains all independent verdicts",
  {
    skip:
      !process.env.NT_EVENT_CHARACTER_REPLAY_ROOT &&
      "Set NT_EVENT_CHARACTER_REPLAY_ROOT to a previously completed isolated live-run root",
    timeout: 120_000,
  },
  async () => {
    const root = process.env.NT_EVENT_CHARACTER_REPLAY_ROOT!;
    const state = join(root, "state");
    const jobDirs = readdirSync(join(state, "jobs")).filter((name) =>
      statSync(join(state, "jobs", name)).isDirectory(),
    );
    assert.equal(jobDirs.length, 1, "Replay must identify a single exact job");
    const jobMeta = JSON.parse(readFileSync(join(state, "jobs", jobDirs[0]!, "job.json"), "utf8")) as {
      jobId: string;
    };
    // The archived test created a single owner/repository scoped bare checkout.
    // No historical owner, job ID, source SHA, or worktree is assumed.
    const ownerDirs = readdirSync(join(root, "cache"));
    assert.equal(ownerDirs.length, 1);
    const repoDirs = readdirSync(join(root, "cache", ownerDirs[0]!));
    assert.equal(repoDirs.length, 1);
    const scoped = join(root, "cache", ownerDirs[0]!, repoDirs[0]!);
    const story = join(scoped, "base", "story");

    const envNames = ["NT_STATE_DIR", "NT_GIT_CACHE_DIR", "NT_SKILL_CACHE_DIR", "NT_CONFIG_FILE"] as const;
    const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
      });
    try {
      process.env.NT_STATE_DIR = state;
      process.env.NT_GIT_CACHE_DIR = scoped;
      process.env.NT_SKILL_CACHE_DIR = join(root, "skills");
      process.env.NT_CONFIG_FILE = join(root, "config.json");

      const job = await startStoryJob({ story, job: jobMeta.jobId }, false);
      const ledger = await inspectDependencyPlan(job);
      assert.ok(ledger, "Saved dependency ledger missing");
      assert.equal(ledger.entries.length, 1);
      const entry = ledger.entries[0]!;
      assert.equal(entry.phase, "verified");
      assert.equal(entry.review?.verdict, "pass", "Supporting Character review was not accepted");
      assert.ok(
        entry.reviewerSession && entry.eventRepair,
        "Each supporting and originating specialist must have independent evidence",
      );

      const sourceSha = entry.reviewSourceSha;
      assert.ok(sourceSha);
      const request = ledger.reviewRequests?.find((r) => r.sourceSha === sourceSha);
      assert.equal(request?.classification, "new-full-story-record");
      assert.ok(request?.originalWorkItem.startsWith("event-"));
      assert.equal(request?.findings.length, 1);
      const eventPath = request!.findings[0]!.path;
      const newCharacterPath = entry.amendment?.assignment.authority.newPaths?.[0];
      assert.match(newCharacterPath ?? "", /^characters\/[a-z][a-z0-9-]*\.md$/);
      assert.equal(entry.amendment?.assignment.authority.existingPaths.length, 0);

      const points = await inspectRecoveryCheckpoints(job);
      const originalPoint = points.find((p) => p.eligible && p.commitSha === sourceSha);
      assert.ok(originalPoint?.assurance);
      assert.equal((await readIndependentReview(job, originalPoint.assurance)).status, "failed");
      const repairPoint = points.find(
        (p) => p.eligible && p.commitSha === entry.eventRepair!.commitSha && p.workItem.startsWith("repair-"),
      );
      assert.ok(repairPoint?.assurance);
      assert.equal((await readIndependentReview(job, repairPoint.assurance)).status, "passed");
      const proof = await readRepairCommitProof(job, repairPoint.workItem);
      assert.equal(proof.sourceCommitSha, sourceSha);
      assert.equal(proof.commitSha, entry.eventRepair!.commitSha);

      const repoPath = (path: string) => (job.storyRelativePath ? job.storyRelativePath + "/" + path : path);
      const before = git(job.worktreeRoot, "show", sourceSha + ":" + repoPath(eventPath));
      const after = git(job.worktreeRoot, "show", entry.eventRepair!.commitSha + ":" + repoPath(eventPath));
      auditEventParticipantCorrection(before, after, entry.amendment!.assignment.targets[0]!);
      assert.deepEqual(
        git(job.worktreeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", entry.commitSha!)
          .trim()
          .split("\n"),
        [repoPath(newCharacterPath!)],
        "Supporting specialist wrote outside its Character grant",
      );
      assert.deepEqual(
        git(
          job.worktreeRoot,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          entry.eventRepair!.commitSha,
        )
          .trim()
          .split("\n"),
        [repoPath(eventPath)],
        "Original Event specialist wrote outside its Event grant",
      );
      assert.equal(
        git(job.worktreeRoot, "rev-parse", entry.eventRepair!.commitSha + "^").trim(),
        entry.commitSha,
      );
      assert.equal(git(job.worktreeRoot, "status", "--porcelain").trim(), "");
      assert.equal(
        git(join(scoped, "base"), "rev-parse", "HEAD").trim(),
        job.baseSha,
        "The original repository HEAD must not be moved by isolated job repair",
      );
      assert.equal(
        git(join(scoped, "base"), "status", "--porcelain").trim(),
        "",
        "The original repository must remain clean",
      );

      const covered = await resolvedCheckpointReviews(
        job,
        points.filter((p) => p.eligible),
      );
      assert.equal(
        covered.get(sourceSha),
        "not-required",
        "Only separately passing successor reviews may cover the original failure",
      );
      const reopened = await startStoryJob({ story, job: jobMeta.jobId }, false);
      assert.equal((await inspectDependencyPlan(reopened))?.digest, ledger.digest);
      const reopenedPoints = await inspectRecoveryCheckpoints(reopened);
      assert.equal(
        (
          await readIndependentReview(
            reopened,
            reopenedPoints.find((p) => p.commitSha === sourceSha)!.assurance!,
          )
        ).status,
        "failed",
      );
      await assert.rejects(
        inspectDependencyPlan({ ...reopened, threadId: "unrelated-thread" }),
        /identity|source/i,
      );
      await assert.rejects(
        inspectDependencyPlan({ ...reopened, jobId: "unrelated-job" }),
        /identity|source/i,
      );
      console.error(
        "EVENT_CHARACTER_REPLAY_VERIFIED " +
          JSON.stringify({
            sourceSha,
            support: entry.commitSha,
            corrected: entry.eventRepair!.commitSha,
            original: "failed",
            supportReview: "passed",
            eventReview: "passed",
            restart: "verified",
            crossThread: "denied",
          }),
      );
    } finally {
      for (const name of envNames) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
