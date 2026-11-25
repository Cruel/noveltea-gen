import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidate } from '../src/lib/story-foundation.server'

const source = {
  id: 'short-mystery', title: 'A Short Mystery', premise: 'A missing artifact',
  central_conflict: 'An unreliable witness', genre: 'Mystery', tone: 'Grounded',
  player_experience: 'Investigate and choose', scope: 'A small museum',
  body: 'A complete investigation with consequences.',
}
const decisions = (length: number) => Array.from({ length }, (_, n) => ({
  id: 'decision-' + n, statement: 'Submitted author decision ' + n,
  origin: n < 18 ? 'user' : 'agent',
  authority: n < 18 ? 'user-protected' : 'delegated',
}))

test('Studio preserves distinct author and agent discovery evidence without imposing a decision-count ceiling', () => {
  const accepted = candidate({ ...source, decisions: decisions(30) })
  assert.match(accepted.file, /decision-29/)
  assert.match(accepted.file, /origin: user/)
  assert.match(accepted.file, /origin: agent/)
  const expanded = candidate({ ...source, decisions: decisions(64) })
  assert.match(expanded.file, /decision-63/)
  assert.equal((expanded.file.match(/  - id: decision-/g) ?? []).length, 64)
  assert.throws(() => candidate({ ...source, decisions: decisions(20).map((item, i) =>
    i === 19 ? { ...item, origin: 'user', authority: 'delegated' } : item) }),
  /Invalid Creative Direction decision provenance/,
  'The increased count does not loosen protected author provenance')
})
