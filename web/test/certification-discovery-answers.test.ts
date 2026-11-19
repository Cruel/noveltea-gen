import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCertificationDurationQuestion } from './support/full-story-case'

test('an incidental duration preamble cannot turn a mystery-premise question into a length question', () => {
  const question = {
    id: 'mystery-premise',
    question: 'What should the player investigate? The 30–45-minute limit is already fixed.',
  }
  assert.equal(isCertificationDurationQuestion(question.id), false)
  assert.equal(isCertificationDurationQuestion('duration'), true)
  assert.equal(isCertificationDurationQuestion('first-playthrough'), true)
  assert.equal(isCertificationDurationQuestion('game-length'), true)
  assert.equal(isCertificationDurationQuestion('story-tone'), false)
})
