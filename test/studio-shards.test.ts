import assert from "node:assert/strict";
import { test } from "node:test";
import { revisionScenarios, selectRevisionScenarios } from "../web/test/support/story-revision-scenarios.js";
import { revisionFile, selectStudioShard, studioShards, studioTestFiles, studioTestUnits } from "../web/test/support/studio-shards.js";

test("four Studio shards cover every discovered file and registered revision scenario exactly once", () => {
  const files = studioTestFiles();
  assert.ok(files.some(file => file.endsWith(".test.tsx")), "include UI test files");
  assert.ok(files.includes(revisionFile));
  assert.equal(new Set(revisionScenarios.map(scenario => scenario.name)).size, revisionScenarios.length);
  const plans = studioShards(files, 4);
  assert.deepEqual(plans.flatMap(plan => plan.files.filter(file => file !== revisionFile)).sort(),
    files.filter(file => file !== revisionFile).sort());
  assert.deepEqual(plans.flatMap(plan => plan.revisionCases).sort(),
    revisionScenarios.map(scenario => scenario.kind).sort());
  for (const [index, plan] of plans.entries()) {
    assert.ok(plan.files.length > 0);
    assert.equal(plan.files.includes(revisionFile), plan.revisionCases.length > 0);
    assert.deepEqual(selectStudioShard(files, (index + 1) + "/4"), plan);
    if (plan.revisionCases.length)
      assert.deepEqual(selectRevisionScenarios(plan.revisionCases.join(",")).map(scenario => scenario.kind).sort(),
        [...plan.revisionCases].sort());
  }
  assert.ok(plans.filter(plan => plan.revisionCases.length > 0).length > 1,
    "the expensive revision-admission suite must not be an indivisible file");
  assert.deepEqual(studioShards([...files].reverse(), 4), plans);
  assert.equal(plans.reduce((sum, plan) => sum + plan.estimatedSeconds, 0),
    studioTestUnits(files).reduce((sum, unit) => sum + unit.seconds, 0));
  const weights = plans.map(plan => plan.estimatedSeconds);
  assert.ok(Math.max(...weights) - Math.min(...weights) <= 15, JSON.stringify(weights));
});

test("new Studio files participate automatically and invalid shard selections fail closed", () => {
  const files = [...studioTestFiles(), "future-new-suite.test.tsx"];
  assert.equal(studioShards(files, 4).flatMap(plan => plan.files).filter(file => file === "future-new-suite.test.tsx").length, 1);
  assert.deepEqual(selectRevisionScenarios(undefined), revisionScenarios);
  for (const invalid of ["", "not-a-scenario", "broad,broad", "broad,not-a-scenario"])
    assert.throws(() => selectRevisionScenarios(invalid), /Invalid/);
  for (const invalid of ["", "0/4", "5/4", "1/0", "1/9999999", "1/9007199254740992"])
    assert.throws(() => selectStudioShard(files, invalid), /Invalid/);
  assert.throws(() => studioShards(files.filter(file => file !== revisionFile), 4), /Missing/);
  assert.throws(() => studioShards([...files, revisionFile], 4), /Duplicate/);
});
