import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inferStoryObjective, inferStoryRevision, applyCreativeModeToRevision } from '../src/lib/story-revision-plan'
import { creativePolicy } from '../../src/creative-policy'
import { resolveFocusedScope, type CanonicalScopeRecord } from '../../src/focused-scope'
import { reconcileInventory, nextExecutionItem } from '../../src/generation-plan'
import { assertPinnedRevision, type PinnedRevision } from '../src/lib/story-revision.server'
import type { ValidationResult } from '../../src/validator'

const sha = 'a'.repeat(40)
const previous = { scope: { kind: 'full-story' as const, depth: 'composition' as const, targets: [], branches: [] },
  constraints: ['Preserve the ending'], envelope: { presentation: 'Dialogue-led visual novel',
    hardLimits: ['No more than 12 scenes'], preferences: [] } }
const record = (type: string, slug: string, extra: Record<string, unknown> = {}): CanonicalScopeRecord =>
  ({ path: ({ 'creative-direction': 'creative-direction', 'world-entity': 'world-entities',
    'authored-content': 'authored-content' } as Record<string, string>)[type]
    ? (({ 'creative-direction': 'creative-direction', 'world-entity': 'world-entities',
      'authored-content': 'authored-content' } as Record<string, string>)[type] + '/' + slug + '.md')
    : type + 's/' + slug + '.md',
  metadata: { id: type + '.' + slug, type, status: 'draft', ...extra } })
const catalog: CanonicalScopeRecord[] = [
  record('creative-direction', 'foundation'),
  record('arc', 'trust', { title: 'Trust', characters: ['character.nia'] }),
  record('milestone', 'confession', { title: 'The Confession', arcs: ['arc.trust'],
    fulfillment: { any_of: [['event.confession']] } }),
  record('event', 'confession', { title: 'Confrontation', arcs: ['arc.trust'],
    characters: ['character.nia'] }),
  record('character', 'nia', { title: 'Nia' }),
  record('authored-content', 'confession', { title: 'Confrontation dialogue', events: ['event.confession'] }),
  record('milestone', 'escape', { title: 'The Escape', arcs: ['arc.trust'],
    fulfillment: { any_of: [['event.escape']] } }),
  record('event', 'escape', { title: 'Escape', arcs: ['arc.trust'] }),
  record('authored-content', 'escape', { title: 'Escape scene', events: ['event.escape'] }),
  record('character', 'sol', { title: 'Sol' }),
]
test('new focused conversation reuses verified speakers, Arc and foundation while assigning only missing support', () => {
  const preview = inferStoryObjective('Write a conversation between Nia and Sol about the hidden note.',
    catalog, sha, previous)
  assert.equal(preview.clarification, null)
  assert.equal(preview.reviewRequired, true)
  assert.equal(preview.contract.scope.kind, 'partial')
  const creates = preview.contract.scope.creates ?? []
  assert.deepEqual(creates.map(item => item.id), [
    'event.conversation-nia-sol-the-hidden-note',
    'authored-content.conversation-nia-sol-the-hidden-note',
  ])
  assert.deepEqual(creates[0]?.references, ['arc.trust', 'character.nia', 'character.sol'])
  assert.deepEqual(creates[0]?.dependsOn, [])
  assert.deepEqual(creates[1]?.dependsOn, [creates[0]?.id])
  assert.deepEqual(preview.writePaths, creates.map(item => item.path).sort())
  assert.ok(preview.readOnlyIds.includes('creative-direction.foundation'))
  assert.ok(preview.readOnlyIds.includes('character.nia'))
  assert.ok(preview.readOnlyIds.includes('character.sol'))
  assert.ok(!preview.targets.includes('arc.trust'))
  assert.ok(!preview.targets.includes('event.escape'))
  const resolved = resolveFocusedScope(catalog, preview.contract)
  assert.deepEqual(resolved.allowedPaths, preview.writePaths)
  assert.ok(resolved.context.some(item => item.metadata.id === 'arc.trust'))
})

