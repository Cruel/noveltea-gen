/** Real preserved #173 source, offline. This must fail BEFORE dispatching
 * another Pi specialist to satisfy a nonexistent Choice obligation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startStoryJob } from "../src/job.js";
import { validateStoryJob } from "../src/validator.js";
import { selectAssignment } from "../src/interactive-work.js";
import { currentMilestoneChoiceBinding } from "../src/event-work.js";

const root = process.env.NT_TEST_PRESERVED_FORK_REVIEW_ROOT;
test(
  "historical incident Event defers a later Choice, not its own Choice",
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
    const event = JSON.parse(
      readFileSync(join(job.stateDir, "event-items/incident-identified.json"), "utf8"),
    );
    const arch = JSON.parse(readFileSync(join(job.stateDir, "architecture.json"), "utf8"));
    const validation = await validateStoryJob(job, undefined, { ...job });
    assert.equal(validation.status, "passed");
    const milestone = (
      validation.report as {
        records: Array<{
          metadata: { id: string; change?: string };
        }>;
      }
    ).records.find((r) => r.metadata.id === "milestone.incident-identified");
    assert.ok(milestone);
    assert.equal(
      currentMilestoneChoiceBinding(
        event.obligations,
        "milestone.incident-identified",
        milestone.metadata.change ?? "",
      ),
      false,
    );
    assert.throws(
      () =>
        selectAssignment(
          arch.plan,
          validation.report as Parameters<typeof selectAssignment>[1],
          "milestone.incident-identified",
          {
            headSha: event.commitSha,
            snapshotId: event.snapshot.id,
            eventIds: event.validation.eventIds,
            milestoneState: event.validation.milestoneState,
            missingObligations: event.obligations,
          },
        ),
      /Historical nondecision Event was left partial/,
      "Do not spend another specialist turn trying to invent a nondecision Choice.",
    );
  },
);
