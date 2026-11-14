import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { canonicalPinnedReadPath, completedPinnedSkillReads, requirePinnedSkillReads } from "../src/pinned-skill-reads.js";

test("snapshot roots containing /skills/ credit successful pinned skill:// reads", async () => {
  const root = "/tmp/cert/skills/abc123";
  const required = ["nt-interactive-narrative/SKILL.md",
    "nt-catalog/references/authority-and-validation.md", "nt-catalog/references/glossary.md"]
    .map(name => root + "/skills/" + name);
  const messages = [
    { role: "assistant", content: required.map((name, index) => ({
      type: "toolCall", name: "read", id: "ref" + index,
      arguments: { path: "skill://" + name.slice((root + "/skills/").length) },
    })) },
    ...required.map((_, index) => ({ role: "toolResult", toolCallId: "ref" + index, isError: false })),
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(await requirePinnedSkillReads({ messages } as AgentSession,
    "/story/job", required, "Interactive specialist"), required);
});

test("counts only completed exact skill reads, never typo paths or failed tool calls", () => {
  const root = "/story/job";
  const correct = "/snapshots/known/skills/nt-catalog/SKILL.md";
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", name: "read", id: "valid", arguments: { path: correct } },
      { type: "toolCall", name: "read", id: "typo", arguments: { path: "/snapshots/kn0wn/skills/nt-catalog/references/records.md" } },
      { type: "toolCall", name: "read", id: "failed", arguments: { path: "/snapshots/known/skills/nt-catalog/references/progression.md" } },
      { type: "toolCall", name: "bash", id: "shell", arguments: { path: "/snapshots/known/skills/nt-worldbuilding/SKILL.md" } },
    ] },
    { role: "toolResult", toolCallId: "valid", isError: false },
    { role: "toolResult", toolCallId: "typo", isError: true },
    { role: "toolResult", toolCallId: "failed", isError: true },
    { role: "toolResult", toolCallId: "shell", isError: false },
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(completedPinnedSkillReads(messages, root), [correct]);
  messages.push({ role: "assistant", content: [
    { type: "toolCall", name: "read", id: "retry", arguments: { path: "/snapshots/known/skills/nt-catalog/references/progression.md" } },
  ] } as AgentSession["messages"][number]);
  messages.push({ role: "toolResult", toolCallId: "retry", isError: false } as AgentSession["messages"][number]);
  assert.deepEqual(completedPinnedSkillReads(messages, root), [correct,
    "/snapshots/known/skills/nt-catalog/references/progression.md"]);
});

test("successful short-address reads record original pinned paths, not model-visible aliases", () => {
  const root = "/story/job", snapshot = "/snapshots/known";
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", name: "read", id: "short", arguments: { path: "skill://nt-catalog/references/records.md" } },
      { type: "toolCall", name: "read", id: "rejected", arguments: { path: "skill://nt-catalog/../nt-story-orchestrate/SKILL.md" } },
    ] },
    { role: "toolResult", toolCallId: "short", isError: false },
    { role: "toolResult", toolCallId: "rejected", isError: true },
  ] as unknown as AgentSession["messages"];
  assert.deepEqual(completedPinnedSkillReads(messages, root, snapshot),
    ["/snapshots/known/skills/nt-catalog/references/records.md"]);
  assert.equal(canonicalPinnedReadPath("skill://nt-catalog/../nt-story-orchestrate/SKILL.md", root, snapshot), "");
  assert.equal(canonicalPinnedReadPath("events/opening.md", root, snapshot), "/story/job/events/opening.md");
});
