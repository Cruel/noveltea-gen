/** Read-only opt-in regression against a preserved GPT-6 Luna Event source.
 * A legitimate binding plus an unauthorized change to selected Milestone prose
 * must be recognized as a bounded, exact-source restore opportunity, never
 * accepted as-is or converted into a protected writing grant. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import {
  assertMilestoneFulfillmentOnly,
  milestoneBodyOnlyDrift,
  milestoneBaselineBody,
} from "../src/milestone-field-scope.js";
import { eventMilestoneBodyRestoreFeedback, eventEvidenceRetryAllowed } from "../src/event-specialist.js";

test(
  "preserved Luna Milestone narrative drift has exact-original-source repair without bypassing protection",
  {
    skip:
      process.env.NT_LIVE_EVENT_BODY_SOURCE !== "1"
        ? "Set NT_LIVE_EVENT_BODY_SOURCE=1 and NT_PRESERVED_EVENT_BODY_SOURCE to a private source."
        : false,
  },
  () => {
    const root = resolve(process.env.NT_PRESERVED_EVENT_BODY_SOURCE ?? "");
    assert.match(root, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
    const jobs = readdirSync(join(root, "state", "jobs"));
    assert.equal(jobs.length, 1);
    const state = join(root, "state", "jobs", jobs[0]!);
    const job = JSON.parse(readFileSync(join(state, "job.json"), "utf8")) as JobStartResult;
    assert.equal(job.stateDir, state);
    const items = readdirSync(join(state, "event-items"));
    assert.equal(items.length, 1);
    const receipt = JSON.parse(readFileSync(join(state, "event-items", items[0]!), "utf8")) as {
      phase: string;
      milestoneId: string;
      expectedHead: string;
      failure?: string;
      assignment?: { milestonePath: string };
    };
    assert.equal(receipt.phase, "writing");
    assert.match(receipt.failure ?? "", /changed unrelated Milestone metadata\/body/);
    const relative = receipt.assignment!.milestonePath;
    const actual = readFileSync(join(job.worktreeStoryRoot, relative), "utf8");
    const git = (...args: string[]) => {
      const call = spawnSync("git", args, { cwd: job.worktreeRoot, encoding: "utf8" });
      assert.equal(call.status, 0, call.stderr);
      return call.stdout;
    };
    const baseline = git("show", "HEAD:" + job.storyRelativePath + "/" + relative);
    assert.equal(git("rev-parse", "HEAD").trim(), receipt.expectedHead);
    const status = git("status", "--porcelain=v1", "--untracked-files=all");
    assert.match(status, new RegExp(" M " + job.storyRelativePath + "/milestones/"));
    assert.match(status, new RegExp("\\?\\? " + job.storyRelativePath + "/events/"));
    assert.equal(milestoneBodyOnlyDrift(baseline, actual), true);
    assert.throws(
      () => assertMilestoneFulfillmentOnly(baseline, actual, true),
      /changed unrelated Milestone metadata\/body/,
    );
    assert.match(actual, /completeness: complete/);
    assert.match(actual, /any_of:\s*\n\s*-\s*- event\./);
    const originalBody = milestoneBaselineBody(baseline);
    const feedback = eventMilestoneBodyRestoreFeedback(relative, originalBody);
    assert.match(feedback, /EVENT_MILESTONE_BODY_RESTORE/);
    assert.match(feedback, /ORIGINAL NARRATIVE BODY/);
    assert.ok(feedback.includes(JSON.stringify(originalBody)));
    assert.equal(eventEvidenceRetryAllowed(2, [feedback]), true);
    assert.equal(eventEvidenceRetryAllowed(3, [feedback]), false);
    assert.equal(
      readFileSync(join(job.worktreeStoryRoot, relative), "utf8"),
      actual,
      "The opt-in test must never repair or modify the preserved Story.",
    );
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), status);
    console.log(
      "PRESERVED_EVENT_BODY_RESTORE_PROOF",
      JSON.stringify({
        jobId: job.jobId,
        milestone: receipt.milestoneId,
        head: receipt.expectedHead,
        bodyOnly: true,
        originalBodyLength: originalBody.length,
      }),
    );
  },
);
