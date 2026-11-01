import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { completedPinnedSkillReads } from "../src/pinned-skill-reads.js";

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
