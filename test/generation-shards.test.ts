import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { focusedGenerationWeight, selectFocusedGenerationShard, generationShards, generationWeight, selectGenerationShard } from "./generation-shards.js";

test("generation shards cover each registered case exactly once and spread expensive cases", () => {
  const prefix = "R07 integrated Event, Interactive and Composition carry cross-owner support through ordinary scheduling";
  const heavy = ["", " with supported producer", " with repaired-sibling producer"].map(suffix => prefix + suffix);
  const names = [...heavy, ...Array.from({ length: 150 }, (_, i) => "future test " + i)];
  const buckets = generationShards(names, 6);
  assert.deepEqual(buckets.flat().sort(), [...names].sort());
  assert.deepEqual(generationShards([...names].reverse(), 6), buckets);
  assert.ok(buckets.every(bucket => heavy.filter(name => bucket.includes(name)).length <= 1));
  const loads = buckets.map(bucket => bucket.reduce((sum, name) => sum + generationWeight(name), 0));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 10, JSON.stringify(loads));
  for (let i = 0; i < buckets.length; i++)
    assert.deepEqual(selectGenerationShard(names, (i + 1) + "/6"), buckets[i]);
  assert.throws(() => generationShards([...names, names[0]!], 6), /Duplicate/);
  assert.throws(() => selectGenerationShard(names, "7/6"), /Invalid/);
  assert.throws(() => selectGenerationShard(names, "0/6"), /Invalid/);
  assert.throws(() => selectGenerationShard(names, "1/999"), /Invalid/);
});

test("focused cases are partitioned exactly once and expensive assessments are separated", () => {
  const prefix = "R04 cross-owner prerequisite ";
  const heavy = ["writer-review-assessment", "review-review-assessment"].map(s => prefix + s + " uses the original logical assignment");
  const names = [...heavy, ...Array.from({ length: 12 }, (_, i) => "focused case " + i)];
  const shards = Array.from({ length: 4 }, (_, i) => selectFocusedGenerationShard(names, (i + 1) + "/4"));
  assert.deepEqual(shards.flat().sort(), [...names].sort());
  assert.ok(shards.every(bucket => heavy.filter(name => bucket.includes(name)).length <= 1));
  assert.ok(focusedGenerationWeight(heavy[1]!) >= 300);
  assert.deepEqual(shards, Array.from({ length: 4 }, (_, i) => selectFocusedGenerationShard([...names].reverse(), (i + 1) + "/4")));
});

test("a timed-out stateful scenario cannot contaminate the next scenario", () => {
  const fixture = fileURLToPath(new URL("./support/serial-scenarios-fixture.ts", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", fixture], {
    encoding: "utf8", timeout: 10_000, env,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /test timed out after 20ms/);
  assert.match(result.stdout, /Previous scenario was interrupted before cleanup: interrupted/);
  assert.doesNotMatch(result.stdout + result.stderr, /Following scenario was allowed to touch/);
});
