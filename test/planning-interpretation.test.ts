import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeExecutable } from '../src/native-cli-version.js'
import { removeTestTree } from './helpers.js'
import { parsePlanningInterpretations, planningDimensions, renderPlanningInterpretations,
  resolveDelegatedDecision, PlanningClarificationRequired,
  type PlanningEvidence } from '../src/planning-interpretation.js'
import { renderFoundation } from '../src/foundation-record.js'
import type { StoryPlanning } from '../src/story-planning.js'

const setId = 'a'.repeat(64)
const sources: PlanningEvidence[] = [
  { source: { kind: 'turn', index: 0 }, decisionId: 'author-brief',
    statement: 'I want a mystery with 90 to 120 minutes per route, at most 5 backgrounds.',
    authorText: 'I want a mystery with 90 to 120 minutes per route, at most 5 backgrounds.',
    selectedOption: false, delegated: false },
  { source: { kind: 'answer', setId, questionId: 'linearity' },
    decisionId: 'author-answer-1', statement: 'How linear? — Author selected/wrote: somewhat linear, but not too much',
    authorText: 'somewhat linear, but not too much', selectedOption: false, delegated: false },
  { source: { kind: 'answer', setId, questionId: 'frequency' },
    decisionId: 'author-answer-2', statement: 'How frequently? — Author selected/wrote: occasional',
    authorText: 'occasional', selectedOption: true, delegated: false },
  { source: { kind: 'answer', setId, questionId: 'studio' },
    decisionId: 'author-answer-3', statement: 'Choose the remaining Story baseline creative details — Author explicitly delegated this question',
    authorText: '', selectedOption: false, delegated: true },
]
const p: StoryPlanning = { choice_frequency: 'occasional', choice_impact: 'lasting',
  branching: { depth: 'shallow', route_exclusivity: 'limited' },
  puzzle_emphasis: 'adventure', pacing: 'balanced',
  first_playthrough: { min_minutes: 90, max_minutes: 120 },
  production: { illustrated_backgrounds: { count: { max: 5 }, firmness: 'hard' } },
}
const at = (questionId: string) => ({ kind: 'answer' as const, setId, questionId })
const interpretation = (path: string, source: PlanningEvidence['source'],
  basis: 'explicit' | 'inferred' | 'delegated' = 'inferred') =>
  ({ path, source, basis, rationale: 'Grounded in the author source and bounded direction.' })
const claims = [
  interpretation('choice_frequency', at('frequency'), 'explicit'),
  interpretation('choice_impact', at('studio'), 'delegated'),
  interpretation('branching.depth', at('linearity')),
  interpretation('branching.route_exclusivity', at('linearity')),
  interpretation('puzzle_emphasis', at('studio'), 'delegated'),
  interpretation('pacing', at('studio'), 'delegated'),
  interpretation('first_playthrough', { kind: 'turn', index: 0 }),
  interpretation('production.illustrated_backgrounds', { kind: 'turn', index: 0 }),
]

test('natural author wording remains original while the controller binds normalized categorical paths', () => {
  const entries = parsePlanningInterpretations(claims, p, sources, true)
  assert.equal(entries.length, planningDimensions(p).length)
  const depth = entries.find(e => e.path === 'branching.depth')!
  assert.equal(depth.value, '"shallow"')
  assert.equal(depth.basis, 'inferred')
  assert.equal(depth.sourceDecisionId, 'author-answer-1')
  assert.equal(entries.find(e => e.path === 'branching.route_exclusivity')?.value, '"limited"')
  assert.equal(entries.find(e => e.path === 'choice_frequency')?.basis, 'explicit')
  assert.equal(entries.find(e => e.path === 'puzzle_emphasis')?.basis, 'delegated')
  const appendix = renderPlanningInterpretations(entries, sources)
  assert.match(appendix, /source: Creative Decision `author-answer-1`/)
  assert.match(appendix, /chosen by NovelTea Studio under author delegation/)
  const record = renderFoundation({
    id: 'foundation', title: 'A Quiet Harbor', premise: 'A missing bell',
    central_conflict: 'Why the bell disappeared', genre: 'Mystery', tone: 'Thoughtful',
    player_experience: 'Discover clues and make choices', scope: 'A coastal town',
    planning: p, body: 'An investigation with consequences.' + appendix,
    decisions: sources.map(e => ({ id: e.decisionId, statement: e.statement,
      origin: 'user' as const, authority: 'user-protected' as const })),
  })
  assert.match(record, /somewhat linear, but not too much/)
  assert.match(record, /inferred by NovelTea Studio from author wording/)
  assert.match(record, /planning: /)
  assert.doesNotMatch(record, /\\"planningSources\\"/)
})

