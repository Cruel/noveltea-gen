/** Opt-in immutable replay of the real Foundations reviewer read-policy blocker.
 * Does not modify or replay the original Story or reviewer session. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assignmentReviewerOptionalMethods } from "../src/narrative-review-specialist.js";
import { boundedPinnedSources, pinnedSourcePaths } from "../src/bounded-specialist-prompt.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import type { SemanticReviewPacket } from "../src/semantic-assignment-review.js";

test("saved Luna World reviewer uses only exact pinned World/Character methods", {
  skip: !process.env.NT_PRESERVED_FOUNDATIONS_REVIEW_SOURCE &&
    "Set NT_PRESERVED_FOUNDATIONS_REVIEW_SOURCE to the private /tmp/nt158-* run.",
}, () => {
  const source = resolve(process.env.NT_PRESERVED_FOUNDATIONS_REVIEW_SOURCE!);
  assert.match(source, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
  const jobs = readdirSync(join(source, "state/jobs"));
  assert.equal(jobs.length, 1);
  const state = join(source, "state/jobs", jobs[0]!);
  const receipt = JSON.parse(readFileSync(join(state, "character-world.json"), "utf8")) as {
    snapshot: SkillSnapshot;
    units: Array<{ id: string; phase: string; commitSha?: string }>;
  };
  assert.equal(receipt.units[0]?.id, "world-foundations");
  assert.equal(receipt.units[0]?.phase, "committed");
  assert.match(receipt.units[0]?.commitSha ?? "", /^[a-f0-9]{40}$/);
  const packet = { items: [{ reviewedWorkItem: "world-foundations" }] } as SemanticReviewPacket;
  const required = pinnedSourcePaths(receipt.snapshot, boundedPinnedSources("nt-narrative-review"));
  const optional = assignmentReviewerOptionalMethods(receipt.snapshot, packet);
  assert.deepEqual(optional, [
    join(receipt.snapshot.path, "skills/nt-worldbuilding/SKILL.md"),
    join(receipt.snapshot.path, "skills/nt-character-development/SKILL.md"),
  ]);
  const root = join(state, "review-sessions/assignment-fidelity");
  const sessions = readdirSync(root).filter(name => name.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const messages = readFileSync(join(root, sessions[0]!), "utf8")
    .trim().split("\n").map(line => JSON.parse(line).message).filter(Boolean);
  const successful = new Set(messages.filter(m => m.role === "toolResult" && !m.isError)
    .map(m => m.toolCallId));
  const reads = messages.filter(m => m.role === "assistant")
    .flatMap(m => m.content ?? [])
    .filter(c => c.type === "toolCall" && c.name === "read" && successful.has(c.id))
    .map(c => c.arguments?.path);
  assert.ok(reads.includes("skill://nt-worldbuilding/SKILL.md"));
  assert.ok(reads.includes("skill://nt-character-development/SKILL.md"));
  for (const ref of reads) {
    assert.match(ref ?? "", /^skill:\/\//, "Reviewer must not read mutable Story files");
    const full = join(receipt.snapshot.path, "skills", ref!.slice("skill://".length));
    assert.ok([...required, ...optional].includes(full),
      "Reviewer must not gain unrelated or unpinned skill reads: " + ref);
  }
  console.log("SAVED_WORLD_REVIEW_PINNED_METHODS",
    JSON.stringify({ commit: receipt.units[0]?.commitSha, successfulReads: reads.length }));
});