test('a trust-focused conversation connects an otherwise missing Relationship to its Event', () => {
  const preview = inferStoryObjective('Write a conversation between Nia and Sol about rebuilding trust',
    catalog, sha, previous)
  const creates = preview.contract.scope.creates ?? []
  assert.deepEqual(creates.map(item => item.id.split('.')[0]),
    ['relationship', 'event', 'authored-content'])
  assert.deepEqual(creates[0]?.references, ['character.nia', 'character.sol'])
  assert.ok(creates[1]?.references.includes('relationship.nia-sol'))
  assert.deepEqual(creates[1]?.dependsOn, ['relationship.nia-sol'])
  assert.deepEqual(creates[2]?.dependsOn, creates.slice(0, 2).map(item => item.id))
  assert.deepEqual(preview.writePaths, creates.map(item => item.path).sort())
})

test('focused conversation creates only missing Character and support, not adjacent Story branches', () => {
  const preview = inferStoryObjective('Write a conversation between Nia and Orin about the missing key.',
    catalog, sha, previous)
  const creates = preview.contract.scope.creates ?? []
  assert.deepEqual(creates.map(item => item.id.slice(0, item.id.indexOf('.'))),
    ['character', 'event', 'authored-content'])
  assert.deepEqual(creates[0]?.dependsOn, [])
  assert.deepEqual(creates[1]?.dependsOn, ['character.orin'])
  assert.deepEqual(creates[2]?.dependsOn, ['character.orin', creates[1]?.id])
  assert.equal(preview.clarification, null)
  assert.throws(() => inferStoryObjective('Write a conversation between Nia and Orin about the missing key.',
    catalog, sha, previous, [creates[0]!.id]), /required typed support/)
  const withSiblingArc = [...catalog, record('arc', 'another')]
  const unclear = inferStoryObjective('Write a conversation between Nia and Orin about the missing key.',
    withSiblingArc, sha, previous)
  assert.match(unclear.clarification ?? '', /existing arc/)
  assert.deepEqual(unclear.targets, [])
  assert.deepEqual(unclear.writePaths, [])
})

test('focused conversation reuses a typed existing Event but never silently edits it', () => {
  const known = catalog.filter(item => item.metadata.id !== 'authored-content.confession')
    .map(item => item.metadata.id === 'event.confession'
      ? { ...item, metadata: { ...item.metadata,
          participants: ['character.nia', 'character.sol'] } } : item)
  const preview = inferStoryObjective('Write a conversation between Nia and Sol for event.confession',
    known, sha, previous)
  assert.equal(preview.clarification, null)
  assert.deepEqual(preview.contract.scope.creates?.map(item => item.id),
    ['authored-content.confession'])
  assert.ok(preview.readOnlyIds.includes('event.confession'))
  assert.ok(!preview.writePaths.includes('events/confession.md'))
  assert.deepEqual(preview.contract.scope.creates?.at(-1)?.references, ['event.confession'])
  const mismatch = inferStoryObjective('Write a conversation between Nia and Sol for event.confession',
    catalog.filter(item => item.metadata.id !== 'authored-content.confession'), sha, previous)
  assert.match(mismatch.clarification ?? '', /does not include both speakers/)
  assert.deepEqual(mismatch.writePaths, [])
})

test('focused support creation cannot authorize unrelated records or unsafe protected changes', () => {
  const protectedRequest = inferStoryObjective('Create a conversation between Nia and Orin that overrides canon',
    catalog, sha, previous)
  assert.ok(protectedRequest.clarification)
  assert.deepEqual(protectedRequest.writePaths, [])
  const unknown = inferStoryObjective('Write a conversation between Nia and Orin in arc.nonexistent',
    catalog, sha, previous)
  assert.match(unknown.clarification ?? '', /Unknown named canonical record/)
  assert.deepEqual(unknown.targets, [])
  const unsafe = inferStoryObjective('Write a conversation between Nia and Sol in arc.trust',
    catalog, sha, previous)
  const tampered = { ...unsafe.contract, scope: { ...unsafe.contract.scope,
    creates: [...(unsafe.contract.scope.creates ?? []), {
      id: 'arc.secret-subplot', path: 'arcs/secret-subplot.md', title: 'Secret subplot',
      references: [], dependsOn: [],
    }] } }
  assert.throws(() => resolveFocusedScope(catalog, tampered), /Invalid canonical focused creation grant/)
})