test('Git-only native Creative Direction reader retains approved interpretation evidence without Studio DB', () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-interpreted-creative-direction-'))
  try {
    mkdirSync(join(root, 'creative-direction'))
    const interpretations = parsePlanningInterpretations(claims, p, sources, true)
    const foundation = {
      id: 'foundation', title: 'A Quiet Harbor', premise: 'A missing bell',
      central_conflict: 'Why the bell disappeared', genre: 'Mystery', tone: 'Thoughtful',
      player_experience: 'Discover clues and make choices', scope: 'A coastal town',
      planning: p, body: 'An investigation with consequences.' +
        renderPlanningInterpretations(interpretations, sources),
      decisions: [...sources.map(e => ({ id: e.decisionId, statement: e.statement,
        origin: 'user' as const, authority: 'user-protected' as const })),
        { id: 'studio-choice', statement: 'A recurring motif chosen by Studio.',
          origin: 'agent' as const, authority: 'delegated' as const }],
    }
    const approved = renderFoundation(foundation, 'approved')
    const draft = renderFoundation(foundation, 'draft')
    assert.match(draft, /status: draft/)
    assert.doesNotMatch(draft, /status: approved/)
    assert.match(approved, /status: approved/)
    writeFileSync(join(root, 'creative-direction', 'foundation.md'), approved)
    const gitOnly = readFileSync(join(root, 'creative-direction', 'foundation.md'), 'utf8')
    assert.match(gitOnly, /somewhat linear, but not too much/)
    assert.match(gitOnly, /chosen by NovelTea Studio under author delegation/)
    assert.match(gitOnly, /source: Creative Decision `author-answer-1`/)
    assert.match(gitOnly, /origin: agent[\s\S]*?authority: delegated/)
    const native = spawnSync(nativeExecutable(), ['--json', 'narrative', 'validate', root],
      { encoding: 'utf8', timeout: 30_000 })
    assert.equal(native.status, 0, native.stderr || native.stdout)
    const report = JSON.parse(native.stdout)
    assert.equal(report.success, true)
    assert.equal(report.catalog.records.length, 1)
    assert.deepEqual(report.catalog.records[0].metadata.planning, p)
    assert.equal(report.catalog.records[0].metadata.status, 'approved')
  } finally { removeTestTree(root) }
})

test('forged or incomplete source references and fabricated consent fail closed', () => {
  for (const tampered of [
    claims.slice(1),
    [...claims.slice(0, -1), claims[0]],
    claims.map(c => c.path === 'branching.depth' ? { ...c, source: at('fake') } : c),
    claims.map(c => c.path === 'branching.depth' ? { ...c, basis: 'explicit' } : c),
    claims.map(c => c.path === 'puzzle_emphasis' ? { ...c, basis: 'inferred' } : c),
    claims.map(c => c.path === 'choice_frequency' ? { ...c, source: at('studio') } : c),
    claims.map(c => c.path === 'branching.depth' ? { ...c, basis: 'explicit' } : c),
    claims.map(c => c.path === 'first_playthrough' ? { ...c,
      source: at('linearity') } : c),
    claims.map(c => c.path === 'pacing' ? { ...c, source: at('linearity'), basis: 'inferred' } : c),
  ]) assert.throws(() => parsePlanningInterpretations(tampered, p, sources, true))
  assert.throws(() => parsePlanningInterpretations([...claims, { ...claims[0], extra: 'forged' }],
    p, sources, true))
})

test('negated category words in an option cannot masquerade as an explicit author selection', () => {
  const negative = sources.map(source => source.decisionId === 'author-answer-1'
    ? { ...source, selectedOption: true,
      authorText: 'No deep branching — just a short detour.',
      statement: 'Branching preference — Author selected/wrote: No deep branching — just a short detour.' }
    : source)
  const deepPlan: StoryPlanning = { ...p, branching: { ...p.branching!, depth: 'deep' } }
  assert.throws(() => parsePlanningInterpretations(
    claims.map(claim => claim.path === 'branching.depth' ? { ...claim, basis: 'explicit' } : claim),
    deepPlan, negative, true), PlanningClarificationRequired)
  const falselyAffirmed = negative.map(source => source.decisionId === 'author-answer-1'
    ? { ...source, authorText: 'Deep branching? Absolutely not.' } : source)
  assert.throws(() => parsePlanningInterpretations(
    claims.map(claim => claim.path === 'branching.depth' ? { ...claim, basis: 'explicit' } : claim),
    deepPlan, falselyAffirmed, true), /impersonate an explicit author choice/)
  assert.equal(parsePlanningInterpretations(claims, p, negative, true).find(entry =>
    entry.path === 'branching.depth')?.basis, 'inferred')
})

