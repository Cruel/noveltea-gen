/** Opt-in, read-only structural replay of the exact failed #173 Composition
 * draft. No Pi, no Git mutations and no fabricated checkpoint.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { validateStoryJob } from "../src/validator.js";
import { selectAssignment, verifyCompositionProse } from "../src/composition-work.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
test(
  "S14 #173 preserved authored Choice prose accepts exact outcome ID headings and menu labels",
  {
    skip: !root && "Set NT_TEST_PRESERVED_FORK_REVIEW_ROOT",
  },
  async () => {
    const source = JSON.parse(readFileSync(join(root!, "certification-source.json"), "utf8")) as {
      storyRoot: string;
    };
    const job = await startStoryJob(
      { story: source.storyRoot, job: "123663dd-304a-48ec-be82-a9dc44b65309" },
      false,
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: job.worktreeRoot,
      encoding: "utf8",
    }).trim();
    const arch = JSON.parse(readFileSync(join(job.stateDir, "architecture.json"), "utf8"));
    const interactive = JSON.parse(
      readFileSync(join(job.stateDir, "interactive-items/choice-enacted.json"), "utf8"),
    );
    const event = JSON.parse(readFileSync(join(job.stateDir, "event-items/choice-enacted.json"), "utf8"));
    const validation = await validateStoryJob(job, undefined, { ...job, baseSha: head });
    assert.equal(validation.status, "passed");
    const report = validation.report as Parameters<typeof selectAssignment>[1];
    const assignment = selectAssignment(arch.plan, report, interactive, event, "milestone.choice-enacted");
    const draftPaths = [
      "authored-content/response-confrontation.md",
      "authored-content/share-bounded-account.md",
      "authored-content/keep-report-narrow.md",
    ];
    const checked = await verifyCompositionProse(job, report, assignment, draftPaths);
    assert.deepEqual(checked.outcomes.sort(), ["keep-report-narrow", "share-bounded-account"].sort());
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: job.worktreeRoot, encoding: "utf8" }).trim(),
      head,
    );
  },
);
