import assert from "node:assert/strict";
import { test } from "node:test";
import { generationShards, generationWeight, selectGenerationShard } from "./generation-shards.js";

test("generation shards cover each registered case exactly once and spread expensive cases", () => {
  const heavy = ["review-stalled-continue", "review-converges", "review-stalled"].map(scenario =>
    "R01 production Foundation enters checkpointed child before scripted Pi; native Git and independent Review remain authoritative (" + scenario + ")");
  const names = [...heavy, ...Array.from({ length: 100 }, (_, i) => "future test " + i)];
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