test('negation in one answer must not suppress an affirmative choice from another answer', () => {
  const conflicting: PlanningEvidence[] = [...sources,
    { source: at('no-deep'), decisionId: 'author-answer-4', delegated: false,
      statement: 'Branching preference — Author selected/wrote: No deep branching',
      authorText: 'No deep branching', selectedOption: true },
    { source: at('yes-deep'), decisionId: 'author-answer-5', delegated: false,
      statement: 'Branching preference — Author selected/wrote: Deep branching',
      authorText: 'Deep branching', selectedOption: true }]
  assert.throws(() => parsePlanningInterpretations(claims, p, conflicting, true),
    PlanningClarificationRequired,
    'contradictory answers must require author clarification, not select shallow');
})

test('an exact hyphenated categorical label remains an explicit author choice', () => {
  const pacedSources: PlanningEvidence[] = [...sources, {
    source: at('pacing'), decisionId: 'author-answer-4',
    statement: 'Preferred pacing? — Author selected/wrote: narrative-led',
    authorText: 'narrative-led', selectedOption: true, delegated: false,
  }]
  const result = parsePlanningInterpretations(claims.map(item => item.path === 'pacing'
    ? { ...item, source: at('pacing'), basis: 'explicit' } : item),
  { ...p, pacing: 'narrative-led' }, pacedSources, true)
  assert.equal(result.find(item => item.path === 'pacing')?.basis, 'explicit')
})

test('materially conflicting explicit author preferences demand a new question', () => {
  const base = { ...p, branching: { depth: 'deep' as const, route_exclusivity: 'substantial' as const } }
  assert.throws(() => parsePlanningInterpretations(claims, base, sources, true),
    PlanningClarificationRequired)
  const contradictions: PlanningEvidence[] = [...sources, { source: at('contradiction'),
    decisionId: 'author-answer-4', delegated: false,
    statement: 'The story must include custom puzzles. No puzzles anywhere.',
    authorText: 'The story must include custom puzzles. No puzzles anywhere.', selectedOption: false }]
  assert.throws(() => parsePlanningInterpretations(claims, p, contradictions, true),
    PlanningClarificationRequired)
  const hardFromVague = [{ ...sources[0]!, statement: 'Keep the artwork budget small.',
    authorText: 'Keep the artwork budget small.' }, ...sources.slice(1)]
  assert.throws(() => parsePlanningInterpretations(claims, p, hardFromVague, true),
    /Numeric|hard|does not concern/)
})

test('explicit clarification supersedes earlier contradictory answers without rewriting their evidence', () => {
  const conflicting: PlanningEvidence[] = [...sources,
    { source: at('puzzles-old'), decisionId: 'author-answer-4',
      statement: 'What puzzles? — Author selected/wrote: No puzzles anywhere.',
      authorText: 'No puzzles anywhere.', selectedOption: false, delegated: false },
    { source: at('puzzles-new'), decisionId: 'author-answer-5',
      statement: 'Clarify conflicting Puzzle direction — Author selected/wrote: Must include custom puzzles.',
      authorText: 'Must include custom puzzles.', selectedOption: true, delegated: false }]
  const changed: StoryPlanning = { ...p, puzzle_emphasis: 'custom' }
  const updated = claims.map(c => c.path === 'puzzle_emphasis'
    ? { ...c, source: at('puzzles-new'), basis: 'inferred' as const } : c)
  const parsed = parsePlanningInterpretations(updated, changed, conflicting, true)
  assert.equal(parsed.find(c => c.path === 'puzzle_emphasis')?.sourceDecisionId, 'author-answer-5')
  assert.throws(() => parsePlanningInterpretations(claims, changed, conflicting, true),
    /later author clarification/)
  const conflictWithoutClarification = conflicting.map(e => e.decisionId === 'author-answer-5'
    ? { ...e, statement: 'Should Puzzles be included? — Author selected/wrote: Must include custom puzzles.' }
    : e)
  assert.throws(() => parsePlanningInterpretations(updated, changed, conflictWithoutClarification, true),
    PlanningClarificationRequired)
})

test('a Studio-origin creative decision must cite its exact delegated topic', () => {
  assert.equal(resolveDelegatedDecision(at('studio'), sources, 'A recurring motif').decisionId,
    'author-answer-3', 'a broad Story baseline delegation permits creative details')
  const specific: PlanningEvidence[] = [
    { source: at('ending'), decisionId: 'author-answer-1', delegated: true,
      authorText: '', selectedOption: false,
      statement: 'Should Studio choose the ending? — Author explicitly delegated this question' },
  ]
  assert.equal(resolveDelegatedDecision(at('ending'), specific, 'A bittersweet ending').decisionId,
    'author-answer-1')
  assert.throws(() => resolveDelegatedDecision(at('ending'), specific,
    'A costly Character artwork budget'), /different creative topic/)
  assert.throws(() => resolveDelegatedDecision(at('linearity'), sources,
    'An alternate branching ending'), /lacks an author delegation/)
  assert.throws(() => resolveDelegatedDecision({ kind: 'turn', index: 12 }, sources,
    'A new ending'), /not a submitted/)
})

