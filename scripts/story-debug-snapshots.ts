/**
 * Inspect and reproduce diagnostic Story state without modifying a live Job.
 * No authority is transferred by a restored snapshot.
 */
import { startStoryJob } from "../src/job.js";
import { withStoryJobLock } from "../src/job-lock.js";
import {
  captureStorySnapshot,
  listStorySnapshots,
  pruneRoutineStorySnapshots,
  restoreStorySnapshot,
} from "../src/story-debug-snapshot.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const [command, story, id, ...rest] = args;
  if (!story || !id || !["list", "capture", "restore", "prune"].includes(command ?? ""))
    throw Error("Usage: story:snapshots -- list|capture|restore|prune <Story-root> <Job-ID> [arguments]");
  const job = await startStoryJob({ story, job: id }, false);
  if (command === "list" && !rest.length) console.log(JSON.stringify(listStorySnapshots(job), null, 2));
  else if (command === "capture" && rest.length === 2) {
    const [label, boundary] = rest;
    if (
      boundary !== "before-work" &&
      boundary !== "after-work" &&
      boundary !== "interrupted" &&
      boundary !== "work-failed"
    )
      throw Error("Manual snapshot phase must be before-work, after-work, interrupted, or work-failed.");
    const snapshot = await withStoryJobLock(job, "debug-snapshot-capture", async () =>
      captureStorySnapshot(job, boundary, label!),
    );
    console.log(JSON.stringify(snapshot, null, 2));
  } else if (command === "restore" && rest.length === 2)
    console.log(JSON.stringify(restoreStorySnapshot(job, rest[0]!, rest[1]!), null, 2));
  else if (command === "prune" && rest.length <= 1) {
    const max = rest[0] === undefined ? 48 : Number(rest[0]);
    const removed = await withStoryJobLock(job, "debug-snapshot-prune", async () =>
      pruneRoutineStorySnapshots(job, max),
    );
    console.log(JSON.stringify({ removed, retained: listStorySnapshots(job).length }));
  } else
    throw Error(
      "Invalid arguments: list; capture <work-item> <phase>; restore <snapshot-id> <new-dir>; prune [routine-to-keep]",
    );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
