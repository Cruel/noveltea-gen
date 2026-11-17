import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { missingAdaptiveMethodReads, adaptiveMethodCorrectionPrompt } from "../src/adaptive-method-correction.js";
import { requiredOrchestratorSkillReads } from "../src/story-skill-policy.js";

const root = "/story", snapshot = "/private/snapshots/skills/sha";
const required = requiredOrchestratorSkillReads("collaborative");
const messages = (paths: string[], failures: string[] = []) => [
  { role: "assistant", content: [...paths, ...failures].map((path, i) => ({
    type: "toolCall", name: "read", id: String(i), arguments: { path: "skill://" + path },
  })) },
  ...paths.map((_, i) => ({ role: "toolResult", toolCallId: String(i), isError: false })),
  ...failures.map((_, i) => ({ role: "toolResult", toolCallId: String(i + paths.length), isError: true })),
] as unknown as AgentSession["messages"];

test("adaptive review detects only genuinely missing successful pinned method reads", () => {
  const first = [required[0]!, required[2]!];
  const attempts = messages(first, [required[1]!]);
  assert.deepEqual(missingAdaptiveMethodReads(attempts, root, snapshot, required),
    required.filter(p => !first.includes(p)));
  // After the same original session completes the missing reads, the
  // controller accepts only the successful read-tool receipts.
  assert.deepEqual(missingAdaptiveMethodReads(messages([...required]), root, snapshot, required), []);
  assert.deepEqual(missingAdaptiveMethodReads(messages(["nt-catalog/SKILL.md"]), root, snapshot,
    ["nt-catalog/SKILL.md", "nt-catalog/references/records.md"]),
    ["nt-catalog/references/records.md"]);
});

test("adaptive same-session correction uses stable skill addresses and no new write authority", () => {
  const missing = ["nt-story-orchestrate/references/planning.md",
    "nt-catalog/references/records.md"];
  const prompt = adaptiveMethodCorrectionPrompt(missing);
  assert.match(prompt, /same read-only Pi session/);
  assert.match(prompt, /skill:\/\/nt-story-orchestrate\/references\/planning.md/);
  assert.match(prompt, /skill:\/\/nt-catalog\/references\/records.md/);
  assert.match(prompt, /Do not change any Story files/);
  assert.match(prompt, /sourceSha.*plan version/s);
  assert.doesNotMatch(prompt, /\/private\/snapshots/);
  for (const input of [[], ["../../secret.md"], ["nt-catalog/nope.txt"],
    Array(17).fill("nt-catalog/SKILL.md")]) {
    assert.throws(() => adaptiveMethodCorrectionPrompt(input), /exact pinned/);
  }
});
