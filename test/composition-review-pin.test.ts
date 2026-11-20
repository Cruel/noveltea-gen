import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  compositionReviewCycleId,
  verifyCompositionReviewPin,
  type CompositionAssignment,
} from "../src/composition-specialist.js";
import type { JobStartResult } from "../src/job.js";
import type { SkillSnapshot } from "../src/snapshot.js";

const sha = (input: string) => createHash("sha256").update(input).digest("hex");

test("Composition approval binds original independent transcript, actual prose, and authorized source lineage", async () => {
  const root = mkdtempSync(join(tmpdir(), "composition-review-pin-"));
  try {
    const stateDir = join(root, "state");
    const project = join(root, "story");
    const path = "authored-content/disclosure.md";
    const prose = "## Shared entry\n\nAda offers a choice without disclosing the secret.\n";
    const absolute = join(project, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, prose);
    const job = {
      jobId: "draft",
      threadId: "thread-draft",
      baseSha: "a".repeat(40),
      stateDir,
      worktreeStoryRoot: project,
    } as JobStartResult;
    const snapshot = { id: "pinned-skill-snapshot" } as SkillSnapshot;
    const assignment = {
      milestoneId: "milestone.disclosure",
      workItemId: "composition-disclosure",
      sourcePaths: ["events/disclosure.md"],
      composeTargets: ["event.disclosure"],
      branchWitnesses: [],
      authorTask: "Preserve a refused optional clue on the uninformed route.",
    } as CompositionAssignment;
    const original = "b".repeat(40),
      version = 1,
      planDigest = "c".repeat(64);
    const cycleId = compositionReviewCycleId(
      job,
      snapshot,
      assignment,
      "openai",
      "test",
      original,
      version,
      planDigest,
    );
    const writer = {
      id: "writer-session",
      file: join(stateDir, "composition-sessions", "composition-disclosure", "write", "writer.jsonl"),
    };
    const reviewer = {
      id: "reviewer-session",
      file: join(stateDir, "composition-sessions", "composition-disclosure", "review", "reviewer.jsonl"),
    };
    const verdict = {
      schema: "noveltea-composition-review/v2",
      status: "pass",
      findings: [],
      prior: [],
      sourceEvidence: ["event.disclosure#decision/refuse"],
    };
    for (const session of [writer, reviewer]) {
      mkdirSync(dirname(session.file), { recursive: true });
      writeFileSync(
        session.file,
        JSON.stringify({ type: "session", id: session.id }) +
          "\n" +
          (session === reviewer
            ? JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: [{ type: "text", text: JSON.stringify(verdict) }],
                },
              }) + "\n"
            : ""),
      );
    }
    const directory = join(stateDir, "composition-review-cycles", cycleId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "admitted.json"),
      JSON.stringify({
        schema: "noveltea-composition-review-admission/v1",
        cycleId,
        writer,
        reviewer,
      }),
    );
    const transcript = readFileSync(reviewer.file);
    const receipt = {
      schema: "noveltea-composition-review-round/v1",
      cycleId,
      round: 0,
      previousDigest: null,
      writer,
      reviewer,
      sources: { [path]: sha(prose) },
      verdict,
      transcriptBytes: transcript.length,
      transcriptDigest: sha(transcript.toString()),
    };
    writeFileSync(join(directory, "round-0.json"), JSON.stringify(receipt));
    const pin = { cycleId, round: 0, receiptDigest: sha(JSON.stringify(receipt)) };
    const verify = () =>
      verifyCompositionReviewPin(
        job,
        snapshot,
        assignment,
        "openai",
        "test",
        original,
        version,
        planDigest,
        writer,
        [path],
        pin,
      );
    const passed = await verify();
    assert.equal(passed.verdict, "pass");
    assert.deepEqual(passed.sourceEvidence, verdict.sourceEvidence);

    writeFileSync(absolute, prose + "\nThe key is already known on the refused route.\n");
    await assert.rejects(verify(), /current Authored Content/);
    writeFileSync(absolute, prose);

    writeFileSync(reviewer.file, JSON.stringify({ type: "session", id: "swapped" }) + "\n");
    await assert.rejects(verify(), /identity differs/);
    writeFileSync(reviewer.file, transcript);
    writeFileSync(
      join(directory, "round-0.json"),
      JSON.stringify({
        ...receipt,
        transcriptDigest: "0".repeat(64),
      }),
    );
    await assert.rejects(verify(), /transcript changed/);
    writeFileSync(join(directory, "round-0.json"), JSON.stringify(receipt));
    const fabricated = {
      ...receipt,
      verdict: { ...verdict, sourceEvidence: ["event.disclosure#decision/refuse", "fabricated approval"] },
    };
    writeFileSync(join(directory, "round-0.json"), JSON.stringify(fabricated));
    await assert.rejects(verify(), /does not match the Pi review response/);
    writeFileSync(join(directory, "round-0.json"), JSON.stringify(receipt));
    await assert.rejects(
      verifyCompositionReviewPin(
        job,
        snapshot,
        assignment,
        "openai",
        "test",
        "d".repeat(40),
        version,
        planDigest,
        writer,
        [path],
        pin,
      ),
      /authorized assignment/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
