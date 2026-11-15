import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validRecoveryReviewCoverage, resolvedInheritedRecoveryReviews } from '../src/recovery-fork-state'
import { unresolvedNativePrerequisites, blockedByRequiredReview, executionId } from '../src/checkpoint-assurance'

const sha = (letter: string) => letter.repeat(40)
const world = sha('a'), repair = sha('b'), character = sha('c')
const completed = ['foundation', 'global-architecture', 'world-foundations', 'character-foundations']
const coverage = [
  { workItem: 'world-foundations', commitSha: world, status: 'failed' as const },
  { workItem: 'repair-' + world, commitSha: repair, status: 'passed' as const },
  { workItem: 'character-foundations', commitSha: character, status: 'passed' as const },
]
const required = { workItem: 'character-foundations', commitSha: character }

test('a verified repair of a failed completed specialist can be inherited without replay', () => {
  assert.equal(validRecoveryReviewCoverage(coverage, completed, required), true)
  assert.equal(validRecoveryReviewCoverage(coverage.filter(item => item.commitSha !== repair),
    completed, required), true, 'Original failure history remains independently recorded')
})

test('a passing repair unlocks inherited dependencies without changing historical reviewer verdicts', () => {
  const dependencies = { 'event:milestone.incident': ['world-foundations', 'character-foundations'],
    'character-foundations': ['world-foundations'] }
  const original = coverage.map(entry => ({ ...entry }))
  assert.deepEqual(unresolvedNativePrerequisites('event:milestone.incident',
    dependencies, original), ['world-foundations'])
  const derived = resolvedInheritedRecoveryReviews(original)
  assert.equal(coverage[0].status, 'failed', 'Saved World verdict must remain immutable')
  assert.equal(derived[0]?.status, 'not-required')
  assert.equal(derived[1]?.status, 'passed')
  assert.deepEqual(unresolvedNativePrerequisites('event:milestone.incident',
    dependencies, derived), [])
  const inventory = [
    { id: 'foundations', dependencies: ['architecture'], status: 'verified' },
    { id: 'event:milestone.incident', dependencies: ['foundations', 'architecture'], status: 'pending' },
  ]
  const decisions = (items: typeof coverage) => items.map(item => ({
    assignmentId: executionId(item.workItem), status: item.status,
  }))
  assert.ok(blockedByRequiredReview(inventory, decisions(original))
    .has('event:milestone.incident'))
  assert.equal(blockedByRequiredReview(inventory, decisions(derived)).size, 0,
    'Graph inventory and native dependency gates must agree about repaired inherited failures')
  assert.equal(resolvedInheritedRecoveryReviews([
    { ...coverage[0] }, { ...coverage[1], status: 'failed' }, coverage[2],
  ])[0]?.status, 'failed', 'A failed repair does not unblock the source')
})

test('repair coverage rejects absent, unrelated, cyclic or excessive failed-review ancestry', () => {
  assert.equal(validRecoveryReviewCoverage(coverage.slice(1), completed, required), false)
  assert.equal(validRecoveryReviewCoverage([
    { ...coverage[0], status: 'passed' }, ...coverage.slice(1),
  ], completed, required), false)
  assert.equal(validRecoveryReviewCoverage([
    ...coverage, { workItem: 'repair-' + sha('d'), commitSha: sha('d'), status: 'passed' },
  ], completed, required), false)
  assert.equal(validRecoveryReviewCoverage([...coverage, { ...coverage[0] }],
    completed, required), false)
  assert.equal(validRecoveryReviewCoverage([
    coverage[0],
    { workItem: 'repair-' + world, commitSha: sha('d'), status: 'failed' },
    { workItem: 'repair-' + sha('d'), commitSha: repair, status: 'failed' },
    { workItem: 'repair-' + repair, commitSha: sha('e'), status: 'passed' },
    coverage[2],
  ], completed, required), false, 'More than two review repairs must not be inherited')
})

test('selected assurance must be covered by its exact work item and commit', () => {
  assert.equal(validRecoveryReviewCoverage(coverage, completed, required), true)
  assert.equal(validRecoveryReviewCoverage(coverage, completed, {
    ...required, commitSha: sha('f'),
  }), false)
  assert.equal(validRecoveryReviewCoverage(coverage, completed, {
    ...required, workItem: 'event-fabricated',
  }), false)
  assert.equal(validRecoveryReviewCoverage(undefined, completed, required), false)
  assert.equal(validRecoveryReviewCoverage(undefined, completed), true)
})
