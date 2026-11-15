import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validRecoveryReviewCoverage } from '../src/recovery-fork-state'

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
