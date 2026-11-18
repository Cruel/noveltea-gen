import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { AuthorQuestionSetView } from '../src/components/author-question-set'
import { AuthorQuestionControls } from '../src/components/author-question-controls'
import { initialQuestionDraft, type QuestionDraft, type QuestionSet } from '../../src/author-question-set'

const questions: QuestionSet = { id: 'a'.repeat(64), revision: 3, questions: [
  { id: 'tone', question: 'Which tone should the new mystery have?',
    options: [{ id: 'eerie', title: 'Eerie' }, { id: 'warm', title: 'Warm' }],
    recommendedId: 'eerie', delegationAllowed: true },
  { id: 'branching', kind: 'free-text',
    question: 'How much branching should players experience?' },
  { id: 'clues', kind: 'multiple-choice', question: 'Which types of clue fit the story?',
    options: [{ id: 'letters', title: 'Letters' }, { id: 'artifacts', title: 'Artifacts' }] },
] }
function render(drafts: Record<string, QuestionDraft>) {
  return renderToStaticMarkup(createElement(AuthorQuestionSetView, {
    set: questions, drafts, disabled: false, onDraftChange: () => {}, onSubmit: () => {},
  }))
}

test('Question Set shows a provisional delegation and truthful mixed-batch submission summary', () => {
  const tone = initialQuestionDraft(questions.questions[0]!)
  const branching = { ...initialQuestionDraft(questions.questions[1]!),
    customAnswer: 'Shallow branches with occasional meaningful choices.' }
  const clues = { ...initialQuestionDraft(questions.questions[2]!),
    selectedIds: ['letters'], multiCustom: true, customAnswer: 'Witness testimony' }
  const html = render({ tone, branching, clues })
  assert.match(html, /Decide for me/)
  assert.match(html, /Recommended/)
  assert.match(html, /Submit 2 answers and delegate 1 decision/)
  assert.doesNotMatch(html, /disabled=""[^>]*>Submit 2 answers/)
  assert.doesNotMatch(html, /Choose a valid response or complete the custom answer/)
})

test('delegating multi-select conceals previous selections without discarding draft input', () => {
  const html = renderToStaticMarkup(createElement(AuthorQuestionControls, {
    question: { kind: 'multiple-choice', question: 'Which clues are most important?',
      options: [{ id: 'letter', title: 'Letter' }, { id: 'map', title: 'Map' }] },
    questionId: 'multi', disabled: false, delegationAllowed: true,
    selection: '__delegate__', selectedIds: ['letter'], multiCustom: true,
    customAnswer: 'Keep the earlier witness quote.', note: 'Do not rewrite prior chapters.',
    onSelect: () => {}, onSelectedIds: () => {}, onMultiCustom: () => {},
    onCustomAnswer: () => {}, onNote: () => {},
  }))
  assert.match(html, /Decide for me/)
  assert.doesNotMatch(html, /Your own direction \(required\)/)
  assert.doesNotMatch(html, /Keep the earlier witness quote/)
  assert.equal((html.match(/checked=""/g) ?? []).length, 1,
    'only delegation appears selected; previous choices stay in the controlled draft')
})

test('incomplete custom answers stay in the controlled Question Set and block all submission', () => {
  const tone = initialQuestionDraft(questions.questions[0]!)
  const branching = { ...initialQuestionDraft(questions.questions[1]!),
    customAnswer: '  ' }
  const clues = { ...initialQuestionDraft(questions.questions[2]!),
    selectedIds: ['artifacts'], multiCustom: true, customAnswer: '' }
  const html = render({ tone, branching, clues })
  assert.match(html, /Complete every question or delegate where permitted/)
  assert.match(html, /Choose a valid response or complete the custom answer/)
  assert.match(html, /disabled=""[^>]*>Submit 1 answer and delegate 1 decision|disabled=""[^>]*>Submit /)
})
