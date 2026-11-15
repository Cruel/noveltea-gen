import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withStoryJobLock } from "../src/job-lock.js";
import { nativeVersion } from "../src/native-cli-version.js";
import { validateStoryJob } from "../src/validator.js";
import {
  captureStorySnapshot,
  listStorySnapshots,
  pruneRoutineStorySnapshots,
  restoreStorySnapshot,
} from "../src/story-debug-snapshot.js";
import type { JobStartResult } from "../src/job.js";

function repoFixture(
  run: (job: JobStartResult, git: (...args: string[]) => string, root: string) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), "nt-story-snapshot-test-"));
  const repository = join(root, "source");
  const story = join(repository, "story");
  const stateDir = join(root, "state");
  mkdirSync(join(story, "events"), { recursive: true });
  mkdirSync(stateDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Snapshot Test");
  writeFileSync(join(story, "events", "entry.md"), "original\n");
  writeFileSync(join(story, "events", "delete.md"), "delete me\n");
  writeFileSync(join(repository, ".gitignore"), "*.secret\n");
  git("add", ".");
  git("commit", "-qm", "Initial Story");
  const baseSha = git("rev-parse", "HEAD");
  const job = {
    jobId: "debug-fixture",
    gitRoot: repository,
    worktreeRoot: repository,
    storyRoot: story,
    worktreeStoryRoot: story,
    storyRelativePath: "story",
    stateDir,
    baseSha,
    headSha: baseSha,
    branch: "main",
    validatorVersion: "1.0.0",
    threadId: "fixture",
    status: "ready",
  } as JobStartResult;
  return Promise.resolve()
    .then(() => run(job, git, root))
    .finally(() => {
      rmSync(root, { force: true, recursive: true });
    });
}

test("private Git snapshot preserves dirty YAML, deletion and untracked Story without changing real index", async () => {
  await repoFixture((job, git, root) => {
    const entry = join(job.worktreeStoryRoot, "events", "entry.md");
    writeFileSync(entry, "staged: true\n");
    git("add", "--", "story/events/entry.md");
    writeFileSync(entry, "invalid: [yaml\n");
    unlinkSync(join(job.worktreeStoryRoot, "events", "delete.md"));
    writeFileSync(join(job.worktreeStoryRoot, "events", "new.md"), "new: true\n");
    writeFileSync(join(job.worktreeStoryRoot, "events", "private.secret"), "should not be snapshotted");
    const before = git("status", "--porcelain=v1", "--untracked-files=all");
    const beforeIndex = git("ls-files", "--stage");
    const beforeHead = git("rev-parse", "HEAD");
    const snapshot = captureStorySnapshot(job, "validation-failed", "event-fixture");
    assert.equal(snapshot.originalHead, beforeHead);
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), before);
    assert.equal(git("ls-files", "--stage"), beforeIndex);
    assert.equal(git("show", snapshot.commitSha + ":story/events/entry.md"), "invalid: [yaml");
    assert.equal(git("show", snapshot.commitSha + ":story/events/new.md"), "new: true");
    assert.throws(() => git("cat-file", "-e", snapshot.commitSha + ":story/events/delete.md"));
    assert.equal(listStorySnapshots(job)[0]!.phase, "validation-failed");
    const restored = restoreStorySnapshot(job, snapshot.id, join(root, "restored"));
    assert.equal(readFileSync(join(restored.story, "events", "entry.md"), "utf8"), "invalid: [yaml\n");
    assert.equal(readFileSync(join(restored.story, "events", "new.md"), "utf8"), "new: true\n");
    assert.equal(existsSync(join(restored.story, "events", "delete.md")), false);
    assert.equal(existsSync(join(restored.story, "events", "private.secret")), false);
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), before);
    assert.throws(
      () => restoreStorySnapshot(job, snapshot.id, join(job.worktreeRoot, "no-restore")),
      /outside/,
    );
    symlinkSync(job.worktreeRoot, join(root, "alias-to-source"), "dir");
    assert.throws(
      () => restoreStorySnapshot(job, snapshot.id, join(root, "alias-to-source", "via-link")),
      /outside/,
      "Symlinked ancestors must not redirect a restore into the original repository.",
    );
  });
});

