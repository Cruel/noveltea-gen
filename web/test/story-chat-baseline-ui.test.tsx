import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { StoryChatBaselineView, type StoryChatBaselineSession } from '../src/components/story-chat-baseline-view'

const storyId = '11111111-1111-4111-8111-111111111111'
const turnId = '22222222-2222-4222-8222-222222222222'
function render(phase: 'questions' | 'proposed' | 'approved') {
  const foundation = {
    id: 'foundation', title: 'The Last Bell', premise: 'A missing bell',
    central_conflict: 'A town conceals the truth', genre: 'Mystery', tone: 'Uneasy',
    player_experience: 'Follow clues', scope: 'One town',
    body: 'Player investigation leads to a choice of loyalties.',
    decisions: [{ id: 'author-brief', statement: 'Keep player choices meaningful',
      origin: 'user', authority: 'user-protected' },
    { id: 'discovery-1', statement: 'Use multiple endings',
      origin: 'agent', authority: 'delegated' }],
  }
  const session = {
    phase, revision: 4, skillId: 'a'.repeat(64), startedAt: null,
    chat: { storyId, firstTurnId: turnId, sourceSha: 'b'.repeat(40), directory: 'story' },
    turns: [{ role: 'user', text: 'Make me a mystery game' }],
    questions: phase === 'questions' ? 'What tone? Recommendation: uneasy.' : null,
    proposal: phase === 'questions' ? null : { foundation, task: 'Make me a mystery game' },
    digest: phase === 'proposed' ? 'c'.repeat(64) : null,
  } as StoryChatBaselineSession
  return renderToStaticMarkup(createElement(StoryChatBaselineView, {
    session, answer: '', onAnswerChange: () => {}, busy: false,
    error: null, onAction: () => {},
  }))
}

test('first Thread discovery stays in Chat with recommended questions and partial-answer control', () => {
  const markup = render('questions')
  assert.match(markup, /Creative Direction/)
  assert.match(markup, /What tone\? Recommendation: uneasy/)
  assert.match(markup, /aria-label="Discovery answers"/)
  assert.match(markup, />Send answers</)
  assert.doesNotMatch(markup, /Approve baseline|Initialize Story/)
})

test('exact proposed foundation and author-decision provenance are reviewable before approval', () => {
  const markup = render('proposed')
  assert.match(markup, /The Last Bell/)
  assert.match(markup, /player experience|Player experience/i)
  assert.match(markup, /user · user-protected/)
  assert.match(markup, /agent · delegated/)
  assert.match(markup, /Keep player choices meaningful/)
  assert.match(markup, /Approve baseline/)
  assert.match(markup, /Request revision/)
  assert.doesNotMatch(markup, /Publish|Initialize Story/)
})

test('approved baseline preserves the exact review while its original Turn continues', () => {
  const markup = render('approved')
  assert.match(markup, /native-validated/)
  assert.match(markup, /No later Story edits or publication were approved/)
  assert.doesNotMatch(markup, /Approve baseline/)
})