test('Collaborative mode asks about open creative alternatives while Autonomous mode can proceed', () => {
  const preview = inferStoryRevision('Make character.nia either less trusting or more guarded',
    catalog, sha, previous)
  assert.equal(preview.clarification, null)
  const autonomous = applyCreativeModeToRevision(preview, creativePolicy('autonomous'))
  const collaborative = applyCreativeModeToRevision(preview, creativePolicy('collaborative'))
  assert.equal(autonomous.clarification, null)
  assert.deepEqual(autonomous.targets, ['character.nia'])
  assert.match(collaborative.clarification ?? '', /Which of the proposed creative alternatives/)
  assert.deepEqual(collaborative.targets, autonomous.targets)
  assert.equal(collaborative.digest, autonomous.digest)
  const withProtectedCanon = catalog.map(item => item.metadata.type === 'creative-direction'
    ? { ...item, metadata: { ...item.metadata, decisions: [{ id: 'tone', statement: 'Hopeful',
      origin: 'user', authority: 'user-protected' }] } } : item)
  const protectedCandidate = inferStoryRevision('Change protected decision creative-direction.foundation#tone to "Bleak"',
    withProtectedCanon, sha, previous)
  assert.equal(applyCreativeModeToRevision(protectedCandidate, creativePolicy('autonomous')).protectedChange,
    protectedCandidate.protectedChange)
  assert.equal(applyCreativeModeToRevision(protectedCandidate, creativePolicy('collaborative')).protectedChange,
    protectedCandidate.protectedChange)
})

test('focused Character request grants one preexisting record path while reading typed context', () => {
  const result = inferStoryRevision('Make Nia less confrontational', catalog, sha, previous)
  assert.deepEqual(result.targets, ['character.nia'])
  assert.deepEqual(result.writePaths, ['characters/nia.md'])
  assert.equal(result.reviewRequired, false)
  assert.equal(result.clarification, null)
  assert.equal(result.depth, 'architecture')
  assert.ok(result.contextIds.includes('arc.trust'))
  assert.ok(!result.writePaths.includes('arcs/trust.md'))
  assert.deepEqual(result.contract.scope.targets, ['character.nia'])
  assert.deepEqual(result.contract.envelope.hardLimits, ['No more than 12 scenes'])
})
test('Event focus does not turn upstream Milestone or Character context into writable files', () => {
  const result = inferStoryRevision('Make event.confession more tense', catalog, sha, previous)
  assert.deepEqual(result.targets, ['event.confession'])
  assert.deepEqual(result.writePaths, ['events/confession.md'])
  assert.ok(result.readOnlyIds.includes('milestone.confession'))
  assert.equal(result.depth, 'interactive')
})
test('Milestone intent derives exact Events and prose from typed edges and requires review', () => {
  const result = inferStoryRevision('Rewrite milestone.confession across the entire dramatic arc',
    catalog, sha, previous)
  assert.deepEqual(result.targets, ['authored-content.confession', 'event.confession'])
  assert.deepEqual(result.writePaths, ['authored-content/confession.md', 'events/confession.md'])
  assert.ok(result.readOnlyIds.includes('milestone.confession'))
  assert.ok(!result.targets.includes('event.escape'))
  assert.ok(!result.targets.includes('authored-content.escape'))
  assert.equal(result.reviewRequired, true)
  assert.ok(result.dependencies.some(edge => edge.relation === 'fulfillment'))
  assert.ok(result.dependencies.some(edge => edge.relation === 'authored-content.events'))
  assert.equal(result.depth, 'composition')
})
test('a named Character within one explicit Event becomes read-only context, not a second target', () => {
  const result = inferStoryRevision('Make Nia less confrontational in event.confession',
    catalog, sha, previous)
  assert.equal(result.clarification, null)
  assert.deepEqual(result.targets, ['authored-content.confession', 'event.confession'])
  assert.ok(result.readOnlyIds.includes('character.nia'))
  assert.equal(result.reviewRequired, true)
  assert.ok(!result.writePaths.includes('characters/nia.md'))
  const conflicting = inferStoryRevision('Edit event.confession and character.nia',
    catalog, sha, previous)
  assert.equal(conflicting.clarification, null)
  assert.deepEqual(conflicting.targets, ['character.nia', 'event.confession'])
  assert.deepEqual(conflicting.writePaths, ['characters/nia.md', 'events/confession.md'])
  assert.equal(conflicting.reviewRequired, true)
})

