import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthorQuestionControls } from '../src/components/author-question-controls'
import type { AuthorQuestion } from '../../src/author-question'

function render(question: AuthorQuestion, kind = '') {
  return renderToStaticMarkup(createElement(AuthorQuestionControls, {
    question, questionId: 'test-question', disabled: false,
    delegationAllowed: true, selection: kind, selectedIds: [], multiCustom: false,
    customAnswer: '', note: '', onSelect: () => {}, onSelectedIds: () => {},
    onMultiCustom: () => {}, onCustomAnswer: () => {}, onNote: () => {},
  }))
}
const options: AuthorQuestion['options'] = [
  { id: 'linear', title: 'Linear', description: 'Minimal branching.' },
  { id: 'shallow', title: 'Shallow', approach: 'Short alternate scenes.',
    benefits: 'Lower production cost', tradeoffs: 'Less variety' },
  { id: 'deep', title: 'Deep' },
]

test('all delegation controls say Decide for me without changing selected answer', () => {
  for (const question of [
    { kind: 'alternatives' as const, question: 'What structure?', options },
    { kind: 'multiple-choice' as const, question: 'What structure?', options },
    { kind: 'yes-no' as const, question: 'Should the story branch?' },
    { kind: 'free-text' as const, question: 'Describe your preferred structure' },
  ]) {
    const markup = render(question, '__delegate__')
    assert.match(markup, /Decide for me/)
    assert.doesNotMatch(markup, /Let NovelTea Studio decide/)
    assert.match(markup, /checked=""|data-checked=""/)
  }
})

test('recommendations are Lucide stars, not text, independent of extra-information icon', () => {
  for (const kind of ['alternatives', 'multiple-choice'] as const) {
    const markup = render({ kind, question: 'How much branching?', options,
      recommendedId: 'shallow', recommendationReason: 'Balances cost and variety' })
    assert.match(markup, /lucide-star/, 'recommended choice should use Lucide Star')
    assert.match(markup, /aria-label="Recommended"/)
    assert.doesNotMatch(markup, />Recommended<\/span>/)
    assert.match(markup, /lucide-info/, 'options with detail should use Lucide Info')
    assert.match(markup, /aria-label="More information about Linear"/)
    assert.match(markup, /aria-label="More information about Shallow"/)
    assert.doesNotMatch(markup, /aria-label="More information about Deep"/,
      'no info icon when there is no supporting commentary')
    assert.doesNotMatch(markup, /<summary[^>]*>Benefits and trade-offs<\/summary>/,
      'supplementary information should live in a tooltip, not expanding the row')
  }
})

test('only recommendation reason is enough to display a separate information icon', () => {
  const markup = render({ kind: 'alternatives', question: 'How much branching?',
    options: [{ id: 'linear', title: 'Linear' }, { id: 'shallow', title: 'Shallow' }],
    recommendedId: 'shallow', recommendationReason: 'Matches the story scope' })
  assert.match(markup, /aria-label="More information about Shallow"/)
  assert.doesNotMatch(markup, /aria-label="More information about Linear"/)
})
