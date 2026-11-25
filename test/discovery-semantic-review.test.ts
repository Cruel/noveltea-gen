import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  discoverySemanticPacket, parseDiscoverySemanticVerdict, parseDiscoverySemanticDiagnostic,
  discoverySemanticFailures, discoverySemanticDigest, discoverySemanticCorrection,
} from '../src/discovery-semantic-review'
import { resolveDelegatedDecision } from '../src/planning-interpretation'
import type { PlanningEvidence } from '../src/planning-interpretation'
import type { StoryPlanning } from '../src/story-planning'

const id = 'a'.repeat(64)
const ending = { kind: 'answer' as const, setId: id, questionId: 'ending' }
const artwork = { kind: 'answer' as const, setId: id, questionId: 'art-budget' }
const evidence: PlanningEvidence[] = [
  { source: { kind: 'turn', index: 0 }, decisionId: 'author-brief',
    statement: 'Make a mystery that lasts 30–45 minutes.', authorText: '30–45 minutes',
    delegated: false, selectedOption: false },
  { source: ending, decisionId: 'author-ending', statement:
    'How should the game end? — Author explicitly delegated this question',
    authorText: '', delegated: true, selectedOption: false },
  { source: artwork, decisionId: 'author-artwork', statement:
    'How many portraits and illustrations? — Author explicitly delegated this question',
    authorText: '', delegated: true, selectedOption: false },
]
const context = { title: 'A Brief Mystery', premise: 'A stolen exhibit',
  central_conflict: 'Find the hidden record', tone: 'Quiet tension',
  player_experience: 'Inspect and choose', scope: 'One museum', body: 'A compact museum mystery.' }
const planning: StoryPlanning = {
  choice_frequency: 'occasional', choice_impact: 'lasting',
  branching: { depth: 'shallow', route_exclusivity: 'limited' },
  puzzle_emphasis: 'none', pacing: 'narrative-led',
  first_playthrough: { min_minutes: 30, max_minutes: 45 },
  production: { illustrated_backgrounds: { count: { max: 3 }, firmness: 'soft' } },
}

test('exact submitted delegation is deterministic; meaning is independently reviewed', () => {
  assert.equal(resolveDelegatedDecision(ending, evidence, 'A bittersweet ending').decisionId,
    'author-ending')
  assert.equal(resolveDelegatedDecision(ending, evidence, 'Use 20 character portraits').decisionId,
    'author-ending', 'No keyword-based semantic authority test is permitted')
  assert.throws(() => resolveDelegatedDecision({ ...ending, questionId: 'fake' }, evidence,
    'A happy ending'), /not a submitted/)
  assert.throws(() => resolveDelegatedDecision({ kind: 'turn', index: 0 }, evidence,
    'A five-hour story'), /lacks an author delegation/)
  const otherEvidence = evidence.map(e => e.source.kind === 'answer' &&
    e.source.questionId === 'ending' ? { ...e, delegated: false } : e)
  assert.throws(() => resolveDelegatedDecision(ending, otherEvidence, 'A happy ending'),
    /lacks an author delegation/)
})

test('read-only review binds each exact claim, source and submitted author text', () => {
  const decisions = [
    { statement: 'Let the final choice determine who is trusted.', authority: 'delegated',
      source: ending },
    { statement: 'Use 20 character portraits for every lead.', authority: 'delegated',
      source: ending },
    { statement: 'Use only three reusable illustrated backdrops.', authority: 'delegated',
      source: artwork },
  ]
  const interprets = [
    { path: 'planning.first_playthrough', value: JSON.stringify(planning.first_playthrough),
      source: { kind: 'turn' as const, index: 0 }, sourceDecisionId: 'author-brief',
      basis: 'inferred' as const, rationale: 'Exact author-selected minutes.' },
  ]
  const packet = discoverySemanticPacket('A short mystery.', decisions, interprets, evidence, context)
  assert.equal(packet.claims.length, 4)
  assert.equal(packet.authorSources.length, evidence.length)
  assert.equal(packet.creativeDirection.title, context.title)
  assert.equal(packet.claims[1]?.sourceDecisionId, 'author-ending')
  assert.match(packet.claims[1]!.question, /game end/)
  assert.deepEqual(packet.claims.map(c => c.id),
    ['decision:0', 'decision:1', 'decision:2', 'planning:0'])
  const verdict = parseDiscoverySemanticVerdict(JSON.stringify({ assessments:
    packet.claims.map((claim, i) => ({ claimId: claim.id,
      verdict: i === 1 ? 'unsupported' : 'supported',
      reason: i === 1 ? 'An ending delegation does not permit an artwork budget.' :
        'This directly addresses the submitted question.' })) }), packet)
  assert.deepEqual(discoverySemanticFailures(verdict).map(f => f.claimId), ['decision:1'])
  assert.match(discoverySemanticCorrection(verdict), /decision:1/)
  assert.match(discoverySemanticCorrection(verdict), /An ending delegation/)
  assert.match(discoverySemanticCorrection(verdict), /untrusted diagnostic DATA/)
  assert.match(discoverySemanticDigest(packet, verdict).packetDigest, /^[0-9a-f]{64}$/)
  assert.throws(() => parseDiscoverySemanticVerdict('{"assessments":[]}', packet),
    /omitted required assessments/)
  assert.throws(() => parseDiscoverySemanticVerdict(JSON.stringify({ assessments:
    packet.claims.map(c => ({ claimId: 'decision:0', verdict: 'supported', reason: 'fine' })) }), packet),
  /invalid or unauthorized assessment/)
  const incomplete = { assessments: packet.claims.map(c => ({ claimId: c.id,
    verdict: 'supported', reason: 'fine' })) }
  incomplete.assessments[0]!.claimId = 'claim-invented'
  assert.throws(() => parseDiscoverySemanticVerdict(JSON.stringify(incomplete), packet),
    /invalid or unauthorized assessment/)
  const uncertain = parseDiscoverySemanticVerdict(JSON.stringify({ assessments:
    packet.claims.map((c, i) => ({ claimId: c.id, verdict: i === 0 ? 'uncertain' : 'supported',
      reason: 'Independent reviewer cannot establish scope from the supplied question.' })) }), packet)
  assert.equal(discoverySemanticFailures(uncertain)[0]?.verdict, 'uncertain')
})