test('Event prose requests require approval for supporting linked content, not sibling events', () => {
  const result = inferStoryRevision('Improve the dialogue for event.confession', catalog, sha, previous)
  assert.deepEqual(result.targets, ['authored-content.confession', 'event.confession'])
  assert.equal(result.reviewRequired, true)
})
test('review can narrow the inferred work set but never add independent paths', () => {
  const wide = inferStoryRevision('Change milestone.confession', catalog, sha, previous)
  const narrow = inferStoryRevision('Change milestone.confession', catalog, sha, previous, ['event.confession'])
  assert.deepEqual(narrow.writePaths, ['events/confession.md'])
  assert.notEqual(narrow.digest, wide.digest)
  assert.equal(narrow.reviewRequired, true)
  assert.throws(() => inferStoryRevision('Change milestone.confession', catalog, sha, previous,
    ['event.escape']), /subset/)
  assert.throws(() => inferStoryRevision('Change milestone.confession', catalog, sha, previous,
    ['event.confession', 'event.confession']), /subset/)
})
test('approved focused replan creates the correct dependent specialist inventory without unrelated replay', () => {
  const revision = inferStoryRevision('Change milestone.confession', catalog, sha, previous)
  const validation = { status: 'passed', report: {
    records: catalog, diagnostics: [], outstanding: [], readiness: { design: { stages: {} } },
    protection: { status: 'checked', base: sha, changes: [], warnings: [] },
    coverage: { search: { truncated: false }, eventProgress: [], milestoneRoutes: [],
      branchProgress: [], puzzleSolutions: [] },
  } } as unknown as ValidationResult
  const inventory = reconcileInventory({ version: 1, contract: revision.contract, items: [] },
    validation, sha, [{ stage: 'foundation', headSha: sha, status: 'committed' },
      { stage: 'architecture', headSha: sha, status: 'architecture-committed' }], {}, null)
  const focus = inventory.items.filter(i => i.stage === 'focus')
  assert.deepEqual(focus.map(item => item.id),
    ['focus:authored-content.confession', 'focus:event.confession'])
  assert.deepEqual(focus.find(item => item.milestone === 'authored-content.confession')?.dependencies,
    ['architecture', 'focus:event.confession'])
  assert.equal(nextExecutionItem(inventory)?.id, 'focus:event.confession')
  assert.ok(!inventory.items.some(item => item.id.includes('escape')))
  assert.deepEqual(inventory.items.find(item => item.stage === 'review')?.dependencies,
    ['focus:authored-content.confession', 'focus:event.confession'])
  // Context and mere typed adjacency do not authorize unrelated support writes.
  const unrelatedSupport = { ...revision.contract, scope: {
    ...revision.contract.scope, supportingTargets: ['character.sol'] } }
  assert.throws(() => resolveFocusedScope(catalog, unrelatedSupport), /Unauthorized supporting scope expansion/)
})

test('controller admission checks the exact approved digest, source and path ceiling', () => {
  const plan = inferStoryRevision('Rewrite milestone.confession', catalog, sha, previous)
  const pinned: PinnedRevision = { sourceJobId: 'job-1', sourceSha: sha,
    digest: plan.digest, selectedTargets: plan.targets, approved: true,
    contract: plan.contract, writePaths: plan.writePaths, contextIds: plan.contextIds }
  assert.doesNotThrow(() => assertPinnedRevision(pinned, plan, 'job-1', sha))
  assert.throws(() => assertPinnedRevision({ ...pinned, approved: false }, plan, 'job-1', sha), /scope changed/)
  assert.throws(() => assertPinnedRevision({ ...pinned, writePaths: [...plan.writePaths, 'characters/sol.md'] },
    plan, 'job-1', sha), /scope changed/)
  assert.throws(() => assertPinnedRevision({ ...pinned, sourceSha: 'b'.repeat(40) }, plan, 'job-1', sha), /scope changed/)
  assert.throws(() => assertPinnedRevision({ ...pinned, contextIds: [] }, plan, 'job-1', sha), /scope changed/)
  assert.throws(() => assertPinnedRevision(pinned, plan, 'other-job', sha), /scope changed/)
})

