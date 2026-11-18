import { createHash } from 'node:crypto'
import type { CompletionContract } from '../../../src/architecture'
import type { CanonicalScopeRecord } from '../../../src/focused-scope'
import { validTurnObjective, type TurnAssignmentEvidence, type TurnEvidence } from '../../../src/turn-plan-evidence'
import { DEFAULT_CREATIVE_POLICY, parseCreativePolicy, type CreativePolicy } from '../../../src/creative-policy'
import { focusedSpecialist, isFocusedRecordType } from '../../../src/focused-specialist'

export type TurnSpecialistAssignment = TurnAssignmentEvidence
export type TurnPlan = TurnEvidence

const sha = /^[a-f0-9]{40}$/
const categories: Record<string, string[]> = {
  foundation: ['creative-direction'],
  architecture: ['arc', 'milestone'],
  foundations: ['world-entity', 'fact', 'revelation', 'character', 'relationship'],
  event: ['event'],
  interactive: ['choice-point', 'puzzle'],
  composition: ['authored-content'],
  review: [],
}
const specialist: Record<string, string> = {
  foundation: 'nt-story-discovery',
  architecture: 'nt-story-architecture',
  foundations: 'nt-worldbuilding + nt-character-development',
  event: 'nt-event-design',
  interactive: 'nt-interactive-narrative',
  composition: 'nt-narrative-composition',
  review: 'nt-narrative-review',
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** An intent receipt, not a capability token. Every write is still checked
 * independently by the canonical resolver, Git diff and native validator. */
export function planWholeStory(request: string, contract: CompletionContract, base: string,
  sourceJobId: string | null = null, policy: CreativePolicy = DEFAULT_CREATIVE_POLICY): TurnPlan {
  if (!sha.test(base) || !request.trim() || contract.scope.kind !== 'full-story')
    throw new Error('A whole-Story Turn requires an original brief and exact verified source.')
  const stages = ['foundation', 'architecture', 'foundations', 'event', 'interactive',
    'composition', 'review'] as const
  const descriptions: Record<string, string> = {
    foundation: 'Establish Creative Direction and preserve author-protected decisions',
    architecture: 'Plan coherent Arcs, Milestones and their causal prerequisites',
    foundations: 'Build the Character and World foundations required by the architecture',
    event: 'Realize each verified Milestone with causal Events',
    interactive: 'Realize relevant choices and puzzles with valid branch outcomes',
    composition: 'Author the approved scenes, narration and dialogue',
    review: 'Check the complete Story against the goal and each specialist assignment',
  }
  const assignments = stages.map((stage, i): TurnSpecialistAssignment => ({
    id: stage, specialist: specialist[stage]!, outcome: descriptions[stage]!,
    targets: [], dependsOn: i ? [stages[i - 1]!] : [],
    discovery: 'canonical-story-read-only',
    authority: { recordTypes: categories[stage]!, existingPaths: [], mayCreate: stage !== 'review' },
  }))
  const body = { version: 1 as const, kind: 'full-story' as const,
    originalRequest: request, goal: request,
    source: { jobId: sourceJobId, verifiedSha: base }, contract, assignments,
    objective: { breadth: 'whole-story' as const, requestedTargets: [] as string[],
      deliveryDepth: contract.scope.depth,
      obligations: ['Coherent Creative Direction and protected author choices',
        'Connected Arcs, Milestones, Characters and causal Events',
        'Meaningful choices and branch consequences',
        'Player-facing authored scenes and dialogue',
        'Independent assessment of the original author goal'] },
    creativePolicy: parseCreativePolicy(policy), reviewRequired: false }
  return { ...body, digest: digest(body) }
}

export function planRevision(request: string, contract: CompletionContract, base: string,
  sourceJobId: string, catalog: CanonicalScopeRecord[], targetIds: string[],
  allowedPaths: string[], protectedChange?: { path: string } | null,
  policy: CreativePolicy = DEFAULT_CREATIVE_POLICY): TurnPlan {
  if (!sha.test(base) || !sourceJobId || !request.trim() || targetIds.length > 128)
    throw new Error('A revision Turn requires its original request and verified base.')
  const active = new Map(catalog.filter(r => r.metadata.status !== 'superseded')
    .map(record => [record.metadata.id, record]))
  const permitted = new Set(allowedPaths)
  const assignments: TurnSpecialistAssignment[] = []
  if (protectedChange) {
    if (targetIds.length || allowedPaths.length !== 1 || allowedPaths[0] !== protectedChange.path)
      throw new Error('Protected amendment is not a specialist authorization.')
    assignments.push({ id: 'protected-decision', specialist: 'trusted-controller',
      outcome: 'Apply only the separately approved exact author decision amendment',
      targets: [], dependsOn: [], discovery: 'canonical-story-read-only',
      authority: { recordTypes: [], existingPaths: [], mayCreate: false } })
  } else {
    if (!targetIds.length || !allowedPaths.length)
      throw new Error('A revision requires at least one bounded writable record.')
    const support = (contract.scope.supportingTargets ?? []).map(id => active.get(id))
    if (support.some(record => !record || !permitted.has(record.path)))
      throw new Error('Supporting Story path was not verified in the canonical scope.')
    const creates = new Map((contract.scope.creates ?? []).map(item => [item.id, item]))
    if ([...creates.keys()].some(id => active.has(id) || !targetIds.includes(id)))
      throw new Error('New specialist creation target collides with existing verified canon.')
    for (const target of targetIds) {
      const record = active.get(target), type = target.split('.')[0]!
      const create = creates.get(target)
      if (!isFocusedRecordType(type) || !!record === !!create ||
          (record && (record.metadata.type !== type || !permitted.has(record.path))) ||
          (create && !permitted.has(create.path)))
        throw new Error('Unverified specialist assignment target: ' + target)
      const relatedEvents = type === 'authored-content' && record &&
        Array.isArray(record.metadata.events) ? record.metadata.events.filter(
          (id): id is string => typeof id === 'string' && targetIds.includes(id)) : []
      const supportOwned = target === targetIds[0] ? support.filter(
        (item): item is NonNullable<typeof item> => !!item) : []
      const ownedPaths = [...(record ? [record.path] : []), ...supportOwned.map(item => item.path)].sort()
      assignments.push({ id: 'focus:' + target, specialist: focusedSpecialist(target),
        outcome: (create ? 'Create connected canonical ' + target + ' (' + create.title +
          '), preserving the exact approved typed references and all existing canon' :
          'Deliver the author-requested change to ' + target +
          ' while preserving Story continuity and protected canon'),
        targets: [target], dependsOn: [...new Set([
          ...(relatedEvents ?? []).map(id => 'focus:' + id),
          ...(create?.dependsOn ?? []).map(id => 'focus:' + id)])],
        discovery: 'canonical-story-read-only',
        authority: { recordTypes: [...new Set([type, ...supportOwned.map(item => item.metadata.type)])].sort(),
          existingPaths: ownedPaths, mayCreate: !!create,
          ...(create ? { newPaths: [create.path] } : {}) } })
    }
    // Supporting records must be explicitly resolved by the focused-scope
    // authorizer, never inferred from read/search activity.
    const assigned = new Set(assignments.flatMap(a =>
      [...a.authority.existingPaths, ...(a.authority.newPaths ?? [])]))
    if (allowedPaths.some(path => !assigned.has(path)) || assigned.size !== permitted.size)
      throw new Error('A supporting Story write requires a typed, explicitly reviewed assignment.')
    assignments.push({ id: 'review', specialist: 'nt-narrative-review',
      outcome: 'Verify each specialist change against its assignment and the Turn goal',
      targets: targetIds, dependsOn: assignments.map(a => a.id),
      discovery: 'canonical-story-read-only',
      authority: { recordTypes: [], existingPaths: [], mayCreate: false } })
  }
  const body = { version: 1 as const,
    kind: protectedChange ? 'protected-amendment' as const : 'revision' as const,
    originalRequest: request, goal: request,
    source: { jobId: sourceJobId, verifiedSha: base },
    contract, assignments,
    objective: { breadth: protectedChange ? 'protected-amendment' as const : 'focused' as const,
      requestedTargets: protectedChange ? [] : [...new Set(targetIds)].sort(),
      deliveryDepth: contract.scope.depth,
      obligations: protectedChange
        ? ['Apply only the separately authorized exact protected decision']
        : ['Deliver the requested changes to ' + [...new Set(targetIds)].sort().join(', '),
          ...(contract.scope.creates?.length ?
            ['Create only the necessary causally linked support and actual player-facing dialogue'] : []),
          'Preserve existing Story canon and unrelated verified records',
          'Independently check the selected changes against the Turn objective'] },
    creativePolicy: parseCreativePolicy(policy), reviewRequired: !!contract.scope.creates?.length || targetIds.length > 1 ||
      !!contract.scope.supportingTargets?.length || !!protectedChange }
  return { ...body, digest: digest(body) }
}

/** One controller-owned objective planning seam for first and subsequent Turns.
 * The requested breadth belongs to this Turn, never to the containing Thread.
 * Assignment authority is only a proposal; native/Git/owner checks still decide writes. */
export type ObjectivePlanningInput =
  | { kind: 'full-story'; request: string; contract: CompletionContract; base: string;
      sourceJobId?: string | null; policy?: CreativePolicy }
  | { kind: 'revision'; request: string; contract: CompletionContract; base: string;
      sourceJobId: string; catalog: CanonicalScopeRecord[]; targetIds: string[];
      allowedPaths: string[]; protectedChange?: { path: string } | null; policy?: CreativePolicy }

export function planObjective(input: ObjectivePlanningInput): TurnPlan {
  if (input.kind === 'full-story') return planWholeStory(input.request, input.contract,
    input.base, input.sourceJobId ?? null, input.policy)
  return planRevision(input.request, input.contract, input.base, input.sourceJobId,
    input.catalog, input.targetIds, input.allowedPaths, input.protectedChange, input.policy)
}

export function assertTurnPlan(saved: TurnPlan, expected: TurnPlan): void {
  if (!saved || saved.version !== 1 || saved.digest !== expected.digest ||
      JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error('Turn plan/assignment provenance differs from the original verified request.')
}

function validSavedPolicy(value: unknown): boolean {
  try { parseCreativePolicy(value); return true } catch { return false }
}

export function verifyTurnPlan(plan: TurnPlan): void {
  if (!plan || plan.version !== 1 || !sha.test(plan.source?.verifiedSha) ||
      !validTurnObjective(plan) ||
      (plan.creativePolicy !== undefined && !validSavedPolicy(plan.creativePolicy)) ||
      !Array.isArray(plan.assignments) || plan.assignments.length < 1 ||
      plan.assignments.length > 129 || !plan.originalRequest?.trim() ||
      !plan.goal?.trim() || !plan.assignments.every(a =>
        a.discovery === 'canonical-story-read-only' && Array.isArray(a.authority?.existingPaths) &&
        a.authority.existingPaths.every(path => /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(path)) &&
        (a.authority.newPaths === undefined ||
          (Array.isArray(a.authority.newPaths) &&
            a.authority.newPaths.every(path => /^[a-z][a-z-]*\/[a-z0-9-]+\.md$/.test(path)))) &&
        (plan.kind !== 'revision' || !a.id.startsWith('focus:') ||
          a.authority.mayCreate === !!plan.contract.scope.creates?.some(create =>
            a.id === 'focus:' + create.id &&
            JSON.stringify(a.authority.newPaths) === JSON.stringify([create.path]))))) {
    throw new Error('Invalid persisted Turn plan.')
  }
  const { digest: signature, ...body } = plan
  if (signature !== digest(body)) throw new Error('Turn plan integrity check failed.')
}
