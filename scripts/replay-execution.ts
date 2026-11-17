/**
 * Offline deterministic replay CLI.
 *
 * pnpm exec tsx scripts/replay-execution.ts replay <case-dir>
 * pnpm exec tsx scripts/replay-execution.ts capture-review <Story-root> <Job-ID> <checkpoint-SHA> <new-case-dir>
 *
 * No Pi credentials or network transport are resolved by either operation.
 * Source Jobs, sealed reviews and JSONL histories are never modified.
 */
import { startStoryJob } from "../src/job.js";
import { captureBlueprintReplay } from "../src/execution-replay-blueprint.js";
import {
  captureSealedReview,
  captureRecordedReviewerTurn,
  recordedReviewerTurns,
} from "../src/execution-replay-capture.js";
import { executeReplay, replayCase, writeReplayCase } from "../src/execution-replay.js";
import { captureNativeReplayInput } from "../src/execution-replay-native.js";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift(); // Also accept pnpm's argument separator.
  const [action, ...args] = argv;
  if (action === "replay" && args.length === 1) {
    const result = replayCase(args[0]!);
    console.log(
      JSON.stringify(
        {
          matched: result.matched,
          kind: result.manifest.kind,
          source: result.manifest.source,
          expectedStatus: result.expected.status,
          actualStatus: result.actual.status,
          ...(!result.matched ? { expected: result.expected, actual: result.actual } : {}),
        },
        null,
        2,
      ),
    );
    if (!result.matched) process.exitCode = 1;
    return;
  }
  if ((action === "capture-blueprint-review" || action === "capture-blueprint-patch") && args.length === 4) {
    const [privateDirectory, planVersion, iteration, destination] = args as [string, string, string, string];
    const manifest = captureBlueprintReplay(
      privateDirectory,
      Number(planVersion),
      Number(iteration),
      action === "capture-blueprint-review" ? "blueprint-review-verdict" : "blueprint-patch",
      destination,
    );
    console.log(
      JSON.stringify(
        { captured: true, kind: manifest.kind, source: manifest.source, caseDirectory: destination },
        null,
        2,
      ),
    );
    return;
  }
  if (action === "list-review-turns" && args.length === 3) {
    const [story, id, sha] = args as [string, string, string];
    const job = await startStoryJob({ story, job: id }, false);
    const turns = await recordedReviewerTurns(job, sha);
    console.log(
      JSON.stringify(
        turns.map((turn, index) => ({
          index,
          sourceDigest: turn.packet.sourceDigest,
          outcome: executeReplay({
            kind: "reviewer-model-turn",
            packet: turn.packet,
            responseText: turn.responseText,
            reviewer: "independent-pi-assignment-review",
          }).status,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (action === "capture-review-turn" && args.length === 5) {
    const [story, id, sha, turn, destination] = args as [string, string, string, string, string];
    const job = await startStoryJob({ story, job: id }, false);
    const manifest = await captureRecordedReviewerTurn(job, sha, Number(turn), destination);
    console.log(
      JSON.stringify(
        { captured: true, kind: manifest.kind, source: manifest.source, caseDirectory: destination },
        null,
        2,
      ),
    );
    return;
  }
  if ((action === "capture-review" || action === "capture-native") && args.length === 4) {
    const [story, id, sha, destination] = args as [string, string, string, string];
    const job = await startStoryJob({ story, job: id }, false);
    const manifest =
      action === "capture-review"
        ? await captureSealedReview(job, sha, destination)
        : await (async () => {
            const checkpoint = (await inspectRecoveryCheckpoints(job)).find(
              (point) => point.eligible && point.commitSha === sha,
            );
            if (!checkpoint || checkpoint.validation.status !== "passed")
              throw Error("Native replay requires an independently verified passing native checkpoint.");
            const input = captureNativeReplayInput(job, sha);
            const expected = executeReplay(input);
            if (expected.status !== "returned" || (expected.value as { status?: string }).status !== "passed")
              throw Error("Saved checkpoint no longer reproduces its passing native validation.");
            return writeReplayCase(
              destination,
              input,
              {
                sourceJobId: job.jobId,
                checkpointSha: sha,
                workItem: checkpoint.workItem,
              },
              expected,
            );
          })();
    console.log(
      JSON.stringify(
        { captured: true, kind: manifest.kind, source: manifest.source, caseDirectory: destination },
        null,
        2,
      ),
    );
    return;
  }
  console.error(
    "Usage: replay-execution.ts replay <case-dir> | capture-blueprint-review|capture-blueprint-patch <private-architecture-blueprints-dir> <plan-version> <review-or-patch-iteration> <new-case-dir> | capture-review|capture-native <Story-root> <Job-ID> <checkpoint-SHA> <new-case-dir> | list-review-turns <Story-root> <Job-ID> <checkpoint-SHA> | capture-review-turn <Story-root> <Job-ID> <checkpoint-SHA> <index> <new-case-dir>",
  );
  process.exitCode = 2;
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Replay failed");
  process.exitCode = 1;
});
