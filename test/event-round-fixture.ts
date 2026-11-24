/** Adapter-level certification only. The production scheduler checkpoints these
 * commands in the shared assignment child; direct adapter tests drive the
 * same public round boundary without introducing a production fallback. */
import { createHash } from "node:crypto";
import { runEventWorkItem, type EventOptions } from "../src/event-work.js";
import type { AssignmentRoundCommand, AssignmentRoundResult } from "../src/assignment-metadata-recovery.js";

export function eventTestAssignmentKey(input: EventOptions) {
  return createHash("sha256").update(JSON.stringify({
    story: input.story, job: input.job, milestone: input.milestone,
  })).digest("hex");
}

export async function runEventTestAssignment(input: EventOptions) {
  if (input.action === "inspect" || input.fixture && !["repair", "failed-repair"].includes(process.env.NT_EVENT_FIXTURE_CASE ?? "")) return runEventWorkItem(input);
  const assignmentKey = eventTestAssignmentKey(input);
  let command: AssignmentRoundCommand = { phase: "invoke" };
  for (;;) {
    const result = await runEventWorkItem({ ...input, round: { assignmentKey, command } });
    const round = (result as { round?: AssignmentRoundResult }).round;
    if (!round) return result;
    command = round.status === "correction"
      ? { phase: "correct", proof: round.proof, grantDigest: round.grantDigest }
      : { phase: "verify", proof: round.proof };
  }
}