test('contradictory natural-language instruction identifies protected before/after review without write permission', () => {
  const protectedCatalog = catalog.map(item => item.metadata.id === 'creative-direction.foundation'
    ? { ...item, metadata: { ...item.metadata, decisions: [{
        id: 'repair-not-revenge', statement: 'The investigation should invite repair rather than revenge.',
        origin: 'user', authority: 'user-protected',
      }] } } : item)
  const review = inferStoryRevision('Make the investigation invite revenge rather than repair',
    protectedCatalog, sha, previous)
  assert.equal(review.clarification, null)
  assert.deepEqual(review.protectedChange, {
    decision: 'creative-direction.foundation#repair-not-revenge',
    path: 'creative-direction/foundation.md',
    before: 'The investigation should invite repair rather than revenge.',
    after: 'The investigation should invite revenge rather than repair.',
  })
  assert.equal(review.protectedConflict, null)
  assert.deepEqual(review.targets, [])
  assert.deepEqual(review.writePaths, ['creative-direction/foundation.md'])
  assert.equal(review.reviewRequired, true)
  const scopeAttempt = inferStoryRevision('Make the investigation invite revenge rather than repair',
    protectedCatalog, sha, previous, ['character.nia'])
  assert.equal(scopeAttempt.protectedChange, null)
  assert.deepEqual(scopeAttempt.writePaths, [])
  const ambiguous = inferStoryRevision('Make the investigation invite retaliation rather than revenge',
    protectedCatalog, sha, previous)
  assert.match(ambiguous.clarification!, /conflict with creative-direction.foundation#repair-not-revenge/)
  assert.equal(ambiguous.protectedChange, null)
  assert.equal(ambiguous.protectedConflict?.before,
    'The investigation should invite repair rather than revenge.')
  assert.deepEqual(ambiguous.writePaths, [])
  const reaffirm = inferStoryRevision('Keep the investigation inviting repair rather than revenge',
    protectedCatalog, sha, previous)
  assert.equal(reaffirm.protectedConflict, null)
  const changed = inferStoryRevision(
    'Change protected decision creative-direction.foundation#repair-not-revenge to "The investigation can now invite revenge."',
    protectedCatalog, sha, previous)
  assert.equal(changed.protectedChange?.before,
    'The investigation should invite repair rather than revenge.')
  assert.equal(changed.protectedChange?.after, 'The investigation can now invite revenge.')
})

test('ambiguous or protected requests fail closed without selecting unrelated Story records', () => {
  const ambiguous = inferStoryRevision('Change this Milestone', catalog, sha, previous)
  assert.equal(ambiguous.reviewRequired, true)
  assert.match(ambiguous.clarification!, /Multiple Story records/)
  assert.equal(ambiguous.targets.length, 0)
  const unknown = inferStoryRevision('Change event.missing', catalog, sha, previous)
  assert.match(unknown.clarification!, /Unknown canonical record/)
  const protectedEdit = inferStoryRevision('Retcon character.nia', catalog, sha, previous)
  assert.match(protectedEdit.clarification!, /Protected narrative decisions/)
  const creativeDirection = inferStoryRevision(
    'Change protected Creative Decision creative-direction.foundation#loyalty for event.confession',
    catalog, sha, previous)
  assert.match(creativeDirection.clarification!, /Protected narrative decisions/)
  assert.equal(creativeDirection.reviewRequired, true)
  assert.match(inferStoryRevision('Architecture only: change event.confession',
    catalog, sha, previous).clarification!, /deeper narrative stage/)
  assert.throws(() => inferStoryRevision('Change milestone.confession', catalog, sha, previous,
    ['character.sol']), /subset/)
})
