import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { AuthorChoicePanel } from '../src/components/author-choice-panel'
import type { SpecialistChoice } from '../src/lib/author-state'

function render(question: SpecialistChoice['question'], selected = '',
  answer?: SpecialistChoice['answer'], contextHref?: (path: string) => string) {
  return renderToStaticMarkup(createElement(AuthorChoicePanel, {
    choice: { id: 'answer-123', workItem: 'event-disclosure',
      phase: answer ? 'answered' : 'awaiting-author',
      proposalSha256: 'a'.repeat(64), question, ...(answer ? { answer } : {}) },
    presentation: 'chat', busy: false, selection: selected, customAnswer: '', note: '',
    contextHref, onSelect: () => {}, onCustomAnswer: () => {}, onNote: () => {}, onSubmit: () => {},
  }))
}
test('free-text questions render an accessible required input without forcing radio options', () => {
  const html = render({ kind: 'free-text', question: 'What should the witness confess?' })
  assert.match(html, /aria-label="Specialist creative choice"/)
  assert.match(html, /What should the witness confess/)
  assert.match(html, /for="choice-free-text-answer-123"/)
  assert.match(html, /required/)
  assert.doesNotMatch(html, /Author response options/)
  assert.match(html, /Additional instructions \(optional\)/)
})

test('Yes No Other questions offer both binary answers, accessible Other and required custom text', () => {
  const html = render({ kind: 'yes-no', question: 'Should the witness reveal the truth now?' })
  assert.match(html, /Choose Yes, No, or Other/)
  assert.match(html, /Author response options/)
  assert.match(html, /aria-label="Yes"/)
  assert.match(html, /aria-label="No"/)
  assert.match(html, /My own direction/)
  assert.match(html, /Additional instructions \(optional\)/)
  const other = render({ kind: 'yes-no', question: 'Should the witness reveal the truth now?' }, '__custom__')
  assert.match(other, /Your own direction \(required\)/)
  assert.match(other, /required/)
})

test('refresh shows the exact saved answer and optional note without resubmission', () => {
  const html = render({ kind: 'yes-no', question: 'Should the witness reveal the truth now?' }, '',
    { kind: 'option', optionId: 'no', note: 'Wait for the second clue.' })
  assert.match(html, /Your answer is saved/)
  assert.match(html, /Saved response/)
  assert.match(html, /No/)
  assert.match(html, /Wait for the second clue/)
  assert.doesNotMatch(html, /Submit answer/)
})

test('alternatives display recommendations and relevant context, retaining Other', () => {
  const html = render({ kind: 'alternatives',
    question: 'Which consequence suits the scene?',
    options: [
      { id: 'trust', title: 'Restore trust', approach: 'Nia forgives the archivist.',
        benefits: 'Strong closure', tradeoffs: 'Less dramatic tension' },
      { id: 'conflict', title: 'Escalate conflict', approach: 'Nia refuses to forgive.',
        benefits: 'More stakes', tradeoffs: 'Longer resolution' },
    ],
    recommendedId: 'trust', recommendationReason: 'Preserves established canon',
    context: [{ path: 'characters/nia.md', line: 3, description: 'Original motivation' }],
  })
  assert.match(html, /Restore trust/)
  assert.match(html, /Escalate conflict/)
  assert.match(html, /Recommended/)
  assert.match(html, /Preserves established canon/)
  assert.match(html, /Relevant Story context/)
  assert.match(html, /characters\/nia.md:3/)
  assert.match(html, /My own direction/)
  const linked = render({ kind: 'alternatives', question: 'Which consequence suits the scene?',
    options: [{ id: 'trust', title: 'Trust' }, { id: 'conflict', title: 'Conflict' }],
    context: [{ path: 'characters/nia.md', line: 3, description: 'Original motivation' }],
  }, '', undefined, path => '/stories/example/?context=' + encodeURIComponent(path))
  assert.match(linked, /href="\/stories\/example\/\?context=characters%2Fnia.md"/)
  const answered = render({ kind: 'alternatives', question: 'Which consequence suits the scene?',
    options: [{ id: 'trust', title: 'Trust' }, { id: 'conflict', title: 'Conflict' }],
    context: [{ path: 'characters/nia.md', line: 3, description: 'Original motivation' }],
  }, '', { kind: 'option', optionId: 'trust', note: '' },
  path => '/stories/example/?context=' + encodeURIComponent(path))
  assert.match(answered, /Relevant Story context/)
  assert.match(answered, /href="\/stories\/example\/\?context=characters%2Fnia.md"/)
})

test('recommendation is never preselected; concise options remain usable without essays', () => {
  const question = { kind: 'alternatives' as const,
    question: 'What should Nia do when the ledger is found?',
    options: [{ id: 'keep', title: 'Keep it' }, { id: 'share', title: 'Share it' }],
    recommendedId: 'share', recommendationReason: 'Provides a clear next clue',
  }
  const pending = render(question)
  assert.match(pending, /Recommended/)
  assert.doesNotMatch(pending, /data-checked=""/)
  assert.match(pending, /disabled=""/)
  assert.doesNotMatch(pending, /Benefits:<\/strong>\s*<\/p>/)
  const explicit = render(question, 'keep')
  assert.match(explicit, /data-checked=""/)
  assert.doesNotMatch(explicit, /Submit answer<\/button>.*disabled/)
})

test('free-text placeholders are hints rather than submitted answers', () => {
  const html = render({ kind: 'free-text', question: 'How should Nia explain the missing page?',
    placeholder: 'For example, a quiet confession' })
  assert.match(html, /placeholder="For example, a quiet confession"/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /value="For example, a quiet confession"/)
})
