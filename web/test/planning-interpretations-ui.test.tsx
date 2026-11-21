import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { PlanningInterpretationsView } from '../src/components/planning-interpretations'
import type { PlanningInterpretation } from '../../src/planning-interpretation'

const source = { kind: 'answer' as const, setId: 'a'.repeat(64), questionId: 'linearity' }
const entries: PlanningInterpretation[] = [
  { path: 'planning.branching.depth', value: '"shallow"', source, sourceDecisionId: 'author-answer-2',
    basis: 'inferred', rationale: 'Modest branching preserves choice without many distinct routes.' },
  { path: 'planning.branching.route_exclusivity', value: '"limited"', source,
    sourceDecisionId: 'author-answer-2', basis: 'inferred',
    rationale: 'Most content remains shared between routes.' },
  { path: 'planning.puzzle_emphasis', value: '"none"', source,
    sourceDecisionId: 'author-answer-3', basis: 'delegated',
    rationale: 'The author delegated Puzzle direction.' },
]
test('Creative Direction review shows normalized values, provenance and original author wording', () => {
  const html = renderToStaticMarkup(createElement(PlanningInterpretationsView, {
    interpretations: entries,
    decisions: [
      { id: 'author-answer-2',
        statement: 'How linear should the Story be? — Author selected/wrote: somewhat linear, but not too much' },
      { id: 'author-answer-3',
        statement: 'May Studio choose Puzzles? — Author explicitly delegated this question' },
    ],
  }))
  assert.match(html, /How your direction was interpreted/)
  assert.match(html, /Branching depth/)
  assert.match(html, /shallow/)
  assert.match(html, /Route-exclusive content/)
  assert.match(html, /limited/)
  assert.match(html, /Studio interpretation of author wording/)
  assert.match(html, /Studio decision under author delegation/)
  assert.match(html, /somewhat linear, but not too much/)
  assert.match(html, /not quotations from you/)
  assert.doesNotMatch(html, /<pre[ >]/)
})

test('a Story without planning metadata gets no misleading interpretation display', () => {
  assert.equal(renderToStaticMarkup(createElement(PlanningInterpretationsView, {
    interpretations: [], decisions: [],
  })), '')
})
