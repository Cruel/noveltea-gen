import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { JobStartResult } from "../src/job.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import {
  compositionReviewCycleId,
  verifyCompositionReviewPin,
  type CompositionAssignment,
} from "../src/composition-specialist.js";
import {
  compositionReviewRequirements,
  parseCompositionReview,
  compositionReviewConvergence,
} from "../src/composition-review-policy.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (body: unknown) =>
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(body) }],
    },
  }) + "\n";

test("negative Composition review, corrected refused-clue prose, same reviewer reround and sealed final pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "composition-persistent-review-"));
  try {
    const stateDir = join(root, "state");
    const story = join(root, "story");
    const path = "authored-content/refused-clue.md";
    const target = join(story, path);
    mkdirSync(dirname(target), { recursive: true });
    const oldText = "## Shared entry\n\nThe refused route has the hidden archive key already.\n";
    const newText = "## Shared entry\n\nThe player may decline without learning the key.\n";
    writeFileSync(target, oldText);
    const job = {
      jobId: "draft",
      threadId: "thread",
      baseSha: "a".repeat(40),
      stateDir,
      worktreeStoryRoot: story,
    } as JobStartResult;
    const snapshot = { id: "fixed-pinned-snapshot" } as SkillSnapshot;
    const assignment = {
      milestoneId: "milestone.refusal",
      workItemId: "composition-refusal",
      sourcePaths: ["events/refusal.md"],
      authorTask: "Do not invent refused-route clues.",
    } as CompositionAssignment;
    const provider = "openai",
      model = "test-model",
      base = "b".repeat(40),
      planVersion = 2,
      planDigest = "c".repeat(64);
    const cycleId = compositionReviewCycleId(
      job,
      snapshot,
      assignment,
      provider,
      model,
      base,
      planVersion,
      planDigest,
    );
    const cycleDir = join(stateDir, "composition-review-cycles", cycleId);
    const sessionDir = join(stateDir, "composition-sessions", "composition-refusal");
    const writer = { id: "writer-1", file: join(sessionDir, "write", "writer.jsonl") };
    const reviewer = { id: "reviewer-1", file: join(sessionDir, "review", "reviewer.jsonl") };
    for (const item of [writer, reviewer]) {
      mkdirSync(dirname(item.file), { recursive: true });
      writeFileSync(item.file, JSON.stringify({ type: "session", id: item.id }) + "\n");
    }
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(
      join(cycleDir, "admitted.json"),
      JSON.stringify({
        schema: "noveltea-composition-review-admission/v1",
        cycleId,
        writer,
        reviewer,
      }),
    );
    const requirements = { policy: compositionReviewRequirements, assignment: JSON.stringify(assignment) };
    const finding = {
      path,
      reason: "A refused route knows a secret it did not earn.",
      correction: "Remove the archive key from shared text.",
      requirement: {
        source: "policy",
        quote: "Shared entry must not assume unavailable route-specific clues",
      },
      evidence: { path, quote: "The refused route has the hidden archive key already" },
      origin: "initial",
    };
    const blocked = parseCompositionReview(
      JSON.stringify({
        schema: "noveltea-composition-review/v2",
        status: "revise",
        findings: [finding],
        prior: [],
        sourceEvidence: [],
      }),
      [path],
      { [path]: oldText },
      requirements,
    );
    appendFileSync(reviewer.file, message(blocked));
    const firstPrefix = readFileSync(reviewer.file);
    const first = {
      schema: "noveltea-composition-review-round/v1",
      cycleId,
      round: 0,
      previousDigest: null,
      writer,
      reviewer,
      sources: { [path]: sha(oldText) },
      verdict: blocked,
      transcriptBytes: firstPrefix.length,
      transcriptDigest: sha(firstPrefix.toString()),
    };
    writeFileSync(join(cycleDir, "round-0.json"), JSON.stringify(first));

    writeFileSync(target, newText);
    const passed = parseCompositionReview(
      JSON.stringify({
        schema: "noveltea-composition-review/v2",
        status: "pass",
        findings: [],
        prior: [
          {
            round: 0,
            findingIndex: 0,
            status: "resolved",
            reason: "The corrected shared route withholds the archive key.",
            evidence: { path, quote: "The player may decline without learning the key" },
          },
        ],
        sourceEvidence: ["event.refusal#choice/refused"],
      }),
      [path],
      { [path]: newText },
      requirements,
      [{ sources: { [path]: oldText }, verdict: blocked }],
    );
    assert.equal(
      compositionReviewConvergence(passed, { [path]: newText }, [
        { sources: { [path]: oldText }, verdict: blocked },
      ]).productive,
      true,
    );
    appendFileSync(reviewer.file, message(passed));
    const finalPrefix = readFileSync(reviewer.file);
    const second = {
      schema: "noveltea-composition-review-round/v1",
      cycleId,
      round: 1,
      previousDigest: sha(JSON.stringify(first)),
      writer,
      reviewer,
      sources: { [path]: sha(newText) },
      verdict: passed,
      transcriptBytes: finalPrefix.length,
      transcriptDigest: sha(finalPrefix.toString()),
    };
    writeFileSync(join(cycleDir, "round-1.json"), JSON.stringify(second));
    const pin = { cycleId, round: 1, receiptDigest: sha(JSON.stringify(second)) };
    const verify = () =>
      verifyCompositionReviewPin(
        job,
        snapshot,
        assignment,
        provider,
        model,
        base,
        planVersion,
        planDigest,
        writer,
        [path],
        pin,
      );
    assert.equal((await verify()).verdict, "pass");
    assert.deepEqual((await verify()).sourceEvidence, passed.sourceEvidence);

    writeFileSync(
      join(cycleDir, "round-1.json"),
      JSON.stringify({ ...second, reviewer: { ...reviewer, id: "fresh-reviewer" } }),
    );
    await assert.rejects(verify(), /changed reviewer Pi session/);
    writeFileSync(join(cycleDir, "round-1.json"), JSON.stringify(second));
    writeFileSync(reviewer.file, firstPrefix);
    await assert.rejects(verify(), /transcript changed after its sealed verdict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