test('specific delegated decisions match their topic without copying literal prompt words', () => {
  const cases = [
    ['story-tone', 'How should the mystery feel?', 'Use grounded tension rather than supernatural threats.'],
    ['choice-frequency', 'How often should players make meaningful decisions?',
      'Place meaningful choices at investigative turning points rather than throughout routine clue collection.'],
    ['choice-impact', 'How much weight should decisions carry?',
      'Let interview choices affect cooperation and final disclosure change the aftermath.'],
    ['branch-depth', 'How far should playthroughs diverge?',
      'Use short detours that return to the shared investigation.'],
    ['route-exclusivity', 'How much content should be exclusive to particular routes?',
      'Limit exclusive material to brief exchanges and aftermath beats.'],
    ['puzzle-emphasis', 'What kind of interactive challenges?',
      'Build puzzles around inspecting and presenting evidence.'],
    ['pacing', 'Where should players spend most of their time?',
      'Balance substantial interviews with hands-on investigation.'],
    ['illustrated-backgrounds', 'How many different art concepts?',
      'Target three illustrated backgrounds.'],
    ['background-variants', 'How many visual variants?',
      'Allow one illustrated background variant.'],
    ['character-artwork', 'How many character portraits?',
      'Use three Main, two Supporting, and zero Extra character portraits.'],
  ] as const
  for (const [id, question, statement] of cases) {
    const evidence: PlanningEvidence[] = [{
      source: at(id), decisionId: 'author-answer-' + id, statement:
        question + ' — Author explicitly delegated this question',
      authorText: '', selectedOption: false, delegated: true,
    }]
    assert.equal(resolveDelegatedDecision(at(id), evidence, statement).decisionId,
      'author-answer-' + id, 'The submitted delegation must authorize ' + id)
    assert.throws(() => resolveDelegatedDecision(at(id), evidence,
      'Require four distinct endings.'), /different creative topic/,
    id + ' must not authorize unrelated endings')
  }
})

test('a delegated planning dimension can cite the exact answered topic ID despite natural wording', () => {
  const evidence: PlanningEvidence[] = [...sources,
    { source: at('branch-depth'), decisionId: 'author-answer-branch-depth',
      statement: 'How far should playthroughs diverge? — Author explicitly delegated this question',
      authorText: '', selectedOption: false, delegated: true },
    { source: at('pacing'), decisionId: 'author-answer-pacing',
      statement: 'Where should players spend most of their time? — Author explicitly delegated this question',
      authorText: '', selectedOption: false, delegated: true },
  ]
  const adapted = claims.map(c => c.path === 'branching.depth'
    ? { ...c, source: at('branch-depth'), basis: 'delegated' as const }
    : c.path === 'pacing' ? { ...c, source: at('pacing'), basis: 'delegated' as const } : c)
  const accepted = parsePlanningInterpretations(adapted, p, evidence, true)
  assert.equal(accepted.find(item => item.path === 'branching.depth')?.sourceDecisionId,
    'author-answer-branch-depth')
  assert.equal(accepted.find(item => item.path === 'pacing')?.sourceDecisionId,
    'author-answer-pacing')
  const mismatched = adapted.map(c => c.path === 'pacing'
    ? { ...c, source: at('branch-depth') } : c)
  assert.throws(() => parsePlanningInterpretations(mismatched, p, evidence, true),
    /does not concern this dimension/, 'An unrelated delegated question cannot authorize pacing')
})

test('inferred estimates may not invent hard production caps', () => {
  const vagueHard = [{ ...sources[0]!,
    statement: 'I think 5 backgrounds would be nice, and aim for 90 to 120 minutes.',
    authorText: 'I think 5 backgrounds would be nice, and aim for 90 to 120 minutes.' }, ...sources.slice(1)]
  assert.throws(() => parsePlanningInterpretations(claims, p, vagueHard, true),
    /hard author production limit/)
  const soft = { ...p, production: { illustrated_backgrounds:
    { count: { max: 5 }, firmness: 'soft' as const } } }
  assert.equal(parsePlanningInterpretations(claims, soft, vagueHard, true).length, 8)
  const badHardCount: StoryPlanning = { ...p, production: { illustrated_backgrounds:
    { count: { max: 6 }, firmness: 'hard' } } }
  assert.throws(() => parsePlanningInterpretations(claims, badHardCount, sources, true),
    PlanningClarificationRequired)
  const wrongDuration: StoryPlanning = { ...p,
    first_playthrough: { min_minutes: 60, max_minutes: 120 } }
  assert.throws(() => parsePlanningInterpretations(claims, wrongDuration, sources, true),
    PlanningClarificationRequired)
})
