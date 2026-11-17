import assert from "node:assert/strict";
import { test } from "node:test";
import { architectureSpecialistPrompt } from "../src/architecture-specialist.js";
import type { SkillSnapshot } from "../src/snapshot.js";
import type { Plan } from "../src/architecture.js";

const snapshot = {
  path: "/certified/pinned-skill-snapshot", id: "a".repeat(64),
  digest: "a".repeat(64), commit: "b".repeat(40),
  branch: null, detached: true, dirty: false,
} satisfies SkillSnapshot;
const plan = {
  version: 1, contract: {
    scope: { kind: "full-story", depth: "composition", targets: [], branches: [] },
    constraints: [], envelope: { presentation: "Visual novel", hardLimits: [], preferences: [] },
  }, items: [],
} satisfies Plan;

test("Architecture writer receives source-bound whole-Story Choice consequences and honest route-estimate guidance", () => {
  const prompt = architectureSpecialistPrompt(snapshot, plan, true,
    "Make several lasting choices with an observation-only opening.");
  assert.match(prompt, /each major (player )?decision/i);
  assert.match(prompt, /causal prerequisites|prerequisites.*decision/i);
  assert.match(prompt, /reconverg/i);
  assert.match(prompt, /Arc trajectory/i);
  assert.match(prompt, /mutually exclusive|route alternative/i);
  assert.match(prompt, /not .*sum|never .*sum/i);
  assert.match(prompt, /provisional|uncertainty/i);
  assert.match(prompt, /not by inventing later Event IDs/i);
  assert.match(prompt, /No new user-protected|new user-protected/i);
});
