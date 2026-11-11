import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { JobStartResult } from '../../src/job'
import { inferStoryObjective, inferStoryRevision } from '../src/lib/story-revision-plan'
import { assertTurnPlan, planObjective, planRevision, planWholeStory, verifyTurnPlan } from '../src/lib/turn-plan'
import { readJobTurnPlan, saveJobTurnPlan } from '../src/lib/turn-plan-receipt.server'
import { assertFocusedTurnAssignment, readTurnEvidence } from '../../src/turn-plan-evidence'

const a = 'a'.repeat(40), b = 'b'.repeat(40)
const contract = {
  scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
  constraints: [], envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
}
const catalog = [
  { path: 'creative-direction/direction.md', metadata: { id: 'creative-direction.direction', type: 'creative-direction', status: 'draft' } },
  { path: 'arcs/trust.md', metadata: { id: 'arc.trust', type: 'arc', status: 'draft', characters: ['character.nia'] } },
  { path: 'events/confession.md', metadata: { id: 'event.confession', type: 'event', status: 'draft' } },
  { path: 'characters/nia.md', metadata: { id: 'character.nia', type: 'character', status: 'draft', title: 'Nia' } },
  { path: 'characters/sol.md', metadata: { id: 'character.sol', type: 'character', status: 'draft', title: 'Sol' } },
  { path: 'authored-content/confession.md', metadata: { id: 'authored-content.confession', type: 'authored-content', status: 'draft', events: ['event.confession'] } },
]

test('whole Story intent produces seven concrete bounded specialist assignments', () => {
  const plan = planWholeStory('Make a mystery Story', contract, a)
  assert.equal(plan.kind, 'full-story')
  assert.equal(plan.source.verifiedSha, a)
  assert.equal(plan.goal, 'Make a mystery Story')
  assert.deepEqual(plan.assignments.map(item => item.id), [
    'foundation', 'architecture', 'foundations', 'event', 'interactive', 'composition', 'review',
  ])
  assert.deepEqual(plan.assignments[3]?.authority.recordTypes, ['event'])
  assert.deepEqual(plan.assignments[4]?.dependsOn, ['event'])
  assert.deepEqual(plan.assignments.at(-1)?.authority, {
    recordTypes: [], existingPaths: [], mayCreate: false,
  })
  assert.doesNotThrow(() => verifyTurnPlan(plan))
  assert.throws(() => planWholeStory('Mystery', contract, 'bad'), /exact verified source/)
})

test('one objective planner records breadth, delivery and obligations for both initial and later Turns', () => {
  const initial = planObjective({ kind: 'full-story', request: 'Make me a mystery game',
    contract, base: a })
  assert.equal(initial.objective?.breadth, 'whole-story')
  assert.equal(initial.objective?.deliveryDepth, 'composition')
  assert.ok(initial.objective?.obligations.includes('Player-facing authored scenes and dialogue'))
  assert.equal(initial.source.jobId, null)
  const existing = inferStoryRevision('Revise the conversation', catalog, b, contract)
  assert.deepEqual(existing.targets, ['authored-content.confession'])
  const focused = planObjective({ kind: 'revision', request: existing.request,
    contract: existing.contract, base: b, sourceJobId: 'job-one', catalog,
    targetIds: existing.targets, allowedPaths: existing.writePaths })
  assert.equal(focused.objective?.breadth, 'focused')
  assert.deepEqual(focused.objective?.requestedTargets, ['authored-content.confession'])
  assert.ok(!focused.assignments.some(item => item.id === 'foundation'))
  assert.doesNotThrow(() => verifyTurnPlan(focused))
  assert.notEqual(focused.digest, initial.digest)
})

