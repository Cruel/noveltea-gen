/** Opt-in, read-only source-bound replay of a preserved independent Choice
 * reviewer that read exactly one additional pinned writer method. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assignmentReviewerOptionalMethods } from "../src/narrative-review-specialist.js";
import { boundedPinnedSources, pinnedSourcePaths } from "../src/bounded-specialist-prompt.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";

test(
  "saved Choice reviewer reads only immutable pinned review and its own Choice method",
  {
    skip:
      !process.env.NT_PRESERVED_ASSIGNMENT_REVIEW_SOURCE &&
      "Opt in with NT_PRESERVED_ASSIGNMENT_REVIEW_SOURCE pointing to a disposable /tmp/nt158-* run.",
  },
  () => {
    const source = resolve(process.env.NT_PRESERVED_ASSIGNMENT_REVIEW_SOURCE ?? "");
    assert.match(source, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
    const jobs = readdirSync(join(source, "state/jobs"));
    assert.equal(jobs.length, 1);
    const state = join(source, "state/jobs", jobs[0]!);
    const receipts = readdirSync(join(state, "interactive-items")).filter((file) => file.endsWith(".json"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(readFileSync(join(state, "interactive-items", receipts[0]!), "utf8")) as {
      workItemId: string;
      snapshot: SkillSnapshot;
      units: Array<{ domain: string; phase: string; commitSha?: string }>;
    };
    assert.equal(receipt.units[0]?.domain, "choice");
    assert.equal(receipt.units[0]?.phase, "committed");
    assert.ok(receipt.units[0]?.commitSha);
    const packet = {
      items: [{ reviewedWorkItem: receipt.workItemId.replace(/^interactive-/, "interactive-choice-") }],
    } as SemanticReviewPacket;
    const required = pinnedSourcePaths(receipt.snapshot, boundedPinnedSources("nt-narrative-review"));
    const optional = assignmentReviewerOptionalMethods(receipt.snapshot, packet);
    assert.deepEqual(optional, [
      join(receipt.snapshot.path, "skills/nt-interactive-narrative/SKILL.md"),
      join(receipt.snapshot.path, "skills/nt-catalog/references/progression.md"),
    ]);
    const sessionRoot = join(state, "review-sessions/assignment-fidelity");
    const sessions = readdirSync(sessionRoot).filter((file) => file.endsWith(".jsonl"));
    assert.equal(sessions.length, 1);
    const transcript = readFileSync(join(sessionRoot, sessions[0]!), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            message?: {
              role: string;
              toolCallId?: string;
              isError?: boolean;
              content?: Array<{ type: string; id?: string; name?: string; arguments?: { path?: string } }>;
            };
          },
      );
    const passed = new Set(
      transcript
        .map((entry) => entry.message)
        .filter((message) => message?.role === "toolResult" && !message.isError)
        .map((message) => message!.toolCallId),
    );
    const reads = transcript
      .map((entry) => entry.message)
      .filter((message) => message?.role === "assistant")
      .flatMap((message) => message!.content ?? [])
      .filter(
        (block) => block.type === "toolCall" && block.name === "read" && block.id && passed.has(block.id),
      )
      .map((block) => block.arguments?.path);
    assert.ok(reads.includes("skill://nt-interactive-narrative/SKILL.md"));
    assert.ok(reads.includes("skill://nt-narrative-review/SKILL.md"));
    for (const path of reads) {
      assert.ok(
        typeof path === "string" && path.startsWith("skill://"),
        "Reviewer cannot read mutable Story bytes.",
      );
      const relative = path.slice("skill://".length);
      const full = join(receipt.snapshot.path, "skills", relative);
      assert.ok(
        required.includes(full) || optional.includes(full),
        "Original reviewer reads only the newly permitted exact skills: " + path,
      );
    }
    assert.ok(reads.length >= required.length);
    console.log(
      "SAVED_CHOICE_REVIEW_PINNED_METHODS",
      JSON.stringify({
        sourceCommit: receipt.units[0].commitSha,
        readCount: reads.length,
        optionalMethod: "nt-interactive-narrative/SKILL.md",
      }),
    );
  },
);
