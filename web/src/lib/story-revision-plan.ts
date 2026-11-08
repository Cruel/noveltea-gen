import { createHash } from 'node:crypto'
import { parseGenerationContract } from '../../../src/generation'
import { resolveFocusedScope, type CanonicalScopeRecord } from '../../../src/focused-scope'
import type { CompletionContract } from '../../../src/architecture'

type RecordItem = CanonicalScopeRecord & { metadata: CanonicalScopeRecord['metadata'] & {
  title?: string; arcs?: string[]; events?: string[]; fulfillment?: { any_of?: string[][] }
  decisions?: Array<{ id: string; statement: string; origin: string; authority: string }> } }
export type ProtectedDecisionChange = {
  decision: string; path: string; before: string; after: string
}
export type ProtectedConflictCandidate = {
  decision: string; path: string; before: string; requestedDirection: string
}
export type RevisionPreview = {
  headSha: string; request: string; targets: string[]; writePaths: string[]
  contextIds: string[]; readOnlyIds: string[]; dependencies: Array<{ from: string; to: string; relation: string }>
  depth: CompletionContract['scope']['depth']; contract: CompletionContract
  rationale: string[]; reviewRequired: boolean; clarification: string | null
  protectedChange: ProtectedDecisionChange | null;
  protectedConflict: ProtectedConflictCandidate | null; digest: string
}
const SHA = /^[a-f0-9]{40}$/
const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const writingTypes = new Set(['character', 'relationship', 'world-entity', 'fact', 'revelation',
  'event', 'authored-content', 'choice-point', 'puzzle'])
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ids = (value: unknown) => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === 'string') : []
const unique = <T>(values: T[]) => [...new Set(values)]
const exactId = /\b(?:arc|milestone|character|relationship|world-entity|fact|revelation|event|authored-content|choice-point|puzzle)\.[a-z][a-z0-9-]*\b/gi
const protectedEdit = /^(?:please\s+)?(?:change|replace|revise|update)\s+(?:the\s+)?(?:protected\s+)?(?:creative\s+)?decision\s+(creative-direction\.[a-z][a-z0-9-]*#[a-z][a-z0-9-]*)\s+(?:to|with)\s+("(?:[^"\\]|\\.)*")\s*\.?$/i
const protectedIntent = /\b(?:protected\s+(?:creative\s+)?decision|creative[-\s]+direction|override\s+canon|retcon|change\s+(?:the\s+)?(?:genre|tone|premise|scope|foundation)|ignore\s+(?:the\s+)?(?:original|author|canon))\b/i
const contrast = /\b(?:instead\s+of|rather\s+than|no\s+longer|opposite|reverse|replace|swap|contrary|never|not|over)\b/i
const contentWords = (text: string): Set<string> => new Set(text.toLowerCase()
  .match(/[a-z]{4,}/g)?.filter(word => !new Set([
    'that', 'this', 'with', 'from', 'must', 'should', 'would', 'could',
    'instead', 'rather', 'than', 'into', 'have', 'make', 'about', 'there',
    'their', 'they', 'over', 'before', 'after', 'never', 'without',
  ]).has(word)) ?? [])
const includesName = (text: string, name: string) => name.length >= 2 &&
  new RegExp('(^|[^a-z0-9])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i').test(text)
const depthFor = (targets: string[]): CompletionContract['scope']['depth'] =>
  targets.some(id => id.startsWith('authored-content.')) ? 'composition' :
  targets.some(id => /^(event|choice-point|puzzle)\./.test(id)) ? 'interactive' : 'architecture'

/** Build a *proposal*, never a Pi grant. Only the signed-in controller can pin
 * the derived contract, exact existing paths, source SHA and approval digest.
 * Catalog relationships are structural/typed: prose is never parsed as authority. */
export function inferStoryRevision(prompt: string, catalog: CanonicalScopeRecord[],
  headSha: string, previous: CompletionContract, selectedTargets?: string[]): RevisionPreview {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || unsafe.test(prompt) ||
      !SHA.test(headSha)) throw new Error('Enter a printable 1–4000-character revision request at a verified Story HEAD.')
  const request = prompt.trim()
  const active = catalog.filter(r => r.metadata.status !== 'superseded') as RecordItem[]
  if (active.length > 10_000 || active.some(r => typeof r.metadata.id !== 'string' ||
      typeof r.path !== 'string') || new Set(active.map(r => r.metadata.id)).size !== active.length)
    throw new Error('Canonical Story catalog is incomplete or contains duplicate record IDs.')
  const byId = new Map(active.map(r => [r.metadata.id, r]))
  // A scope digest is NEVER authority to retcon an author's protected canon.
  // The only executable protected request names the exact existing decision
  // and its replacement statement. The trusted controller separately approves
  // the resulting before/after delta bound to the Thread and Git HEAD.
  const protectedMatch = protectedEdit.exec(request)
  if (protectedMatch) {
    const [recordId, decisionId] = protectedMatch[1]!.toLowerCase().split('#')
    const record = byId.get(recordId!)
    const decision = record?.metadata.type === 'creative-direction'
      ? record.metadata.decisions?.find(d => d.id === decisionId) : undefined
    let replacement = ''
    try { replacement = JSON.parse(protectedMatch[2]!) as string }
    catch { /* Invalid JSON-escaped statement must fail closed. */ }
    if (!record || !decision || decision.origin !== 'user' ||
        decision.authority !== 'user-protected' || typeof replacement !== 'string' ||
        !replacement.trim() || replacement === decision.statement || replacement.length > 1000 ||
        !/^creative-direction\/[a-z][a-z0-9-]*\.md$/.test(record.path))
      throw new Error('The protected decision, its exact current statement, or the proposed replacement is invalid.')
    if (selectedTargets !== undefined) throw new Error('Protected decisions have a fixed one-record scope.')
    const change: ProtectedDecisionChange = { decision: `${recordId}#${decisionId}`,
      path: record.path, before: decision.statement, after: replacement }
    // A direct, controller-authored amendment is NOT a Pi specialist grant.
    // Preserve the previously pinned valid contract only as historical
    // context; this revision-only run has no generation graph or Pi writer.
    // The separate protectedChange controls the sole writable Story file.
    const contract = parseGenerationContract(previous)
    const data = { headSha, request, targets: [] as string[], writePaths: [record.path],
      contextIds: [recordId!], readOnlyIds: [] as string[], dependencies: [] as RevisionPreview['dependencies'],
      depth: 'architecture' as const, contract,
      rationale: ['An existing author-protected decision would change. Review the exact before/after text; a prior Thread approval is not transferable.'],
      reviewRequired: true, clarification: null, protectedChange: change,
      protectedConflict: null }
    return { ...data, digest: hash(data) }
  }
  // Detect bounded, language-level reversals against protected statements
  // before ordinary scope inference. This is deliberately conservative: a
  // suspicion pauses rather than inventing a replacement or author consent.
  const protections = active.flatMap(record => record.metadata.type === 'creative-direction'
    ? (record.metadata.decisions ?? []).filter(decision =>
        decision.origin === 'user' && decision.authority === 'user-protected')
      .map(decision => ({ decision: record.metadata.id + '#' + decision.id,
        path: record.path, before: decision.statement })) : [])
  const promptWords = contentWords(request)
  const priority = /\b([a-z]{3,})\s+(?:rather than|instead of|over)\s+([a-z]{3,})\b/i
  const contradictions = contrast.test(request) ? protections.filter(item => {
    const shared = [...contentWords(item.before)].filter(word => promptWords.has(word))
    const previousPreference = priority.exec(item.before)
    const requestedPreference = priority.exec(request)
    if (previousPreference && requestedPreference &&
        previousPreference[1]!.toLowerCase() === requestedPreference[1]!.toLowerCase() &&
        previousPreference[2]!.toLowerCase() === requestedPreference[2]!.toLowerCase())
      return false // The author reaffirmed, rather than contradicted, canon.
    return shared.length >= 2 || request.toLowerCase().includes(item.decision.toLowerCase())
  }) : []
  if (contradictions.length) {
    const item = contradictions[0]!
    const originalPreference = priority.exec(item.before)
    const requestedPreference = priority.exec(request)
    // A literal reversal of one unambiguous preference can produce a
    // concrete, reviewable candidate without generating or asserting any
    // canonical prose on the author's behalf. Nothing is written until the
    // exact replacement passes the independent owner+Git approval workflow.
    if (contradictions.length === 1 && originalPreference && requestedPreference &&
        originalPreference[1]!.toLowerCase() === requestedPreference[2]!.toLowerCase() &&
        originalPreference[2]!.toLowerCase() === requestedPreference[1]!.toLowerCase() &&
        !/\b(?:don't|do not|never|avoid|without|reject|not)\b/i.test(request) &&
        selectedTargets === undefined) {
      const after = item.before.replace(originalPreference[0],
        `${originalPreference[2]} rather than ${originalPreference[1]}`)
      if (after !== item.before && after.length <= 1000) {
        const change: ProtectedDecisionChange = { ...item, after }
        const data = { headSha, request, targets: [] as string[], writePaths: [item.path],
          contextIds: [item.decision.split('#')[0]!], readOnlyIds: [] as string[],
          dependencies: [] as RevisionPreview['dependencies'], depth: 'architecture' as const,
          contract: parseGenerationContract(previous),
          rationale: ['Literal reversal of one existing protected preference; approve this exact candidate, not the instruction itself.'],
          reviewRequired: true, clarification: null, protectedChange: change, protectedConflict: null }
        return { ...data, digest: hash(data) }
      }
    }
    const candidate: ProtectedConflictCandidate = { ...item, requestedDirection: request }
    const data = { headSha, request, targets: [] as string[], writePaths: [] as string[],
      contextIds: [item.decision.split('#')[0]!], readOnlyIds: [] as string[],
      dependencies: [] as RevisionPreview['dependencies'],
      depth: 'architecture' as const, contract: parseGenerationContract(previous),
      rationale: ['Possible contradiction with a protected author statement; no Story write is authorized.'],
      reviewRequired: true,
      clarification: 'This instruction appears to conflict with ' + item.decision +
        '. Review the existing statement and requested direction, then propose its exact replacement: ' +
        'Change protected decision ' + item.decision + ' to "new statement".',
      protectedChange: null, protectedConflict: candidate }
    return { ...data, digest: hash(data) }
  }
  const typed = unique([...request.matchAll(exactId)].map(m => m[0]!.toLowerCase()))
  const unknown = typed.filter(id => !byId.has(id))
  const names = active.filter(r => typeof r.metadata.title === 'string' &&
    includesName(request, r.metadata.title))
  // An explicit canonical ID names the intended writer target. A separately
  // mentioned Character name supplies context, not a second writing grant.
  const explicit = typed.filter(id => byId.has(id))
  const candidate = explicit.length ? explicit : unique(names.map(r => r.metadata.id))
  // Multiple named goals, or a broad request over an existing Story, are
  // coordinated assignments rather than a demand to name one file up front.
  // Only catalog-backed existing records may become writable.
  const generalStoryGoal = !explicit.length && !names.length &&
    /\b(?:story|plot|narrative|pacing|ending|dialogue|scenes|characters|choices)\b/i.test(request) &&
    /\b(?:improve|revise|rewrite|tighten|polish|change|adjust|fix|make)\b/i.test(request)
  const broad = /\b(?:entire|whole|all|every)\s+(?:story|characters|events|scenes|dialogue)\b/i.test(request) ||
    generalStoryGoal
  const coordinated = (explicit.length > 1 || (!explicit.length && names.length > 1)) &&
    /\b(?:and|both|across|each|all)\b/i.test(request)
  const broadTypes = /\bcharacters\b/i.test(request) ? ['character'] :
    /\bevents\b/i.test(request) ? ['event'] :
    /\b(?:scenes|dialogue)\b/i.test(request) ? ['authored-content'] :
    /\b(?:choices|puzzles)\b/i.test(request) ? ['choice-point', 'puzzle'] :
    /\b(?:pacing|plot|ending)\b/i.test(request) ? ['event', 'authored-content'] :
    [...writingTypes]
  const broadTargets = broad ? active.filter(r => broadTypes.includes(r.metadata.type))
    .map(r => r.metadata.id) : []
  const multiple = coordinated || broad
  const explicitMilestones = explicit.filter(id => id.startsWith('milestone.'))
  const isMilestone = /\bmilestone(?:-wide)?\b/i.test(request) || !!explicitMilestones.length
  const isEvent = /\b(?:this|the|an?) (?:event|beat)\b/i.test(request) ||
    explicit.some(id => id.startsWith('event.'))
  const isCharacter = /\bcharacter\b/i.test(request)
  const relevant = isMilestone ? candidate.filter(id => id.startsWith('milestone.')) :
    isEvent ? candidate.filter(id => id.startsWith('event.')) :
    isCharacter ? candidate.filter(id => id.startsWith('character.')) :
    candidate.filter(id => writingTypes.has(id.split('.')[0]!))
  const type = isMilestone ? 'milestone' : isEvent ? 'event' : isCharacter ? 'character' : null
  const matches = multiple ? unique([...candidate.filter(id => writingTypes.has(id.split('.')[0]!)),
    ...broadTargets]) : relevant.length ? relevant : type
      ? active.filter(r => r.metadata.type === type).map(r => r.metadata.id) : []
  const anchor = !multiple && matches.length === 1 ? matches[0] : null
  const rationale: string[] = []
  let clarification: string | null = null
  if (unknown.length) clarification = 'Unknown canonical record: ' + unknown.join(', ') + '. Select an existing ID.'
  if (explicit.length > 1 && !coordinated && !broad) clarification =
    'Multiple explicit record IDs require a coordinated request identifying the intended changes.'
  if (!anchor && !multiple) clarification ??= matches.length > 1
    ? 'Multiple Story records match. Specify the exact canonical ID: ' + matches.slice(0, 12).join(', ')
    : 'No unique canonical target was identified. Mention an existing Character, Event, or Milestone ID.'
  if (anchor && !writingTypes.has(anchor.split('.')[0]!) && !anchor.startsWith('milestone.'))
    clarification = 'That record cannot be revised by a focused specialist. Choose its Events or another supported record.'
  let proposed: string[] = multiple ? matches : anchor && writingTypes.has(anchor.split('.')[0]!) ? [anchor] : []
  const dependencies: RevisionPreview['dependencies'] = []
  const linked = (from: string, to: string, relation: string) => {
    if (byId.has(from) && byId.has(to) && from !== to) dependencies.push({ from, to, relation })
  }
  if (anchor?.startsWith('milestone.')) {
    const milestone = byId.get(anchor)!
    const events = unique((milestone.metadata.fulfillment?.any_of ?? []).flatMap(option => ids(option)))
      .filter(id => byId.get(id)?.metadata.type === 'event')
    proposed = [...events]
    for (const event of events) {
      linked(anchor, event, 'fulfillment')
      for (const record of active.filter(r => r.metadata.type === 'authored-content' &&
        ids(r.metadata.events).includes(event))) {
        proposed.push(record.metadata.id)
        linked(event, record.metadata.id, 'authored-content.events')
      }
    }
    if (!events.length)
      clarification = 'The Milestone has no canonical fulfillment Events. An explicit architecture plan is required before revision.'
    rationale.push('Milestone is an upstream read-only anchor. Only its linked existing Events and authored prose are proposed for writing.')
  } else if (anchor?.startsWith('event.')) {
    for (const milestone of active.filter(r => r.metadata.type === 'milestone' &&
      (r.metadata.fulfillment?.any_of ?? []).some(option => ids(option).includes(anchor))))
      linked(milestone.metadata.id, anchor, 'fulfillment')
    for (const record of active.filter(r => r.metadata.type === 'authored-content' &&
      ids(r.metadata.events).includes(anchor))) linked(anchor, record.metadata.id, 'authored-content.events')
    if (/\b(dialogue|prose|scene|lines|narration|confrontational|aggressive|empathetic|tone)\b/i.test(request)) {
      const content = dependencies.filter(d => d.from === anchor && d.relation === 'authored-content.events')
        .map(d => d.to)
      proposed.push(...content)
      rationale.push('Dialogue edits may require existing Event-linked authored prose; those additional paths need author review.')
    }
  }
  if (multiple) {
    if (!matches.length) clarification ??= 'No existing canonical records match this wider request.'
    for (const item of active.filter(r => r.metadata.type === 'authored-content' &&
      proposed.includes(r.metadata.id))) {
      for (const event of ids(item.metadata.events).filter(id => proposed.includes(id)))
        linked(event, item.metadata.id, 'authored-content.events')
    }
  }
  const supporting = multiple ? explicit.filter(id => id.startsWith('arc.')).sort() : []
  if (multiple && explicit.some(id => !writingTypes.has(id.split('.')[0]!) &&
      !id.startsWith('arc.')))
    clarification ??= 'This coordinated revision names protected or upstream structure. Review it as a separate architecture/protected change.'
  const candidates = unique(proposed).sort()
  if (candidates.length > 128) clarification = 'The revision impacts more than 128 records. Narrow the request.'
  if (selectedTargets !== undefined && (!Array.isArray(selectedTargets) ||
      !selectedTargets.length || selectedTargets.length > 128 ||
      selectedTargets.some(id => typeof id !== 'string' || !candidates.includes(id)) ||
      new Set(selectedTargets).size !== selectedTargets.length))
    throw new Error('Selected revision targets must be a unique, nonempty subset of the proposed canonical records.')
  const targets = (selectedTargets ?? candidates).slice().sort()
  if (!targets.length) clarification ??= 'No writable existing records were identified. Narrow or replan the request.'
  if (protectedIntent.test(request) || /\b(?:override|delete|remove)\b.*\b(?:decision|canon)\b/i.test(request)) {
    clarification = 'Protected narrative decisions require exact authorization. Propose: Change protected decision creative-direction.<record>#<decision> to "new statement". Scope approval cannot authorize a retcon.'
  }
  const depth = depthFor(targets)
  if (depth !== 'architecture' && /\b(?:architecture[- ]only|outline[- ]only|no (?:dialogue|event work))\b/i.test(request))
    clarification = 'The requested record type requires a deeper narrative stage than the requested outline. Adjust the request or choose a compatible target.'
  if (depth === 'composition' && /\binteractive[- ]only\b/i.test(request))
    clarification = 'Authored prose requires composition depth. Narrow the targets or change the requested stage.'
  const proposedContract: CompletionContract = {
    scope: { kind: 'partial', depth, targets, branches: [],
      ...(supporting.length ? { supportingTargets: supporting } : {}) },
    constraints: unique([...previous.constraints,
      'Revision objective (only within the selected existing canonical records): ' + request]),
    envelope: previous.envelope,
  }
  // An ambiguous preview is not executable; the controller cannot issue a
  // partial generation contract until a concrete target is selected.
  const contract = targets.length ? parseGenerationContract(proposedContract) : proposedContract
  let writePaths: string[] = [], contextIds: string[] = []
  if (targets.length) {
    try {
      const resolved = resolveFocusedScope(active, contract)
      writePaths = resolved.allowedPaths
      contextIds = resolved.context.map(r => r.metadata.id)
    } catch (error) {
      if (!supporting.length) throw error
      clarification ??= error instanceof Error ? error.message : 'Requested supporting Story changes need a reviewed plan.'
      // An unresolved support expansion grants no writable targets.
      writePaths = []
    }
  }
  contextIds = unique([...contextIds, ...dependencies.map(d => d.from),
    ...dependencies.map(d => d.to), ...(anchor ? [anchor] : [])]).filter(id => byId.has(id)).sort()
  const readOnlyIds = contextIds.filter(id => !targets.includes(id) && !supporting.includes(id))
  const reviewRequired = !!clarification || isMilestone || multiple || !!supporting.length || targets.length > 1 ||
    selectedTargets !== undefined && JSON.stringify(targets) !== JSON.stringify(candidates) ||
    /\b(entire|all|across|every|rewrite|restructure|fundamental|dramatic|major)\b/i.test(request)
  if (isMilestone || targets.length > 1) rationale.push('Material scope expansion requires an explicit author-approved plan.')
  if (!rationale.length) rationale.push('A single existing canonical record is writable; its related Story records remain read-only.')
  const data = { headSha, request, targets, writePaths, contextIds, readOnlyIds,
    dependencies, depth, contract, rationale, reviewRequired, clarification,
    protectedChange: null, protectedConflict: null }
  return { ...data, digest: hash(data) }
}
