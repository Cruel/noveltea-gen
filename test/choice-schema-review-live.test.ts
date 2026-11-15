/** Opt-in read-only replay of the exact Luna Choice reviewer schema
 * misinterpretation. No saved job, Story or review receipt is mutated. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inspectRecoveryCheckpoints } from "../src/recovery-checkpoints.js";
import { prepareSemanticReview, validateSemanticVerdict,
  type SemanticVerdict } from "../src/semantic-assignment-review.js";
import { choiceSelectionSchemaRecheck } from "../src/narrative-review-specialist.js";
import type { JobStartResult } from "../src/job.js";

test("saved Luna Choice rejection receives bounded schema reconsideration without rewriting its source", {
  skip: !process.env.NT_PRESERVED_CHOICE_SCHEMA_SOURCE &&
    "Opt in with NT_PRESERVED_CHOICE_SCHEMA_SOURCE pointing to the original private /tmp/nt158-* run.",
}, async () => {
  const root = resolve(process.env.NT_PRESERVED_CHOICE_SCHEMA_SOURCE!);
  assert.match(root, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
  const jobs = readdirSync(join(root, "state/jobs"));
  assert.equal(jobs.length, 1);
  const state = join(root, "state/jobs", jobs[0]!);
  const job = JSON.parse(readFileSync(join(state, "job.json"), "utf8")) as JobStartResult;
  assert.equal(job.stateDir, state);
  const receipts = readdirSync(join(state, "interactive-items")).filter(name => name.endsWith(".json"));
  assert.equal(receipts.length, 1);
  const interactive = JSON.parse(readFileSync(join(state, "interactive-items", receipts[0]!), "utf8")) as {
    units: Array<{ domain: string; phase: string; commitSha?: string }>;
  };
  const choice = interactive.units.find(unit => unit.domain === "choice");
  assert.equal(choice?.phase, "committed");
  assert.match(choice?.commitSha ?? "", /^[a-f0-9]{40}$/);
  const sha = choice!.commitSha!;
  const point = (await inspectRecoveryCheckpoints(job)).find(item => item.commitSha === sha);
  assert.ok(point?.eligible);
  const packet = await prepareSemanticReview(job, [point!]);
  const receiptBytes = readFileSync(join(state, "independent-reviews", sha + ".json"), "utf8");
  const receipt = JSON.parse(receiptBytes) as {
    status: string;
    findings: Array<{ path: string; line: number; kind: SemanticVerdict["findings"][number]["kind"];
      message: string; requiredCorrection: string; affectedPaths: string[] }>;
    evidence: string;
  };
  assert.equal(receipt.status, "failed");
  const verdict: SemanticVerdict = {
    sourceDigest: packet.sourceDigest,
    verdict: "fail",
    findings: receipt.findings.map(f => ({
      ...f, commitSha: sha, assignmentId: packet.items[0]!.assignment.id,
    })),
    evidence: (JSON.parse(receipt.evidence) as { evidence: SemanticVerdict["evidence"] }).evidence,
  };
  assert.equal(validateSemanticVerdict(packet, verdict).verdict, "fail");
  const correction = choiceSelectionSchemaRecheck(packet, verdict);
  assert.ok(correction, "Actual saved Choice review must trigger only a read-only source-schema recheck");
  assert.match(correction, /exactly ONE enabled branch executes/);
  assert.match(correction, /keep FAIL/);
  assert.ok(packet.items[0]!.assurance.changedPaths.includes("events/confront-and-choose.md"));
  assert.ok(packet.items[0]!.canonicalContext.some(record =>
    record.path === "events/confront-and-choose.md" &&
    record.content.includes("choice-point.steward-response")));
  assert.equal(readFileSync(join(state, "independent-reviews", sha + ".json"), "utf8"), receiptBytes,
    "Read-only replay must not change the sealed independent FAIL.");
});
