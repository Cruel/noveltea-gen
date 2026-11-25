import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { removeTestTree } from "./helpers.js";
import { deriveFoundationAssignment, auditPaths, checkOutput,
  runCharacterWorldJob, inspectFoundationConflict } from "../src/character-world.js";
import { withJobModelRuntime } from "../src/model-runtime.js";
import { scriptedStoryRuntime, scriptedModel, scriptedReadCalls, scriptedText,
  fixtureSandboxClient } from "./c03-scripted-story-helpers.js";
import { foundationManifestCorrectionPrompt, characterInitialKnowledgeCorrection,
  CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE } from "../src/character-world-specialist.js";

const root = mkdtempSync(join(tmpdir(), "nt-character-world-"));
after(() => removeTestTree(root));
const source = resolve(process.env.NT_SKILLS_CHECKOUT ?? "../noveltea-skills");
const available = existsSync(join(source, "src/cli.ts"));

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
test("character assignment includes existing canonical Character paths instead of inventing duplicate IDs", () => {
  const record = (path: string, type: string, id: string, characters?: string[]) =>
    ({ path, metadata: { type, id, status: "draft", ...(characters ? { characters } : {}) } });
  const report = {
    records: [
      record("creative-direction/foundation.md", "creative-direction", "creative-direction.foundation"),
      record("arcs/missing-page.md", "arc", "arc.missing-page", ["character.nia"]),
      record("milestones/map-recovered.md", "milestone", "milestone.map-recovered"),
      record("characters/nia.md", "character", "character.nia"),
      record("characters/unrelated.md", "character", "character.unrelated"),
    ], diagnostics: [], outstanding: [],
    protection: { status: "checked", changes: [], warnings: [] },
    readiness: { design: { stages: {} } },
  };
  const plan = { version: 1, contract: { scope: { kind: "full-story" } },
    items: [{ id: "global-architecture", status: "verified",
      verifiedSha: "a".repeat(40), targetIds: ["arc.missing-page", "milestone.map-recovered"] },
    { id: "compose-scope", targetIds: ["character.nia"] }] };
  const character = deriveFoundationAssignment("character", plan as any, report as any, []);
  assert.ok(character.sourcePaths.includes("characters/nia.md"));
  assert.ok(!character.sourcePaths.includes("characters/unrelated.md"));
  const world = deriveFoundationAssignment("world", plan as any, report as any, []);
  assert.ok(!world.sourcePaths.includes("characters/nia.md"));
});

test("Character Fact baseline is mandatory, source-bound and repairable in the original session", () => {
  assert.match(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /At least ONE/);
  assert.match(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /EXISTING Fact|EXISTING.*Fact/i);
  assert.match(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /initial_knowledge:/);
  assert.match(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /value: knows/);
  assert.match(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /NEVER leave every Character/);
  assert.doesNotMatch(CHARACTER_INITIAL_KNOWLEDGE_GUIDANCE, /author a new Fact/i);
  const feedback = characterInitialKnowledgeCorrection([
    "fact.train-stranded-far-from-help", "fact.train-stranded-far-from-help",
    "../outside", "fact.other-possible-source",
  ]);
  assert.match(feedback, /SAME original Pi session/);
  assert.match(feedback, /fact.train-stranded-far-from-help/);
  assert.match(feedback, /initial_knowledge:\n  - fact: fact.train-stranded-far-from-help\n    value: knows/);
  assert.doesNotMatch(feedback, /\.\.\/outside/);
  assert.match(feedback, /not.*permission|not permission|no.*grant|Do not.*invent/i);
  assert.throws(() => characterInitialKnowledgeCorrection(["../outside"]), /No canonical Fact/);
});

test("completed foundation writer can correct a missing manifest in the same bounded session", () => {
  const feedback = foundationManifestCorrectionPrompt();
  assert.match(feedback, /SAME original Pi session/);
  assert.match(feedback, /modifiedRecords/);
  assert.match(feedback, /architecturalConflicts/);
  assert.match(feedback, /laterObligations/);
  assert.match(feedback, /do not edit or rerun the files/i);
  assert.match(feedback, /actual Git diff/);
  assert.doesNotMatch(feedback, /grant new paths|skip validation/i);
});
