import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { activeStoryWriter, requireStoryJobLease, withStoryJobLock,
  withStoryJobLockOrReuse } from "../src/job-lock.js";

async function fixture(run: (job: JobStartResult) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "nt-lease-contract-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const job = { jobId: "lease-a", stateDir, worktreeRoot: join(root, "work"),
    worktreeStoryRoot: join(root, "work", "story"), threadId: "thread-a" } as JobStartResult;
  try { await run(job); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("explicit lease reuse works at each production adaptive graph boundary and never silently nests a lock", async () => {
  await fixture(async job => {
    for (const parent of ["generation-boundary", "generation-verification",
      "generation-idea-verification"]) {
      await withStoryJobLock(job, parent, async () => {
        const root = join(job.stateDir, ".story-job-running", "owner.json");
        const original = readFileSync(root, "utf8");
        let nested = 0;
        await withStoryJobLockOrReuse({ ...job }, "interactive-example",
          ["generation-boundary", "generation-verification",
            "generation-idea-verification"], async () => {
            nested++;
            assert.equal(requireStoryJobLease(job).workItem, parent);
            assert.equal(readFileSync(root, "utf8"), original,
              "Borrowing must not replace the original owner or lease nonce.");
          });
        assert.equal(nested, 1);
        await assert.rejects(withStoryJobLock(job, "unapproved-nesting", async () => {}),
          /Nested Story job writer lock acquisition/);
        await assert.rejects(withStoryJobLockOrReuse(job, "interactive-example",
          ["generation-completion"], async () => {}), /does not authorize/);
        assert.equal(readFileSync(root, "utf8"), original);
      });
      assert.equal(activeStoryWriter()?.active, undefined);
    }
  });
});

test("rejected-review dependency requests can reuse only the next-attempt lease", async () => {
  await fixture(async job => {
    await withStoryJobLock(job, "rejected-review-next-attempt", async () => {
      await withStoryJobLockOrReuse(job, "review-dependency-request",
        ["rejected-review-next-attempt"], async () => {
          assert.equal(requireStoryJobLease(job).workItem, "rejected-review-next-attempt");
        });
      await withStoryJobLockOrReuse(job, "rejected-review-admission",
        ["rejected-review-next-attempt"], async () => {
          assert.equal(requireStoryJobLease(job).workItem, "rejected-review-next-attempt");
        });
    });
    await withStoryJobLockOrReuse(job, "rejected-review-admission",
      ["rejected-review-next-attempt"], async () => {
        assert.equal(requireStoryJobLease(job).workItem, "rejected-review-admission");
      });
    await withStoryJobLock(job, "generation-boundary", async () => {
      await assert.rejects(withStoryJobLockOrReuse(job, "review-dependency-request",
        ["rejected-review-next-attempt"], async () => {}), /does not authorize/);
    });
  });
});

test("lease identity and lifetime are checked even when an ambient context exists", async () => {
  await fixture(async job => {
    assert.throws(() => requireStoryJobLease(job), /requires an active/);
    let resolveDelay!: () => void;
    const delay = new Promise<void>(resolve => { resolveDelay = resolve; });
    let late!: Promise<void>;
    await withStoryJobLock(job, "generation-verification", async () => {
      for (const modified of [
        { ...job, jobId: "different-job" },
        { ...job, worktreeRoot: join(job.worktreeRoot, "changed") },
        { ...job, threadId: "changed" },
      ]) {
        assert.throws(() => requireStoryJobLease(modified), /different Story or worktree/);
        await assert.rejects(withStoryJobLockOrReuse(modified, "interactive-example",
          ["generation-verification"], async () => {}), /different Story or worktree/);
      }
      late = delay.then(() => withStoryJobLockOrReuse(job, "interactive-example",
        ["generation-verification"], async () => {}));
    });
    resolveDelay();
    await assert.rejects(late, /expired/);
    await assert.rejects(withStoryJobLockOrReuse(job, "interactive-example",
      [], async () => {}), /enumerate authorized parent/);
  });
});

test("separate Story leases remain independent; a second process cannot take a live lease", async () => {
  await fixture(async job => {
    const second = { ...job, jobId: "lease-b",
      stateDir: join(job.stateDir, "another-job"), threadId: "thread-b",
      worktreeRoot: join(job.worktreeRoot, "another"), worktreeStoryRoot: join(job.worktreeStoryRoot, "another") };
    mkdirSync(second.stateDir);
    const sameIdElsewhere = { ...second, jobId: job.jobId,
      stateDir: join(job.stateDir, "shared-id-elsewhere") };
    mkdirSync(sameIdElsewhere.stateDir);
    await withStoryJobLock(job, "generation-verification", async () => {
      for (const independent of [second, sameIdElsewhere]) {
        assert.throws(() => requireStoryJobLease(independent), /different Story or worktree/);
        await withStoryJobLockOrReuse(independent, "other-job-operation",
          ["generation-verification"], async () => {
            assert.equal(requireStoryJobLease(independent).workItem, "other-job-operation");
          });
      }
      const child = [
        `import { withStoryJobLock } from ${JSON.stringify(resolve("src/job-lock.ts"))};`,
        `await withStoryJobLock(${JSON.stringify(job)}, "competing-writer", async () => {});`,
      ].join("\n");
      const competing = spawnSync(process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", child], {
          encoding: "utf8", timeout: 15_000,
        });
      assert.notEqual(competing.status, 0);
      assert.match(competing.stderr, /already owned by generation-verification/);
      assert.equal(requireStoryJobLease(job).workItem, "generation-verification");
    });
  });
});
