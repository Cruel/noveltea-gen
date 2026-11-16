import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeTestTree } from './helpers.js';
import { renderFoundation, type FoundationDraft } from '../src/foundation-record.js';
import { parseStoryPlanning, type StoryPlanning } from '../src/story-planning.js';
import { reviewArchitectureMetrics, type StoryArchitectureMetrics } from '../src/story-metrics.js';
import { nativeExecutable } from '../src/native-cli-version.js';

const planning: StoryPlanning = {
  choice_frequency: 'occasional', choice_impact: 'lasting',
  branching: { depth: 'shallow', route_exclusivity: 'limited' },
  puzzle_emphasis: 'none', puzzle_count: { max: 0 }, pacing: 'narrative-led',
  first_playthrough: { min_minutes: 40, max_minutes: 80 },
  production: {
    illustrated_backgrounds: { count: { max: 1 }, firmness: 'hard' },
    background_variants: { count: { max: 2 }, firmness: 'soft' },
    character_artwork: { main: { count: { max: 2 }, firmness: 'hard' } },
  },
  illustration_concepts: [
    { id: 'harbor', description: 'Shared harbor vista',
      variants: [{ id: 'night', description: 'Night harbor' }] },
  ],
};

test('new Studio Story baselines require meaningful interaction/length/budget dimensions without fake quotas', () => {
  assert.deepEqual(parseStoryPlanning(planning, true), planning);
  assert.deepEqual(parseStoryPlanning({}, false), {});
  for (const invalid of [
    { ...planning, first_playthrough: undefined },
    { ...planning, production: {} },
    { ...planning, branching: { depth: 'linear', route_exclusivity: 'substantial' } },
    { ...planning, puzzle_count: { max: 3 } },
    { ...planning, production: { illustrated_backgrounds: { count: { max: -1 }, firmness: 'hard' } } },
    { ...planning, production: { illustrated_backgrounds: { count: { max: 1.5 }, firmness: 'soft' } } },
    { ...planning, unexpected: true },
  ]) assert.throws(() => parseStoryPlanning(invalid, true), /Invalid|cannot|needs/);
});

test('approved Creative Direction planning survives canonical serialization and native CLI metrics exactly', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-planning-'));
  try {
    mkdirSync(join(root, 'creative-direction'));
    const foundation: FoundationDraft = {
      id: 'foundation', title: 'A Quiet Harbor', premise: 'A missing boat',
      central_conflict: 'Whose story is true?', genre: 'Mystery', tone: 'Intimate',
      player_experience: 'A largely dialogue-led story', scope: 'One harbor',
      body: 'The investigator learns the truth through conversation.',
      decisions: [{ id: 'author', statement: 'No Puzzles; use the harbor illustration',
        origin: 'user', authority: 'user-protected' }], planning,
    };
    const rendered = renderFoundation(foundation, 'approved');
    assert.match(rendered, /status: approved/);
    assert.match(rendered, /planning: /);
    writeFileSync(join(root, 'creative-direction', 'foundation.md'), rendered);
    const run = (command: string) => {
      const result = spawnSync(nativeExecutable(), ['--json', 'narrative', command, root], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const validation = run('validate');
    assert.equal(validation.catalog.records.length, 1);
    assert.deepEqual(validation.catalog.records[0].metadata.planning, planning);
    const metric = run('metrics').metrics as StoryArchitectureMetrics;
    assert.equal(metric.foundation.status, 'approved');
    assert.deepEqual(metric.foundation.approvedFirstPlaythroughMinutes,
      { min_minutes: 40, max_minutes: 80 });
    assert.equal(metric.contentFootprint.illustrationConceptCount, 1);
    assert.equal(metric.contentFootprint.illustrationVariantCount, 1);
    const review = reviewArchitectureMetrics(metric, validation.catalog.records,
      validation.catalog.contractRevision, 'a'.repeat(40));
    assert.equal(review.requiresAuthorDirection.length, 0);
    assert.ok(review.warnings.length, 'unknown route estimates are not reported as zero');
    assert.match(review.catalogSourceRevision, /^xxh3-128:/);
    assert.match(review.sourceRevisionsDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(run('metrics').metrics, metric, 'read-only metrics are source stable');
  } finally { removeTestTree(root); }
});

test('native metrics admission rejects stale record inventory, schema drift and hard-limit overages', () => {
  const metrics: StoryArchitectureMetrics = {
    metricsVersion: 1, contractRevision: 'contract',
    catalogSourceRevision: 'xxh3-128:' + 'b'.repeat(32),
    sourceRevisions: [{ path: 'creative-direction/foundation.md',
      sourceRevision: 'xxh3-128:' + 'c'.repeat(32) }],
    foundation: { status: 'approved', targetCoverage: 'estimated',
      approvedFirstPlaythroughMinutes: { min_minutes: 60, max_minutes: 90 },
      productionBudget: { illustrated_backgrounds: { count: { max: 2 }, firmness: 'hard' } } },
    coverage: { missingNarrative: 1, missingExploration: 1,
      searchTruncated: false, unresolvedAlternatives: 1 },
    route: { status: 'unresolved', totalMinutes: null,
      narrativeMinutes: null, explorationMinutes: null },
    routeCoverage: { status: 'unverified', truncated: false },
    contentFootprint: { illustrationConceptCount: 3, illustrationVariantCount: 0,
      characterArtworkTiers: {}, classificationCoverage: 'unverified' },
    budgetFindings: [
      { dimension: 'illustrated-backgrounds', status: 'hard-violation',
        code: 'budget-hard-violation', severity: 'error', firmness: 'hard',
        count: 3, limit: 2 },
      { dimension: 'background-variants', status: 'soft-overage',
        code: 'budget-soft-overage', severity: 'warning', count: 3, limit: 2 },
    ],
  };
  const records = [{ path: 'creative-direction/foundation.md' }];
  const reviewed = reviewArchitectureMetrics(metrics, records, 'contract', 'a'.repeat(40));
  assert.match(reviewed.requiresAuthorDirection[0]!, /3 exceeds hard limit 2/);
  assert.match(reviewed.warnings[0]!, /soft preference/);
  assert.match(reviewed.warnings.join(' '), /uncertain/);
  assert.throws(() => reviewArchitectureMetrics(metrics, [], 'contract', 'a'.repeat(40)),
    /validated canonical record inventory/);
  assert.throws(() => reviewArchitectureMetrics(metrics, records, 'other', 'a'.repeat(40)),
    /complete source evidence/);
  assert.equal(metrics.route.totalMinutes, null, 'no fabricated playthrough duration');
});
