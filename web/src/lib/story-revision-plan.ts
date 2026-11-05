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
export type RevisionPreview = {
  headSha: string; request: string; targets: string[]; writePaths: string[]
  contextIds: string[]; readOnlyIds: string[]; dependencies: Array<{ from: string; to: string; relation: string }>
  depth: CompletionContract['scope']['depth']; contract: CompletionContract
  rationale: string[]; reviewRequired: boolean; clarification: string | null
  protectedChange: ProtectedDecisionChange | null; digest: string
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
      reviewRequired: true, clarification: null, protectedChange: change }
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
  const explicitMilestones = explicit.filter(id => id.startsWith('milestone.'))
  const isMilestone = /\bmilestone(?:-wide)?\b/i.test(request) || !!explicitMilestones.length
  const isEvent = /\b(?:this|the|an?) event\b/i.test(request) ||
    explicit.some(id => id.startsWith('event.'))
  const isCharacter = /\bcharacter\b/i.test(request)
  const relevant = isMilestone ? candidate.filter(id => id.startsWith('milestone.')) :
    isEvent ? candidate.filter(id => id.startsWith('event.')) :
    isCharacter ? candidate.filter(id => id.startsWith('character.')) :
    candidate.filter(id => writingTypes.has(id.split('.')[0]!))
  const type = isMilestone ? 'milestone' : isEvent ? 'event' : isCharacter ? 'character' : null
  const matches = relevant.length ? relevant : type
    ? active.filter(r => r.metadata.type === type).map(r => r.metadata.id) : []
  const anchor = matches.length === 1 ? matches[0] : null
  const rationale: string[] = []
  let clarification: string | null = null
  if (unknown.length) clarification = 'Unknown canonical record: ' + unknown.join(', ') + '. Select an existing ID.'
  if (explicit.length > 1) clarification =
    'Multiple explicit record IDs require a separately reviewed impact plan. Name one canonical target.'
  if (!anchor) clarification ??= matches.length > 1
    ? 'Multiple Story records match. Specify the exact canonical ID: ' + matches.slice(0, 12).join(', ')
    : 'No unique canonical target was identified. Mention an existing Character, Event, or Milestone ID.'
  if (anchor && !writingTypes.has(anchor.split('.')[0]!) && !anchor.startsWith('milestone.'))
    clarification = 'That record cannot be revised by a focused specialist. Choose its Events or another supported record.'
  let proposed: string[] = anchor && writingTypes.has(anchor.split('.')[0]!) ? [anchor] : []
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
    scope: { kind: 'partial', depth, targets, branches: [] },
    constraints: unique([...previous.constraints,
      'Revision objective (only within the selected existing canonical records): ' + request]),
    envelope: previous.envelope,
  }
  // An ambiguous preview is not executable; the controller cannot issue a
  // partial generation contract until a concrete target is selected.
  const contract = targets.length ? parseGenerationContract(proposedContract) : proposedContract
  let writePaths: string[] = [], contextIds: string[] = []
  if (targets.length) {
    const resolved = resolveFocusedScope(active, contract)
    writePaths = resolved.allowedPaths
    contextIds = resolved.context.map(r => r.metadata.id)
  }
  contextIds = unique([...contextIds, ...dependencies.map(d => d.from),
    ...dependencies.map(d => d.to), ...(anchor ? [anchor] : [])]).filter(id => byId.has(id)).sort()
  const readOnlyIds = contextIds.filter(id => !targets.includes(id))
  const reviewRequired = !!clarification || isMilestone || targets.length > 1 ||
    selectedTargets !== undefined && JSON.stringify(targets) !== JSON.stringify(candidates) ||
    /\b(entire|all|across|every|rewrite|restructure|fundamental|dramatic|major)\b/i.test(request)
  if (isMilestone || targets.length > 1) rationale.push('Material scope expansion requires an explicit author-approved plan.')
  if (!rationale.length) rationale.push('A single existing canonical record is writable; its related Story records remain read-only.')
  const data = { headSha, request, targets, writePaths, contextIds, readOnlyIds,
    dependencies, depth, contract, rationale, reviewRequired, clarification,
    protectedChange: null }
  return { ...data, digest: hash(data) }
}