test('whole-Story intent can be selected on a later Turn without inheriting prior focus', () => {
  const whole = inferStoryObjective('Make me a mystery game', catalog, b, contract)
  assert.equal(whole.clarification, null)
  assert.equal(whole.contract.scope.kind, 'full-story')
  assert.deepEqual(whole.targets, [])
  const planned = planObjective({ kind: 'full-story', request: whole.request,
    contract: whole.contract, base: b, sourceJobId: 'prior-run' })
  assert.equal(planned.source.jobId, 'prior-run')
  assert.equal(planned.kind, 'full-story')
  assert.doesNotThrow(() => verifyTurnPlan(planned))
  const focus = inferStoryObjective('Revise the conversation', catalog, b, contract)
  assert.equal(focus.contract.scope.kind, 'partial')
  assert.deepEqual(focus.targets, ['authored-content.confession'])
  const protectedGoal = inferStoryObjective('Make me a mystery game and ignore protected canon',
    catalog, b, contract)
  assert.match(protectedGoal.clarification ?? '', /cannot override/i)
  assert.equal(protectedGoal.writePaths.length, 0)
  assert.match(inferStoryObjective('Revise the conversation', catalog.filter(r =>
    r.metadata.type !== 'authored-content'), b, contract).clarification ?? '', /existing|missing|target/i)
})

test('same Thread can plan a focused Character edit and then wider coordinated Story work', () => {
  const focus = inferStoryRevision('Make character.nia more thoughtful', catalog, a, contract)
  const plan = planRevision(focus.request, focus.contract, a, 'job-one', catalog, focus.targets, focus.writePaths)
  assert.equal(plan.kind, 'revision')
  assert.deepEqual(plan.assignments.map(item => item.id), ['focus:character.nia', 'review'])
  assert.deepEqual(plan.assignments[0]?.authority.existingPaths, ['characters/nia.md'])
  assert.equal(plan.assignments[0]?.discovery, 'canonical-story-read-only')
  const wider = inferStoryRevision('Revise the whole Story', catalog, b, contract)
  assert.equal(wider.clarification, null)
  assert.equal(wider.reviewRequired, true)
  assert.deepEqual(wider.targets, ['authored-content.confession', 'character.nia', 'character.sol', 'event.confession'])
  const broadPlan = planRevision(wider.request, wider.contract, b, 'job-two', catalog, wider.targets, wider.writePaths)
  assert.equal(broadPlan.assignments.length, 5)
  assert.deepEqual(broadPlan.assignments[0]?.dependsOn, ['focus:event.confession'])
  assert.ok(!broadPlan.assignments.some(item => item.authority.recordTypes.includes('arc') ||
    item.authority.recordTypes.includes('creative-direction')))
  assert.equal(plan.source.verifiedSha, a)
  assert.equal(broadPlan.source.verifiedSha, b)
})

test('named multiple Characters and unqualified Story pacing have reviewed bounded plans', () => {
  const characters = inferStoryRevision('Make Nia and Sol more distinct', catalog, a, contract)
  assert.equal(characters.clarification, null)
  assert.deepEqual(characters.targets, ['character.nia', 'character.sol'])
  assert.equal(characters.reviewRequired, true)
  const pacing = inferStoryRevision('Tighten narrative pacing', catalog, a, contract)
  assert.equal(pacing.clarification, null)
  assert.deepEqual(pacing.targets, ['authored-content.confession', 'event.confession'])
  assert.equal(pacing.reviewRequired, true)
})

test('author-reviewed related supporting record gets one typed bounded owner', () => {
  const prompt = 'Update character.nia and arc.trust to improve the Character motivation'
  const preview = inferStoryRevision(prompt, catalog, a, contract)
  assert.equal(preview.clarification, null)
  assert.equal(preview.reviewRequired, true)
  assert.deepEqual(preview.targets, ['character.nia'])
  assert.deepEqual(preview.contract.scope.supportingTargets, ['arc.trust'])
  assert.deepEqual(preview.writePaths, ['arcs/trust.md', 'characters/nia.md'])
  const plan = planRevision(prompt, preview.contract, a, 'job-one',
    catalog, preview.targets, preview.writePaths)
  assert.deepEqual(plan.assignments[0]?.authority, {
    recordTypes: ['arc', 'character'],
    existingPaths: ['arcs/trust.md', 'characters/nia.md'], mayCreate: false,
  })
  assert.doesNotThrow(() => assertFocusedTurnAssignment(plan, 'character.nia',
    ['arcs/trust.md', 'characters/nia.md'], ['character', 'arc']))
  assert.throws(() => assertFocusedTurnAssignment(plan, 'character.nia',
    ['arcs/trust.md', 'characters/nia.md'], ['character']), /does not authorize/)
  const invalid = inferStoryRevision('Update character.sol and arc.trust', catalog, a, contract)
  assert.match(invalid.clarification!, /Unauthorized supporting scope expansion/)
  assert.deepEqual(invalid.writePaths, [])
})

