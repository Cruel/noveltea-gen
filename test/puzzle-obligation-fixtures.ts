import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionContract } from "../src/architecture.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The fixture exercises the real source/digest validation. This is neither a
 * production Turn authorizer nor a fabricated no-write controller receipt. */
export function saveFixtureTurn(
  job: {
    jobId: string;
    stateDir: string;
    baseSha: string;
  },
  contract: CompletionContract,
  request: string,
  obligations: string[],
) {
  const body = {
    version: 1,
    kind: "full-story",
    originalRequest: request,
    goal: request,
    // Studio first-Turn receipts bind their source SHA, with a null source jobId.
    // The sealed no-write receipt itself binds the exact executing Job/Thread.
    source: { jobId: null, verifiedSha: job.baseSha },
    contract,
    objective: {
      breadth: "whole-story",
      requestedTargets: [],
      deliveryDepth: contract.scope.depth,
      obligations,
    },
    assignments: [
      "foundation",
      "architecture",
      "foundations",
      "event",
      "interactive",
      "composition",
      "review",
    ].map((id) => ({
      id,
      specialist: id === "event" ? "nt-event-design" : "nt-" + id,
      outcome: "Complete the " + id + " Story milestone.",
      targets: ["milestone.disclosure"],
      dependsOn: [],
      discovery: "canonical-story-read-only" as const,
      authority: {
        recordTypes: ["event", "choice-point", "puzzle", "authored-content"],
        existingPaths: [],
        mayCreate: true,
      },
    })),
    reviewRequired: true,
  };
  writeFileSync(
    join(job.stateDir, "turn-plan.json"),
    JSON.stringify({ ...body, digest: hash(body) }, null, 2),
  );
}