test("routine retention prunes only disposable refs, preserving all failure snapshots", async () => {
  await repoFixture((job, git, root) => {
    const routines = [0, 1, 2, 3].map((i) => {
      writeFileSync(join(job.worktreeStoryRoot, "events", "entry.md"), "draft " + i);
      return captureStorySnapshot(job, "after-work", "event-fixture");
    });
    const failure = captureStorySnapshot(job, "work-failed", "event-fixture");
    assert.equal(pruneRoutineStorySnapshots(job, 2), 2);
    const remaining = listStorySnapshots(job);
    assert.deepEqual(
      remaining
        .filter((item) => item.phase === "after-work")
        .map((x) => x.id)
        .sort(),
      routines
        .slice(2)
        .map((x) => x.id)
        .sort(),
    );
    assert.ok(remaining.some((item) => item.id === failure.id));
    assert.throws(() => restoreStorySnapshot(job, routines[0]!.id, join(root, "pruned")), /ENOENT/);
    assert.equal(git("rev-parse", failure.ref), failure.commitSha);
    assert.equal(pruneRoutineStorySnapshots(job, 0), 2);
    assert.deepEqual(
      listStorySnapshots(job).map((x) => x.id),
      [failure.id],
    );
  });
});

test("specialist lock snapshots entry, exit, thrown failure and stale-lock recovery", async () => {
  await repoFixture(async (job, git) => {
    await withStoryJobLock(job, "event-fixture", async () => {
      writeFileSync(join(job.worktreeStoryRoot, "events", "entry.md"), "specialist output\n");
    });
    assert.deepEqual(
      listStorySnapshots(job).map((s) => s.phase),
      ["before-work", "after-work"],
    );
    await assert.rejects(
      withStoryJobLock(job, "event-fixture", async () => {
        writeFileSync(join(job.worktreeStoryRoot, "events", "entry.md"), "failed output\n");
        throw Error("Original specialist failure");
      }),
      /Original specialist failure/,
    );
    assert.ok(listStorySnapshots(job).some((s) => s.phase === "work-failed"));

    const lock = join(job.stateDir, ".story-job-running");
    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        jobId: job.jobId,
        pid: 99999999,
        host: hostname(),
        nonce: randomUUID(),
        workItem: "event-interrupted",
      }) + "\n",
    );
    await withStoryJobLock(job, "generation-recovery", async () => undefined);
    const interrupted = listStorySnapshots(job).find((s) => s.phase === "interrupted");
    assert.ok(interrupted);
    assert.equal(interrupted!.workItem, "event-interrupted");
    assert.equal(git("show", interrupted!.commitSha + ":story/events/entry.md"), "failed output");
  });
});

test(
  "native-validation boundary preserves the exact invalid draft before and after failure",
  {
    skip: !existsSync("/home/thomas/dev/nt/build/cli/linux/noveltea"),
  },
  async () => {
    await repoFixture(async (job, git) => {
      const previous = process.env.NT_NATIVE_CLI;
      process.env.NT_NATIVE_CLI = "/home/thomas/dev/nt/build/cli/linux/noveltea";
      try {
        job.validatorVersion = nativeVersion();
        writeFileSync(
          join(job.stateDir, "job.json"),
          JSON.stringify({
            jobId: job.jobId,
            branch: job.branch,
            threadId: job.threadId,
            baseSha: job.baseSha,
            worktreeRoot: job.worktreeRoot,
            storyRoot: job.storyRoot,
            gitRoot: job.gitRoot,
            validatorVersion: job.validatorVersion,
          }),
        );
        await withStoryJobLock(job, "event-fixture", async () => {
          writeFileSync(join(job.worktreeStoryRoot, "events", "entry.md"), "invalid: [yaml\n");
          const result = await validateStoryJob(job);
          assert.notEqual(result.status, "passed");
        });
        const snapshots = listStorySnapshots(job);
        assert.ok(snapshots.some((s) => s.phase === "validation-attempt"));
        assert.ok(snapshots.some((s) => s.phase === "validation-failed"));
        const failed = snapshots.find((s) => s.phase === "validation-failed")!;
        assert.equal(git("show", failed.commitSha + ":story/events/entry.md"), "invalid: [yaml");
      } finally {
        if (previous === undefined) delete process.env.NT_NATIVE_CLI;
        else process.env.NT_NATIVE_CLI = previous;
      }
    });
  },
);

test("review failure pins original committed source even after later HEAD has advanced", async () => {
  await repoFixture((job, git, root) => {
    const reviewed = git("rev-parse", "HEAD");
    writeFileSync(join(job.worktreeStoryRoot, "events", "entry.md"), "newer\n");
    git("add", ".");
    git("commit", "-qm", "Later work");
    const newer = git("rev-parse", "HEAD");
    const snapshot = captureStorySnapshot(job, "review-failed", "event-fixture", { sourceCommit: reviewed });
    assert.equal(snapshot.originalHead, reviewed);
    assert.equal(git("show", snapshot.commitSha + ":story/events/entry.md"), "original");
    assert.equal(git("rev-parse", "HEAD"), newer);
    const restored = restoreStorySnapshot(job, snapshot.id, join(root, "review"));
    assert.equal(readFileSync(join(restored.story, "events", "entry.md"), "utf8"), "original\n");
  });
});