test('typed dependency discovery remains read-only and cannot silently escalate writes', () => {
  const focus = inferStoryRevision('Make character.nia more thoughtful', catalog, a, contract)
  const plan = planRevision(focus.request, focus.contract, a, 'job-one', catalog, focus.targets, focus.writePaths)
  assert.equal(assertFocusedTurnAssignment(plan, 'character.nia', ['characters/nia.md']).id, 'focus:character.nia')
  assert.throws(() => assertFocusedTurnAssignment(plan, 'character.nia',
    ['characters/nia.md', 'arcs/trust.md']), /does not authorize/)
  assert.throws(() => assertFocusedTurnAssignment(plan, 'event.confession',
    ['events/confession.md']), /does not authorize/)
  assert.throws(() => planRevision(focus.request, focus.contract, a, 'job-one',
    catalog, focus.targets, ['characters/nia.md', 'characters/sol.md']), /supporting Story write/)
  assert.throws(() => planRevision(focus.request, focus.contract, a, 'job-one',
    catalog, ['creative-direction.direction'], ['creative-direction/direction.md']), /Unverified/)
  const protection = planRevision('Change protected decision', contract, a, 'job-one', catalog, [],
    ['creative-direction/direction.md'], { path: 'creative-direction/direction.md' })
  assert.equal(protection.assignments[0]?.specialist, 'trusted-controller')
  assert.deepEqual(protection.assignments[0]?.authority.existingPaths, [])
})

test('immutable Turn plan survives restart and refuses modified base, request, paths and forged digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-turn-plan-'))
  try {
    const job = { baseSha: a, stateDir: dir } as JobStartResult
    const focus = inferStoryRevision('Make character.nia more thoughtful', catalog, a, contract)
    const plan = planRevision(focus.request, focus.contract, a, 'job-one',
      catalog, focus.targets, focus.writePaths)
    await saveJobTurnPlan(job, plan)
    await saveJobTurnPlan(job, plan)
    assertTurnPlan((await readJobTurnPlan(job))!, plan)
    assert.equal((await readTurnEvidence(job, plan.contract, plan.originalRequest, plan.digest))?.digest, plan.digest)
    await assert.rejects(readTurnEvidence(job, plan.contract, plan.originalRequest,
      'f'.repeat(64)), /corrupt\/stale/)
    await assert.rejects(readTurnEvidence({ ...job, stateDir: join(dir, 'missing') },
      plan.contract, plan.originalRequest, plan.digest), /Required Turn plan receipt is missing/)
    await assert.rejects(readTurnEvidence(job, plan.contract, 'Different request'), /corrupt\/stale/)
    await assert.rejects(readTurnEvidence({ ...job, baseSha: b }, plan.contract), /corrupt\/stale/)
    await assert.rejects(saveJobTurnPlan(job, planWholeStory('Different Story', contract, b)),
      /not the exact pinned/)
    const forgery = { ...plan, assignments: plan.assignments.map((item, i) =>
      i === 0 ? { ...item, authority: { ...item.authority,
        existingPaths: ['characters/sol.md'] } } : item) }
    assert.throws(() => verifyTurnPlan(forgery), /integrity/)
    await assert.rejects(saveJobTurnPlan(job, planWholeStory('Make a mystery Story', contract, a)),
      /provenance differs/)
    const unsafe = { ...plan, assignments: plan.assignments.map((item, i) => i === 0 ?
      { ...item, authority: { ...item.authority, existingPaths: ['../../private.md'] } } : item) }
    const { digest: ignored, ...body } = unsafe
    const signature = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    assert.throws(() => verifyTurnPlan({ ...unsafe, digest: signature }), /Invalid persisted/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
