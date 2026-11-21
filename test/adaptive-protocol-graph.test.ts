import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenerationGraph } from '../src/generation.js';

test('production graph can assess an adaptive protocol failure and return to intake without a writer', async () => {
  const graph = await createGenerationGraph().getGraphAsync();
  assert.ok(graph.nodes.assess_recovery, 'missing recovery decision');
  assert.ok(graph.edges.some(e => e.source === 'author_update_intake' && e.target === 'assess_recovery'));
  assert.ok(graph.edges.some(e => e.source === 'assess_recovery' && e.target === 'author_update_intake'));
  assert.ok(graph.edges.some(e => e.source === 'completion_decision' && e.target === 'assess_recovery'),
    'unknown completion failure must use the existing recovery assessor, never dispatch a writer');
});