test('a planning citation has exact provenance but cannot self-certify semantic relevance', () => {
  const packet = discoverySemanticPacket('Make a short mystery', [],
    [{ path: 'planning.production.illustrated_backgrounds', source: ending, sourceDecisionId: 'author-ending',
      basis: 'delegated', value: JSON.stringify(planning.production?.illustrated_backgrounds),
      rationale: 'Soft background limit.' }], evidence, context)
  assert.equal(packet.claims[0]?.sourceDecisionId, 'author-ending')
  assert.match(packet.claims[0]!.statement, /production\.illustrated_backgrounds/)
  const verdict = parseDiscoverySemanticVerdict(JSON.stringify({ assessments: [{
    claimId: 'planning:0', verdict: 'unsupported',
    reason: 'The cited question asks about endings, not illustrated backgrounds.',
  }] }), packet)
  assert.equal(discoverySemanticFailures(verdict).length, 1)
})

test('reviewer replacement diagnosis requires exact material quotes and cannot waive a negative', () => {
  const packet = discoverySemanticPacket('A short mystery.', [
    { statement: 'A bittersweet ending', authority: 'delegated', source: ending },
  ], [], evidence, context)
  const claim = packet.claims[0]!
  const assessment = { claimId: claim.id, verdict: 'supported', reason: 'The exact question delegates the ending.' }
  const dispute = { claimId: claim.id, claimQuote: claim.statement, sourceQuote: claim.question }
  const parse = (disputes: unknown[], assessments = [assessment]) =>
    parseDiscoverySemanticDiagnostic(JSON.stringify({ assessments, disputes, continuation: { action: "stop", reason: "No safe correction." } }), packet)
  assert.deepEqual(parse([dispute]).disputed, [claim.id])
  for (const invalid of [
    { ...dispute, claimId: 'invented' },
    { ...dispute, claimQuote: 'A' },
    { ...dispute, sourceQuote: 'A question about a different source' },
    { ...dispute, sourceQuote: evidence[2]!.statement },
  ]) assert.throws(() => parse([invalid]), /exact source evidence/)
  assert.throws(() => parse([dispute, dispute]), /Invalid Discovery diagnostic (?:dispute|contract)/)
  assert.throws(() => parse([dispute], [{ ...assessment, verdict: 'uncertain' }]), /exact source evidence/)
})

test('independent Review assesses every individually sourced claim beyond the former count cap', () => {
  const packet = discoverySemanticPacket('A mystery.', Array.from({ length: 52 }, (_, index) => ({
    statement: 'Ending detail ' + index, authority: 'delegated', source: ending,
  })), [], evidence, context)
  assert.equal(packet.claims.length, 52)
  const assessments = packet.claims.map(claim => ({
    claimId: claim.id, verdict: 'supported', reason: 'Fits the delegated ending.',
  }))
  assert.equal(parseDiscoverySemanticVerdict(JSON.stringify({ assessments }), packet).assessments.length, 52)
  assert.throws(() => parseDiscoverySemanticVerdict(JSON.stringify({ assessments: assessments.slice(0, -1) }), packet),
    /omitted required assessments/)
})

test('a confirmed negative permits only source-bound diagnostic correction', () => {
  const packet = discoverySemanticPacket('A short mystery.', [
    { statement: 'A hopeful ending and twenty illustrations', authority: 'delegated', source: ending },
  ], [], evidence, context)
  const claim = packet.claims[0]!
  const assessment = { claimId: claim.id, verdict: 'unsupported', reason: 'The ending delegation does not cover illustrations.' }
  const correction = { claimId: claim.id, claimQuote: claim.statement, sourceQuote: claim.question,
    correction: 'Narrow the decision to a hopeful ending.' }
  const parse = (corrections: unknown[], assessments = [assessment]) =>
    parseDiscoverySemanticDiagnostic(JSON.stringify({ assessments, disputes: [],
      continuation: { action: 'continue', corrections } }), packet)
  assert.deepEqual(parse([correction]).continuation, { action: 'continue', corrections: [correction] })
  assert.equal(discoverySemanticFailures(parse([correction]).verdict).length, 1)
  for (const invalid of [
    { ...correction, claimId: 'foreign' },
    { ...correction, claimQuote: 'invented' },
    { ...correction, sourceQuote: evidence[2]!.statement },
    { ...correction, correction: '' },
  ]) assert.throws(() => parse([invalid]), /Discovery diagnostic/)
  assert.throws(() => parse([correction, correction]), /Invalid Discovery diagnostic/)
  assert.throws(() => parse([correction], [{ ...assessment, verdict: 'supported' }]), /exact rejected claim/)
  assert.throws(() => parseDiscoverySemanticDiagnostic(JSON.stringify({ assessments: [assessment], disputes: [] }), packet),
    /Invalid Discovery diagnostic contract/)
})
