import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import { trustedHead } from "../src/revision.js";

test("a pre-writer Foundation budget pause retains its exact clean baseline, never writer authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "nt-unstarted-foundation-"));
  try {
    const repo = join(root, "repo"),
      stateDir = join(root, "state");
    mkdirSync(repo);
    mkdirSync(stateDir);
    writeFileSync(join(repo, "README.txt"), "Author baseline\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-qm", "Baseline");
    const baseSha = git("rev-parse", "HEAD");
    const job = {
      jobId: "job-1",
      threadId: "thread-1",
      baseSha,
      worktreeRoot: repo,
      stateDir,
    } as JobStartResult;
    const receipt = {
      version: 1,
      jobId: job.jobId,
      baseSha,
      workHead: baseSha,
      stage: "writing",
      writerStarted: false,
    };
    const save = (value: Record<string, unknown>) =>
      writeFileSync(join(stateDir, "foundation.json"), JSON.stringify(value));
    save(receipt);
    assert.equal(await trustedHead(job), baseSha);

    // A private receipt cannot borrow another job or another baseline.
    for (const changed of [
      { jobId: "other-job" },
      { baseSha: "a".repeat(40) },
      { workHead: "b".repeat(40) },
      { writerStarted: true },
      { writerStarted: undefined },
      { stage: "awaiting-author" },
    ]) {
      save({ ...receipt, ...changed });
      await assert.rejects(trustedHead(job), /Foundation work item is unfinished/);
    }
    save(receipt);
    writeFileSync(join(repo, "unexpected.txt"), "Uncommitted writer effects\n");
    await assert.rejects(trustedHead(job), /Foundation work item is unfinished/);
    rmSync(join(repo, "unexpected.txt"));
    assert.equal(await trustedHead(job), baseSha);

    // Even a clean, subsequently committed HEAD cannot silently inherit the
    // unfinished receipt's permission to start another writer.
    writeFileSync(join(repo, "README.txt"), "Unauthorized revision\n");
    git("add", ".");
    git("commit", "-qm", "Other commit");
    await assert.rejects(trustedHead(job), /Foundation work item is unfinished/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
