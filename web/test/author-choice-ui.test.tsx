import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AuthorChoicePanel } from '../src/components/author-choice-panel'
import type { SpecialistChoice } from '../src/lib/author-state'

function render(question: SpecialistChoice['question'],
  answer?: SpecialistChoice['answer'],
  contextHref?: (path: string) => string) {
  return renderToStaticMarkup(createElement(AuthorChoicePanel, {
    choice: { id: 'answer-123', workItem: 'event-disclosure',
      phase: answer ? 'answered' : 'awaiting-author',
      proposalSha256: 'a'.repeat(64), question, ...(answer ? { answer } : {}) },
    contextHref,
  }))
}

test('saved specialist answers use the common read-only summary, never a second editor', () => {
  const html = render({ kind: 'yes-no', question: 'Should the witness reveal the truth now?' },
    { kind: 'option', optionId: 'no', note: 'Wait for the second clue.' })
  assert.match(html, /aria-label="Specialist creative choice"/)
  assert.match(html, /Your answer is saved/)
  assert.match(html, /Saved response:.*No/)
  assert.match(html, /Wait for the second clue/)
  assert.match(html, /does not authorize changes to protected Creative Decisions/)
  assert.doesNotMatch(html, /<textarea|<input|Submit answer/)
  assert.equal(render({ kind: 'free-text', question: 'What should the witness confess?' }), '',
    'pending questions must be rendered exclusively by the shared Question Set editor')
})

test('the same answer summary preserves Studio delegation and exact multiple-choice custom words', () => {
  const q = { kind: 'multiple-choice' as const,
    question: 'Which compatible clues matter?',
    options: [{ id: 'history', title: 'Archive history' },
      { id: 'witness', title: 'Witness testimony' }] }
  const delegated = render(q, { kind: 'delegate', note: 'Preserve canon' })
  assert.match(delegated, /Delegated to NovelTea Studio/)
  assert.match(delegated, /Preserve canon/)
  const explicit = render(q, { kind: 'multiple', optionIds: ['history', 'witness'],
    text: '  Keep my original wording.  ', note: 'Avoid retcons' })
  assert.match(explicit, /Archive history; Witness testimony;   Keep my original wording/)
  assert.match(explicit, /Avoid retcons/)
})

test('answered specialist questions retain canonical context links', () => {
  const html = render({ kind: 'alternatives', question: 'Which consequence suits the scene?',
    options: [{ id: 'trust', title: 'Trust' }, { id: 'conflict', title: 'Conflict' }],
    context: [{ path: 'characters/nia.md', line: 3, description: 'Original motivation' }],
  }, { kind: 'option', optionId: 'trust', note: '' },
  path => '/stories/example/?context=' + encodeURIComponent(path))
  assert.match(html, /Relevant Story context/)
  assert.match(html, /href="\/stories\/example\/\?context=characters%2Fnia.md"/)
  assert.match(html, /Saved response:.*Trust/)
})

test('onboarding form styles do not override shared radio labels', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /\.story-onboarding label\s*\{/)
  assert.match(css, /\.story-onboarding \.story-onboarding-field\s*\{/)
})

test('old paragraph styles do not override shadcn tooltip text colors', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /(?:^|[;}]\s*)p\s*,\s*\.muted\s*\{/)
  assert.match(css, /\.page\s*>\s*p\s*,\s*\.muted\s*\{/)
})
