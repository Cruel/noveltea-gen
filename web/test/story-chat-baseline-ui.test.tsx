import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { StoryChatBaselineView, type StoryChatBaselineSession } from '../src/components/story-chat-baseline-view'

const storyId = '11111111-1111-4111-8111-111111111111'
const turnId = '22222222-2222-4222-8222-222222222222'
function render(phase: 'questions' | 'proposed' | 'approved', legacyQuestions = false) {
  const foundation = {
    id: 'foundation', title: 'The Last Bell', premise: 'A missing bell',
    central_conflict: 'A town conceals the truth', genre: 'Mystery', tone: 'Uneasy',
    player_experience: 'Follow clues', scope: 'One town',
    planning: { choice_frequency: 'occasional', choice_impact: 'lasting',
      branching: { depth: 'shallow', route_exclusivity: 'limited' },
      puzzle_emphasis: 'none', pacing: 'narrative-led',
      first_playthrough: { min_minutes: 60, max_minutes: 90 },
      production: { illustrated_backgrounds: { count: { max: 3 }, firmness: 'hard' } } },
    body: 'Player investigation leads to a choice of loyalties.',
    decisions: [{ id: 'author-brief', statement: 'Keep player choices meaningful',
      origin: 'user', authority: 'user-protected' },
    { id: 'discovery-1', statement: 'Use multiple endings',
      origin: 'agent', authority: 'delegated' }],
  }
  const session = {
    phase, revision: 4, legacyQuestions, skillId: 'a'.repeat(64), startedAt: null,
    chat: { storyId, firstTurnId: turnId, sourceSha: 'b'.repeat(40), directory: 'story' },
    turns: [{ role: 'user', text: 'Make me a mystery game' }],
    questions: phase === 'questions' ? { id: 'd'.repeat(64), revision: 4, questions: [
      { id: 'tone', kind: 'alternatives', question: 'What tone should shape the mystery?',
        options: [{ id: 'uneasy', title: 'Uneasy' }, { id: 'hopeful', title: 'Hopeful' }],
        recommendedId: 'uneasy', recommendationReason: 'Supports the mystery',
        allowStudioDecision: true, delegationAllowed: true },
      { id: 'branching', kind: 'free-text', question: 'How linear should it be?',
        placeholder: 'Somewhat linear is fine', allowStudioDecision: false },
    ] } : null,
    proposal: phase === 'questions' ? null : { foundation, task: 'Make me a mystery game',
      interpretations: [
        { path: 'planning.branching.depth', value: '"shallow"',
          source: { kind: 'turn', index: 0 }, sourceDecisionId: 'author-brief',
          basis: 'inferred', rationale: 'The wording suggests limited branches.' },
        { path: 'planning.first_playthrough', value: '{"min_minutes":60,"max_minutes":90}',
          source: { kind: 'turn', index: 0 }, sourceDecisionId: 'author-brief',
          basis: 'delegated', rationale: 'Studio selected a bounded route duration.' },
      ] },
    digest: phase === 'proposed' ? 'c'.repeat(64) : null,
  } as StoryChatBaselineSession
  return renderToStaticMarkup(createElement(StoryChatBaselineView, {
    session, answer: '', onAnswerChange: () => {}, drafts: {}, onDraftChange: () => {}, busy: false,
    error: null, onAction: () => {},
  }))
}

test('first Thread discovery renders shared structured options, default delegation and bounded free text', () => {
  const markup = render('questions')
  assert.match(markup, /Creative Direction/)
  assert.match(markup, /What tone should shape the mystery/)
  assert.match(markup, /Uneasy/)
  assert.match(markup, /Recommended/)
  assert.match(markup, /Decide for me/)
  assert.match(markup, /checked=""/)
  assert.match(markup, /placeholder="Somewhat linear is fine"/)
  assert.match(markup, /Complete every question or delegate/)
  assert.match(markup, /disabled=""[^>]*>Submit 1 answer and delegate 1 decision/)
  assert.doesNotMatch(markup, /Discovery answers|Send answers|Approve baseline|Initialize Story/)
})

test('exact proposed foundation and author-decision provenance are reviewable before approval', () => {
  const markup = render('proposed')
  assert.match(markup, /The Last Bell/)
  assert.match(markup, /player experience|Player experience/i)
  assert.match(markup, /How your direction was interpreted/)
  assert.match(markup, /Branching depth/)
  assert.match(markup, /Single-route playthrough/)
  assert.match(markup, /Studio interpretation of author wording/)
  assert.match(markup, /Hard production limits/)
  assert.match(markup, /Your direction/)
  assert.match(markup, /Studio choice \(delegated\)/)
  assert.doesNotMatch(markup, /agent ·|user-protected/)
  assert.match(markup, /Keep player choices meaningful/)
  assert.match(markup, /Approve baseline/)
  assert.match(markup, /Request revision/)
  assert.doesNotMatch(markup, /Publish|Initialize Story/)
})

test('old proposed textual interviews cannot expose Creative Direction approval', () => {
  const markup = render('proposed', true)
  assert.match(markup, /unsupported question format/)
  assert.match(markup, /Restart discovery questions/)
  assert.doesNotMatch(markup, /Approve baseline|Request revision|Planning interpretations/)
})

test('approved baseline preserves the exact review while its original Turn continues', () => {
  const markup = render('approved')
  assert.match(markup, /native-validated/)
  assert.match(markup, /No later Story edits or publication were approved/)
  assert.doesNotMatch(markup, /Approve baseline/)
})
