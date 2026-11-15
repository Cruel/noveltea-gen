/** Opt-in exact saved Luna Event-review method replay. Pinned read-only evidence;
 * no mutation, no writer replay, no forged review verdict. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { reviewerPinnedSkillPath } from "../src/skills.js";
import type { SkillSnapshot } from "../src/snapshot.js";

test("saved Luna Event reviewer reads only canonical verified snapshot references", {
  skip: !process.env.NT_PRESERVED_EVENT_REVIEW_SOURCE &&
    "Set NT_PRESERVED_EVENT_REVIEW_SOURCE to the private /tmp/nt158-* run.",
}, () => {
  const root = resolve(process.env.NT_PRESERVED_EVENT_REVIEW_SOURCE!);
  assert.match(root, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
  const jobs = readdirSync(join(root, "state/jobs"));
  assert.equal(jobs.length, 1);
  const state = join(root, "state/jobs", jobs[0]!);
  const items = readdirSync(join(state, "event-items")).filter(x => x.endsWith(".json"));
  assert.equal(items.length, 1);
  const receipt = JSON.parse(readFileSync(join(state, "event-items", items[0]!), "utf8")) as {
    snapshot: SkillSnapshot; phase: string; commitSha: string;
  };
  assert.equal(receipt.phase, "committed");
  assert.match(receipt.commitSha, /^[a-f0-9]{40}$/);
  const sessionsRoot = join(state, "review-sessions/assignment-fidelity");
  const sessions = readdirSync(sessionsRoot).filter(x => x.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const messages = readFileSync(join(sessionsRoot, sessions[0]!), "utf8")
    .trim().split("\n").map(line => JSON.parse(line).message).filter(Boolean);
  const completed = new Set(messages.filter(x => x.role === "toolResult" && !x.isError)
    .map(x => x.toolCallId));
  const reads: string[] = messages.filter(x => x.role === "assistant")
    .flatMap(x => x.content ?? [])
    .filter(x => x.type === "toolCall" && x.name === "read" && completed.has(x.id))
    .map(x => x.arguments?.path);
  for (const method of [
    "skill://nt-worldbuilding/SKILL.md", "skill://nt-character-development/SKILL.md",
    "skill://nt-event-design/SKILL.md",
  ]) assert.ok(reads.includes(method), "Live reviewer read " + method);
  for (const path of reads) {
    assert.match(path, /^skill:\/\//, "The reviewer cannot read live Story or absolute paths");
    const absolute = join(receipt.snapshot.path, "skills", path.slice("skill://".length));
    assert.ok(reviewerPinnedSkillPath(receipt.snapshot.path, absolute),
      "Only immutable reviewer-visible snapshot methods are allowed: " + path);
  }
  console.log("SAVED_EVENT_REVIEW_PINNED_METHODS",
    JSON.stringify({ commit: receipt.commitSha, successfulReads: reads.length }));
});
