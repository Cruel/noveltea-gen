import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptPostcommitReviewRound,
  bindPostcommitReviewCycle,
  inspectPostcommitReviewCycle,
  openPostcommitReviewCycle,
  postcommitCycleId,
  replacePostcommitProtocolReviewer,
  reviewCycleRoot,
} from "../src/postcommit-review-cycle.js";
import type { SemanticReviewPacket, SemanticVerdict } from "../src/semantic-assignment-review.js";
import type { JobStartResult } from "../src/job.js";
import type { SkillSnapshot } from "../src/snapshot.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const root = "a".repeat(40);
const second = "b".repeat(40);
const third = "c".repeat(40);
const fourth = "d".repeat(40);
const assignmentDigest = digest("authorized assignment");
const turnDigest = digest("trusted turn");
const snapshot = { id: digest("method snapshot"), path: "/pinned/snapshot" } as SkillSnapshot;

function packet(sha: string, previous = false, assignment = assignmentDigest): SemanticReviewPacket {
  return {
    policy: "assignment-fidelity/v1",
    sourceDigest: digest("packet:" + sha),
    items: [
      {
        assurance: {
          commitSha: sha,
          assignmentDigest: assignment,
          turnDigest,
        },
        ...(previous
          ? {
              priorNegative: {
                sourceCommitSha: root,
                rootFailureSha: root,
                reviewDigest: digest("negative"),
                findings: [],
                completedCorrections: 1,
              },
            }
          : {}),
      },
    ] as SemanticReviewPacket["items"],
  };
}
function verdict(p: SemanticReviewPacket, pass: boolean): SemanticVerdict {
  return {
    sourceDigest: p.sourceDigest,
    verdict: pass ? "pass" : "fail",
    findings: [],
    evidence: [],
  };
}
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "nt210-"));
  const job = {
    stateDir,
    jobId: randomUUID(),
    threadId: randomUUID(),
    baseSha: "f".repeat(40),
  } as JobStartResult;
  const file = join(stateDir, "review-sessions", "assignment-fidelity", "original.jsonl");
  mkdirSync(join(stateDir, "review-sessions", "assignment-fidelity"), { recursive: true });
  const reviewer = { id: randomUUID(), file };
  const writer = { id: randomUUID(), file: join(stateDir, "writer.jsonl") };
  writeFileSync(file, JSON.stringify({ type: "session", id: reviewer.id }) + "\n");
  const finish = () => rmSync(stateDir, { recursive: true, force: true });
  return { job, reviewer, writer, file, finish };
}
function addReview(file: string, text: string) {
  appendFileSync(
    file,
    JSON.stringify({
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

test("#210 postcommit reviewer keeps ONE independent Pi identity across three corrected commits", async () => {
  const { job, reviewer, writer, file, finish } = setup();
  try {
    const original = packet(root);
    const first = await bindPostcommitReviewCycle(
      job,
      original,
      snapshot,
      "openai",
      "gpt-6",
      undefined,
      reviewer,
      writer,
    );
    assert.ok(first);
    assert.equal(first.id, postcommitCycleId(job, original, snapshot, "openai", "gpt-6"));
    addReview(file, "first negative review, source " + root);
    await acceptPostcommitReviewRound(job, original, verdict(original, false), first);

    for (const sha of [second, third, fourth]) {
      const current = packet(sha, true);
      const prior = await openPostcommitReviewCycle(job, current, snapshot, "openai", "gpt-6");
      assert.deepEqual(prior?.reviewer, reviewer);
      assert.equal(prior?.rounds.length, [second, third, fourth].indexOf(sha) + 1);
      const continued = await bindPostcommitReviewCycle(
        job,
        current,
        snapshot,
        "openai",
        "gpt-6",
        undefined,
        reviewer,
        writer,
      );
      assert.equal(continued?.id, first.id);
      addReview(file, "independent follow-up reviews exact successor " + sha);
      const response = verdict(current, sha === fourth);
      await acceptPostcommitReviewRound(job, current, response, continued!);
      await acceptPostcommitReviewRound(job, current, response, continued!);
    }

    const accepted = await inspectPostcommitReviewCycle(job, root, assignmentDigest);
    assert.equal(accepted?.rounds.length, 4);
    assert.deepEqual(
      accepted?.rounds.map((r) => r.commitSha),
      [root, second, third, fourth],
    );
    assert.equal(accepted?.reviewer.id, reviewer.id);
    assert.equal(accepted?.reviewer.file, reviewer.file);
    await assert.rejects(
      () =>
        acceptPostcommitReviewRound(
          job,
          packet(second, true),
          verdict(packet(second, true), true),
          accepted!,
        ),
      /cannot rewrite a prior decision/,
    );
    await assert.rejects(
      () =>
        bindPostcommitReviewCycle(
          job,
          packet(fourth, true),
          snapshot,
          "openai",
          "gpt-6",
          undefined,
          writer,
          writer,
        ),
      /wrong or changed reviewer Pi session/,
    );
  } finally {
    finish();
  }
});

test("#210 wrong Thread, changed model/skill, tampered historical prefix and stale source fail closed", async () => {
  const { job, reviewer, writer, file, finish } = setup();
  try {
    const original = packet(root);
    const bound = await bindPostcommitReviewCycle(
      job,
      original,
      snapshot,
      "openai",
      "gpt-6",
      undefined,
      reviewer,
      writer,
    );
    addReview(file, "source-grounded rejection");
    await acceptPostcommitReviewRound(job, original, verdict(original, false), bound!);
    const successor = packet(second, true);
    const changedThread = { ...job, threadId: randomUUID() };
    await assert.rejects(
      () => openPostcommitReviewCycle(changedThread, successor, snapshot, "openai", "gpt-6"),
      /identity or provenance/,
    );
    await assert.rejects(
      () => openPostcommitReviewCycle(job, successor, snapshot, "openai", "other"),
      /model/,
    );
    await assert.rejects(
      () =>
        openPostcommitReviewCycle(
          job,
          successor,
          { ...snapshot, id: digest("different") },
          "openai",
          "gpt-6",
        ),
      /pinned methods/,
    );
    await assert.rejects(
      () =>
        openPostcommitReviewCycle(
          job,
          packet(second, true, digest("unauthorized new assignment")),
          snapshot,
          "openai",
          "gpt-6",
        ),
      /Original assignment reviewer cycle is missing/,
    );
    const oldBytes = readFileSync(file);
    writeFileSync(file, oldBytes.toString("utf8").replace("source-grounded", "fabricated-source"));
    await assert.rejects(
      () => inspectPostcommitReviewCycle(job, root, assignmentDigest),
      /immutable round evidence changed/,
    );
  } finally {
    finish();
  }
});

test("#210 invalid writer identity cannot take the reviewer role and an accepted review is never duplicated", async () => {
  const { job, reviewer, writer, file, finish } = setup();
  try {
    const p = packet(root);
    await assert.rejects(
      () => bindPostcommitReviewCycle(job, p, snapshot, "openai", "gpt-6", undefined, writer, writer),
      /wrong or changed reviewer Pi session/,
    );
    const cycle = await bindPostcommitReviewCycle(
      job,
      p,
      snapshot,
      "openai",
      "gpt-6",
      undefined,
      reviewer,
      writer,
    );
    assert.ok(cycle);
    addReview(file, "verified turn");
    await acceptPostcommitReviewRound(job, p, verdict(p, false), cycle);
    const receipt = readFileSync(
      join(job.stateDir, "review-cycles", root + "-" + assignmentDigest + ".json"),
      "utf8",
    );
    await acceptPostcommitReviewRound(job, p, verdict(p, false), cycle);
    assert.equal(
      readFileSync(join(job.stateDir, "review-cycles", root + "-" + assignmentDigest + ".json"), "utf8"),
      receipt,
    );
  } finally {
    finish();
  }
});

test("#210 bounded protocol-fresh handoff preserves review identity and refuses to overwrite prior rounds", async () => {
  const { job, reviewer, writer, file, finish } = setup();
  try {
    const p = packet(root);
    const cycle = await bindPostcommitReviewCycle(
      job,
      p,
      snapshot,
      "openai",
      "gpt-6",
      undefined,
      reviewer,
      writer,
    );
    assert.ok(cycle);
    const newFile = join(
      job.stateDir,
      "review-sessions",
      "assignment-fidelity",
      "protocol-fresh",
      "replacement.jsonl",
    );
    mkdirSync(join(job.stateDir, "review-sessions", "assignment-fidelity", "protocol-fresh"), {
      recursive: true,
    });
    const replacement = { id: randomUUID(), file: newFile };
    writeFileSync(newFile, JSON.stringify({ type: "session", id: replacement.id }) + "\n");
    await assert.rejects(
      () => replacePostcommitProtocolReviewer(job, p, cycle, replacement),
      /ENOENT|recovery receipt/,
    );
    const protocol = join(job.stateDir, "review-protocol");
    mkdirSync(protocol, { recursive: true });
    const prefix = join(protocol, "assignment-" + p.sourceDigest);
    writeFileSync(
      prefix + ".initial.json",
      JSON.stringify({
        contract: "reviewer.assignment-verdict.v1",
        sourceDigest: p.sourceDigest,
        status: "protocol-exhausted",
        sessionId: reviewer.id,
        sessionFile: reviewer.file,
      }),
    );
    writeFileSync(
      prefix + ".fresh-allowance.json",
      JSON.stringify({
        contract: "reviewer.assignment-verdict.v1",
        sourceDigest: p.sourceDigest,
        freshAllowanceConsumed: true,
        originalSessionId: reviewer.id,
        originalSessionFile: reviewer.file,
        freshSessionId: replacement.id,
        freshSessionFile: replacement.file,
      }),
    );
    writeFileSync(
      prefix + ".fresh.json",
      JSON.stringify({
        contract: "reviewer.assignment-verdict.v1",
        sourceDigest: p.sourceDigest,
        status: "accepted",
        sessionId: replacement.id,
        sessionFile: replacement.file,
      }),
    );
    const fresh = await replacePostcommitProtocolReviewer(job, p, cycle, replacement);
    assert.deepEqual(fresh.reviewer, replacement);
    assert.equal(fresh.protocolFresh, true);
    addReview(newFile, "fresh full independent source review");
    await acceptPostcommitReviewRound(job, p, verdict(p, false), fresh);
    const corrected = packet(second, true);
    const resumed = await openPostcommitReviewCycle(job, corrected,
      snapshot, "openai", "gpt-6");
    assert.deepEqual(resumed?.reviewer, replacement,
      "a negative protocol-fresh fallback must continue onto the corrected commit");
    assert.equal(resumed?.protocolFresh, true);
    const continued = await bindPostcommitReviewCycle(job, corrected, snapshot,
      "openai", "gpt-6", undefined, replacement, writer);
    assert.equal(continued?.id, fresh.id);
    addReview(newFile, "corrected successor retains original negative review and read-only methodology");
    await acceptPostcommitReviewRound(job, corrected, verdict(corrected, true), continued!);
    await assert.rejects(
      () => replacePostcommitProtocolReviewer(job, p, fresh, reviewer),
      /cannot be replaced/,
    );
  } finally {
    finish();
  }
});

test("#210 a material scope change starts a separate reviewer lineage with a sealed predecessor", async () => {
  const { job, reviewer, writer, file, finish } = setup();
  try {
    const initial = packet(root);
    const originalCycle = await bindPostcommitReviewCycle(
      job,
      initial,
      snapshot,
      "openai",
      "gpt-6",
      undefined,
      reviewer,
      writer,
    );
    assert.ok(originalCycle);
    addReview(file, "original negative verdict, retained without modification");
    await acceptPostcommitReviewRound(job, initial, verdict(initial, false), originalCycle);
    const newAssignment = digest("author-approved narrower assignment");
    const revisedPacket = packet(second, true, newAssignment);
    const revisedFile = join(job.stateDir, "review-sessions", "assignment-fidelity", "revised.jsonl");
    const revisedReviewer = { id: randomUUID(), file: revisedFile };
    writeFileSync(revisedFile, JSON.stringify({ type: "session", id: revisedReviewer.id }) + "\n");
    const revisedCycle = {
      ...originalCycle,
      id: postcommitCycleId(job, revisedPacket, snapshot, "openai", "gpt-6")!,
      assignmentDigest: newAssignment,
      reviewer: revisedReviewer,
      rounds: [],
      predecessor: { assignmentDigest, cycleId: originalCycle.id, failedCommitSha: root },
    };
    const receiptFile = join(job.stateDir, "review-cycles", root + "-" + newAssignment + ".json");
    // A forged new-scope receipt has no effect on the immutable original cycle.
    writeFileSync(receiptFile, JSON.stringify(revisedCycle));
    const opened = await openPostcommitReviewCycle(job, revisedPacket, snapshot, "openai", "gpt-6");
    assert.deepEqual(opened?.reviewer, revisedReviewer);
    addReview(revisedFile, "first revised-scope negative review");
    await acceptPostcommitReviewRound(job, revisedPacket, verdict(revisedPacket, false), opened!);
    const next = packet(third, true, newAssignment);
    assert.deepEqual(
      (await openPostcommitReviewCycle(job, next, snapshot, "openai", "gpt-6"))?.reviewer,
      revisedReviewer,
    );
    addReview(revisedFile, "second revised-scope review corrects the current requirement");
    await acceptPostcommitReviewRound(job, next, verdict(next, true), opened!);
    assert.equal((await inspectPostcommitReviewCycle(job, root, newAssignment))?.rounds.length, 2);
    assert.equal((await inspectPostcommitReviewCycle(job, root, assignmentDigest))?.rounds.length, 1);
    writeFileSync(
      receiptFile,
      JSON.stringify({
        ...revisedCycle,
        predecessor: { ...revisedCycle.predecessor, failedCommitSha: fourth },
      }),
    );
    await assert.rejects(
      () => openPostcommitReviewCycle(job, next, snapshot, "openai", "gpt-6"),
      /sealed predecessor source/,
    );
  } finally {
    finish();
  }
});

test("#210 a dispute is a separate independent adjudication, not a continuation or a source PASS", async () => {
  const { job, reviewer, writer, finish } = setup();
  try {
    const contested = {
      ...packet(root),
      dispute: {
        sourceSha: root,
        claim: "The original source citation is incorrect.",
        path: "characters/nia.md",
        line: 1,
        negativeFindings: [],
      },
    } as SemanticReviewPacket;
    assert.equal(reviewCycleRoot(contested), null);
    assert.equal(postcommitCycleId(job, contested, snapshot, "openai", "gpt-6"), null);
    assert.equal(
      await bindPostcommitReviewCycle(
        job,
        contested,
        snapshot,
        "openai",
        "gpt-6",
        undefined,
        reviewer,
        writer,
      ),
      null,
    );
    assert.equal(await inspectPostcommitReviewCycle(job, root, assignmentDigest), null);
  } finally {
    finish();
  }
});
