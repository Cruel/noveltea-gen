/** Opt-in replay of a real Character repair reviewer rejected by the former
 * stage-name method allowlist. Reads only saved session evidence. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { reviewerPinnedSkillPath } from "../src/skills.js";
import type { SkillSnapshot } from "../src/snapshot.js";

test("preserved Character repair reviewer may consult cross-specialist pinned methods", {
  skip: !process.env.NT_PRESERVED_REPAIR_REVIEW_SOURCE &&
    "Set NT_PRESERVED_REPAIR_REVIEW_SOURCE to a saved /tmp/nt158-* certification run.",
}, () => {
  const source = resolve(process.env.NT_PRESERVED_REPAIR_REVIEW_SOURCE!);
  assert.match(source, /^\/tmp\/nt158-[A-Za-z0-9-]+$/);
  const jobs = readdirSync(join(source, "state/jobs"));
  assert.equal(jobs.length, 1);
  const state = join(source, "state/jobs", jobs[0]!);
  const foundation = JSON.parse(readFileSync(join(state, "character-world.json"), "utf8")) as {
    snapshot: SkillSnapshot;
  };
  const repairs = readdirSync(join(state, "review-repairs")).filter(file => file.endsWith(".json"));
  assert.equal(repairs.length, 1);
  const repair = JSON.parse(readFileSync(join(state, "review-repairs", repairs[0]!), "utf8")) as {
    origin: { workItem: string };
    phase: string;
  };
  assert.equal(repair.origin.workItem, "character-foundations");
  assert.equal(repair.phase, "reviewing");

  const root = join(state, "review-sessions/assignment-fidelity");
  const sessions = readdirSync(root).filter(file => file.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const messages = readFileSync(join(root, sessions[0]!), "utf8").trim().split("\n")
    .map(line => JSON.parse(line).message).filter(Boolean);
  const success = new Set(messages.filter(message => message.role === "toolResult" && !message.isError)
    .map(message => message.toolCallId));
  const reads: string[] = messages.filter(message => message.role === "assistant")
    .flatMap(message => message.content ?? [])
    .filter(call => call.type === "toolCall" && call.name === "read" && success.has(call.id))
    .map(call => call.arguments?.path);
  for (const skill of [
    "nt-narrative-review", "nt-story-architecture",
    "nt-worldbuilding", "nt-character-development",
  ]) {
    assert.ok(reads.includes("skill://" + skill + "/SKILL.md"), skill + " was actually read");
  }
  for (const path of reads) {
    assert.match(path, /^skill:\/\//, "A reviewer must not read the mutable Story");
    assert.equal(reviewerPinnedSkillPath(foundation.snapshot.path,
      join(foundation.snapshot.path, "skills", path.slice("skill://".length))), true, path);
  }
});
