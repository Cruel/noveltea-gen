import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AuthorChoicePanel } from '../src/components/author-choice-panel'
import type { SpecialistChoice } from '../src/lib/author-state'

function render(question: SpecialistChoice['question'], selected = '',
  answer?: SpecialistChoice['answer'], contextHref?: (path: string) => string,
  extra?: { delegationAllowed?: boolean; selectedIds?: string[];
    multiCustom?: boolean; customAnswer?: string }) {
  return renderToStaticMarkup(createElement(AuthorChoicePanel, {
    choice: { id: 'answer-123', workItem: 'event-disclosure',
      phase: answer ? 'answered' : 'awaiting-author',
      proposalSha256: 'a'.repeat(64), question, ...(answer ? { answer } : {}),
      delegationAllowed: extra?.delegationAllowed ?? false },
    presentation: 'chat', busy: false, selection: selected,
    selectedIds: extra?.selectedIds, multiCustom: extra?.multiCustom,
    customAnswer: extra?.customAnswer ?? '', note: '',
    contextHref, onSelect: () => {}, onSelectedIds: () => {}, onMultiCustom: () => {},
    onCustomAnswer: () => {}, onNote: () => {}, onSubmit: () => {},
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
  assert.match(html, /aria-label="More information about Restore trust"/)
  assert.match(html, /aria-label="More information about Escalate conflict"/)
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
  assert.match(pending, /aria-label="Recommended"/)
  assert.match(pending, /lucide-star/)
  assert.doesNotMatch(pending, /data-checked=""/)
  assert.match(pending, /disabled=""/)
  assert.doesNotMatch(pending, /Benefits:<\/strong>\s*<\/p>/)
  const explicit = render(question, 'keep')
  assert.match(explicit, /data-checked=""/)
  assert.doesNotMatch(explicit, /Submit answer<\/button>.*disabled/)
})

test('trusted delegation is provisionally selected, never an accepted response', () => {
  const question = { kind: 'alternatives' as const,
    question: 'How should the witness respond?',
    options: [{ id: 'trust', title: 'Build trust' }, { id: 'conflict', title: 'Challenge' }],
    recommendedId: 'trust', allowStudioDecision: true,
  }
  const allowed = render(question, '__delegate__', undefined, undefined,
    { delegationAllowed: true })
  assert.match(allowed, /Decide for me/)
  assert.match(allowed, /checked=""/)
  assert.match(allowed, /aria-label="Recommended"/)
  assert.match(allowed, /data-unchecked=""[^>]*aria-label="Build trust"/,
    'The recommended approach is not the selected radio option')
  assert.doesNotMatch(allowed, /Your answer is saved/)
  assert.doesNotMatch(allowed, /disabled=""[^>]*>Submit answer/)
  const forbidden = render(question, '', undefined, undefined, { delegationAllowed: false })
  assert.doesNotMatch(forbidden, /Decide for me/)
  assert.match(forbidden, /disabled=""/)
  const saved = render(question, '', { kind: 'delegate', note: 'Preserve canon' })
  assert.match(saved, /Delegated to NovelTea Studio/)
  assert.match(saved, /Preserve canon/)
})

test('free-text and Yes/No delegation remain distinct from explicit answers', () => {
  const text = render({ kind: 'free-text', question: 'What should the witness confess?',
    allowStudioDecision: true }, '__delegate__', undefined, undefined, { delegationAllowed: true })
  assert.match(text, /Decide for me/)
  assert.doesNotMatch(text, /for="choice-free-text-answer-123"/)
  assert.doesNotMatch(text, /disabled=""[^>]*>Submit answer/)
  const explicit = render({ kind: 'free-text', question: 'What should the witness confess?',
    allowStudioDecision: true }, '__answer__', undefined, undefined, { delegationAllowed: true })
  assert.match(explicit, /Your answer/)
  assert.match(explicit, /disabled=""/)
  const binary = render({ kind: 'yes-no', question: 'Should the witness reveal the truth?',
    allowStudioDecision: true }, '__delegate__', undefined, undefined, { delegationAllowed: true })
  assert.match(binary, /Decide for me/)
  assert.match(binary, /aria-label="Yes"/)
  assert.match(binary, /aria-label="No"/)
})

test('question options are compact rows in a responsive grid with collapsed optional detail', () => {
  const html = render({ kind: 'alternatives', question: 'What tone should shape the story?',
    options: [
      { id: 'eerie', title: 'Eerie and unsettling',
        description: 'A slow-burn mystery', benefits: 'Intrigue', tradeoffs: 'Less levity' },
      { id: 'hopeful', title: 'Hopeful', approach: 'Warm discoveries' },
    ],
    recommendedId: 'eerie', recommendationReason: 'Fits the slow reveal',
  }, '__delegate__', undefined, undefined, { delegationAllowed: true })
  assert.match(html, /grid-cols-1 gap-1 sm:grid-cols-2/, 'choices fit side by side on desktop')
  assert.match(html, /data-compact-choice=""/)
  assert.match(html, /cursor-pointer items-center gap-2/)
  assert.match(html, /Recommended/)
  assert.match(html, /aria-label="More information about Eerie and unsettling"/)
  assert.match(html, /lucide-info/)
  assert.doesNotMatch(html, /<summary[^>]*>Benefits and trade-offs/)
  assert.match(html, /Additional instructions \(optional\)/)
  assert.match(html, /<details[^>]*><summary[^>]*>Additional instructions \(optional\)<\/summary>/,
    'the note editor is hidden until explicitly expanded')
  assert.doesNotMatch(html, /<details open=""[^>]*><summary[^>]*>Additional instructions/,
    'blank notes do not keep a textarea visible')
})

test('onboarding form styles do not override nested inline radio labels', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /\.story-onboarding label\s*\{/,
    'blanket grid/margin styling caused the screenshot’s radio and label to stack')
  assert.match(css, /\.story-onboarding \.story-onboarding-field\s*\{/)
})

test('multi-selection supports independent checkboxes plus optional original custom input', () => {
  const q = { kind: 'multiple-choice' as const,
    question: 'Which compatible clues matter?',
    options: [{ id: 'history', title: 'Archive history' }, { id: 'witness', title: 'Witness testimony' }],
    recommendedId: 'history', allowStudioDecision: true }
  const delegated = render(q, '__delegate__', undefined, undefined, { delegationAllowed: true })
  assert.match(delegated, /Decide for me/)
  assert.match(delegated, /type="checkbox"/)
  assert.doesNotMatch(delegated, /disabled=""[^>]*>Submit answer/)
  const combined = render(q, '', undefined, undefined, { delegationAllowed: true,
    selectedIds: ['witness', 'history'], multiCustom: true,
    customAnswer: '  A third optional perspective.  ' })
  assert.match(combined, /Archive history/)
  assert.match(combined, /Witness testimony/)
  assert.match(combined, /Your own direction \(required\)/)
  assert.match(combined, /A third optional perspective/)
  assert.match(combined, /checked=""/)
  const incomplete = render(q, '', undefined, undefined, { delegationAllowed: true,
    selectedIds: ['history'], multiCustom: true })
  assert.match(incomplete, /disabled=""/)
  const saved = render(q, '', { kind: 'multiple', optionIds: ['history', 'witness'],
    text: '  Keep the original wording.  ', note: 'Avoid retcons' })
  assert.match(saved, /Archive history; Witness testimony;   Keep the original wording/)
})

test('free-text placeholders are hints rather than submitted answers', () => {
  const html = render({ kind: 'free-text', question: 'How should Nia explain the missing page?',
    placeholder: 'For example, a quiet confession' })
  assert.match(html, /placeholder="For example, a quiet confession"/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /value="For example, a quiet confession"/)
})
