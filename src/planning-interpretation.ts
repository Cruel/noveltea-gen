/** Source-bound planning interpretation for Creative Direction discovery.
 * These are review proposals, not authority to alter protected canon.
 * The canonical Story uses existing decisions plus a concise Markdown
 * interpretation appendix; no new YAML schema or duplicate questionnaire. */
import type { StoryPlanning } from './story-planning.js'

export type PlanningSource =
  | { kind: 'turn'; index: number }
  | { kind: 'answer'; setId: string; questionId: string }
export type PlanningEvidence = {
  source: PlanningSource; decisionId: string; statement: string
  /** Actual submitted words/selected labels; excludes model-written question prompt. */
  authorText: string
  /** True only for a selected, exact categorical option, not model wording. */
  selectedOption: boolean
  /** True only for a *submitted*, trusted-policy-authorized delegation. */
  delegated: boolean
}
export type PlanningInterpretation = {
  /** Canonical JSON representation derived by the controller from StoryPlanning. */
  path: string; value: string; source: PlanningSource; sourceDecisionId: string
  basis: 'explicit' | 'inferred' | 'delegated'
  rationale: string
}
export class PlanningClarificationRequired extends Error {
  constructor(reason: string) { super(reason); this.name = 'PlanningClarificationRequired' }
}

/** A syntactically valid proposal misattributes author authority. This is
 * substantive provenance failure, not a response-format error. */
export class PlanningProvenanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PlanningProvenanceError'
  }
}

export const planningSourceKey = (source: PlanningSource): string =>
  source.kind === 'turn' ? 'turn:' + source.index : 'answer:' + source.setId + ':' + source.questionId
const own = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function resolvePlanningEvidence(raw: unknown, evidence: PlanningEvidence[]): PlanningEvidence {
  if (!own(raw)) throw Error('Invalid planning source identity.')
  let key: string
  if (raw.kind === 'turn' && Object.keys(raw).sort().join(',') === 'index,kind' &&
      Number.isSafeInteger(raw.index) && (raw.index as number) >= 0)
    key = 'turn:' + raw.index
  else if (raw.kind === 'answer' &&
      Object.keys(raw).sort().join(',') === 'kind,questionId,setId' &&
      typeof raw.setId === 'string' && typeof raw.questionId === 'string')
    key = 'answer:' + raw.setId + ':' + raw.questionId
  else throw Error('Invalid planning source identity.')
  const bound = evidence.find(item => planningSourceKey(item.source) === key)
  if (!bound) throw new PlanningProvenanceError('unsubmitted-source', 'Planning source is not a submitted author response.')
  return bound
}

/** A specific delegation authorizes its named topic, not unrelated creative
 * direction. Broad baseline grants are themselves explicit author answers. */
export function resolveDelegatedDecision(raw: unknown, evidence: PlanningEvidence[], _statement: string) {
  const bound = resolvePlanningEvidence(raw, evidence)
  if (!bound.delegated) throw new PlanningProvenanceError('missing-delegation', 'Studio decision lacks an author delegation.')
  // Only the exact submitted, controller-authorized delegation grants source
  // permission. Relevance is assessed separately by an independent, read-only
  // semantic reviewer; no keywords can grant or deny authorization here.
  return bound
}
const required = ['planning.choice_frequency', 'planning.choice_impact',
  'planning.branching.depth', 'planning.branching.route_exclusivity',
  'planning.puzzle_emphasis', 'planning.pacing', 'planning.first_playthrough'] as const

/** Full canonical Story paths are the only interpretation contract. Keep the
 * published path list and controller value extraction in one definition. */
const planningFields: ReadonlyArray<readonly [string, (p: StoryPlanning) => unknown]> = [
  ['planning.choice_frequency', p => p.choice_frequency],
  ['planning.choice_impact', p => p.choice_impact],
  ['planning.choice_points', p => p.choice_points],
  ['planning.branching.depth', p => p.branching?.depth],
  ['planning.branching.route_exclusivity', p => p.branching?.route_exclusivity],
  ['planning.puzzle_emphasis', p => p.puzzle_emphasis],
  ['planning.puzzle_count', p => p.puzzle_count],
  ['planning.pacing', p => p.pacing],
  ['planning.first_playthrough', p => p.first_playthrough],
  ['planning.production.illustrated_backgrounds', p => p.production?.illustrated_backgrounds],
  ['planning.production.background_variants', p => p.production?.background_variants],
  ['planning.production.character_artwork.main', p => p.production?.character_artwork?.main],
  ['planning.production.character_artwork.supporting', p => p.production?.character_artwork?.supporting],
  ['planning.production.character_artwork.extra', p => p.production?.character_artwork?.extra],
  ['planning.illustration_concepts', p => p.illustration_concepts],
]
export const planningDimensionPaths: readonly string[] = planningFields.map(([path]) => path)

/** Enumerate only populated planning fields, retaining grouped values for
 * duration, production limits and illustration concepts. */
export function planningDimensions(p: StoryPlanning): Array<{ path: string; value: unknown }> {
  return planningFields.flatMap(([path, read]) => {
    const value = read(p)
    return value === undefined ? [] : [{ path, value }]
  })
}

export class PlanningInterpretationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanningInterpretationContractError'
  }
}
const clarification = (evidence: PlanningEvidence[], dimension: 'branch' | 'puzzle') =>
  [...evidence].reverse().find(item => !item.delegated && item.source.kind === 'answer' &&
    /\b(?:clarify|clarification|resolve|conflict|contradic)\w*\b/i.test(item.statement) &&
    (dimension === 'branch' ? /branch|linear|route/i : /puzzle/i).test(item.statement))
const details = (evidence: PlanningEvidence[], dimension: 'branch' | 'puzzle') => {
  const resolved = clarification(evidence, dimension)
  if (resolved) return [resolved.authorText.toLowerCase()]
  return evidence.filter(item => !item.delegated).map(item => item.authorText.toLowerCase())
}

/** Narrow hard contradictions are fenced by the controller. Nuanced creative
 * interpretation remains model-assisted, but cannot override these explicit
 * author limits or contradict another explicit answer. */
export function assertPlanningConsistency(planning: StoryPlanning, evidence: PlanningEvidence[]) {
  const has = (dimension: 'branch' | 'puzzle', regex: RegExp) =>
    details(evidence, dimension).some(text => regex.test(text))
  const somewhatLinear = has('branch', /\b(?:somewhat|mostly|fairly|relatively|kind of|kinda) linear\b|\blinear,? but not too much\b/)
  const strictLinear = has('branch', /\b(?:strictly|completely|entirely|fully|only) linear\b|\bno branching\b|\bwithout branches\b/)
  const noDeepPattern = /\b(?:no|without|avoid|not|never)\s+(?:deep|extensive|heavy) branching\b/g
  const branchTexts = details(evidence, 'branch')
  // Match each statement independently. A negated category in one submitted
  // answer must not hide a separately expressed positive preference.
  const noDeepBranch = branchTexts.some(text => text.match(noDeepPattern) !== null)
  const deepBranch = branchTexts.some(text =>
    /\b(?:deep|extensive|heavily) branching\b|\bmany exclusive routes\b/.test(
      text.replace(noDeepPattern, '')))
  const noPuzzles = has('puzzle', /\b(?:no|zero|without) puzzles?\b|\bpuzzle[- ]free\b/)
  const wantsPuzzles = has('puzzle', /\b(?:(?:must|definitely)\s+(?:include|have)\s+|(?:require|include)\s+)(?:(?:some|custom|several|many|interactive)\s+)?puzzles?\b/)
  if ((strictLinear && deepBranch) || (noPuzzles && wantsPuzzles) ||
      (somewhatLinear && (strictLinear || deepBranch)))
    throw new PlanningClarificationRequired('Author requirements conflict: ask a focused clarification question before proposing Creative Direction.')
  if (somewhatLinear && (planning.branching?.depth !== 'shallow' ||
      planning.branching?.route_exclusivity !== 'limited'))
    throw new PlanningClarificationRequired('A somewhat-linear preference needs shallow branching and limited route-exclusive content; ask for clarification if a different design is intended.')
  if (noDeepBranch && planning.branching?.depth === 'deep')
    throw new PlanningClarificationRequired('The author rejected deep branching; ask before proposing it.')
  if (strictLinear && planning.branching?.depth !== 'linear')
    throw new PlanningClarificationRequired('The author explicitly requested linear structure; ask before proposing branching.')
  if (deepBranch && planning.branching?.depth !== 'deep')
    throw new PlanningClarificationRequired('The author explicitly requested deep branching; ask before narrowing it.')
  if (noPuzzles && planning.puzzle_emphasis !== 'none')
    throw new PlanningClarificationRequired('The author explicitly excluded Puzzles; ask before including them.')
  if (wantsPuzzles && planning.puzzle_emphasis === 'none')
    throw new PlanningClarificationRequired('The author explicitly required Puzzles; ask before omitting them.')
}

/** A model submits a path/source/basis/rationale claim. The controller derives
 * values from the exact StoryPlanning and verifies coverage, unique paths and actual answered
 * source identity before the proposal can enter an approval boundary. */
export function parsePlanningInterpretations(raw: unknown, planning: StoryPlanning,
  evidence: PlanningEvidence[], fullBaseline: boolean): PlanningInterpretation[] {
  if (!Array.isArray(raw) || raw.length > 24)
    throw Error('Missing or oversized source-bound planning interpretations.')
  assertPlanningConsistency(planning, evidence)
  const dimensions = planningDimensions(planning)
  if (fullBaseline && required.some(path => !dimensions.some(item => item.path === path)))
    throw Error('The initial Story planning baseline is incomplete.')
  const expectedPaths = dimensions.map(item => item.path)
  if (raw.length !== dimensions.length)
    throw new PlanningInterpretationContractError(
      'Every populated planning dimension requires exactly one interpretation. Expected paths: ' +
      expectedPaths.join(', ') + '.')
  const values = new Map(dimensions.map(item => [item.path, item.value]))
  const seen = new Set<string>()
  return raw.map(item => {
    if (!own(item)) throw Error('Invalid planning interpretation entry.')
    if (typeof item.path !== 'string' || !values.has(item.path) || seen.has(item.path)) {
      // Model-controlled strings are never echoed into correction prompts unless
      // bounded to a harmless path identifier; no arbitrary text or credentials.
      const received = typeof item.path === 'string' &&
        /^[a-zA-Z][a-zA-Z0-9_.]{0,95}$/.test(item.path) ? item.path : '<invalid>'
      throw new PlanningInterpretationContractError(
        (seen.has(String(item.path)) ? 'Duplicate' : 'Invalid') +
        ' planning interpretation path "' + received + '". Expected exactly: ' +
        expectedPaths.join(', ') + '.')
    }
    if (Object.keys(item).sort().join(',') !== 'basis,path,rationale,source' ||
        !['explicit', 'inferred', 'delegated'].includes(String(item.basis)) ||
        typeof item.rationale !== 'string' || !item.rationale.trim() ||
        item.rationale.length > 320 || /[\r\n\0]/.test(item.rationale) ||
        !own(item.source))
      throw Error('Invalid or unsupported planning interpretation.')
    seen.add(item.path)
    const bound = resolvePlanningEvidence(item.source, evidence)
    if ((item.basis === 'delegated') !== bound.delegated)
      throw new PlanningProvenanceError('unmatched-authority', 'Planning interpretation has no matching submitted author evidence or delegation.')
    const relevantClarification = item.path.startsWith('planning.branching.')
      ? clarification(evidence, 'branch') : item.path.startsWith('planning.puzzle_')
        ? clarification(evidence, 'puzzle') : undefined
    if (relevantClarification && planningSourceKey(bound.source) !== planningSourceKey(relevantClarification.source))
      throw new PlanningProvenanceError('superseded-source', 'A resolved planning conflict must cite its later author clarification.')
    // Exact provenance and basis remain deterministic. Whether this source's
    // meaning supports this dimension is assessed by the independent reviewer
    // before discovery can enter the approval boundary.
    // An arbitrary option label may contain the category while denying it
    // (e.g. 'No deep branching'). Only a complete categorical label is a
    // literally explicit value; all qualified wording needs inference.
    const value = values.get(item.path)
    if (item.basis === 'explicit' &&
        (!bound.selectedOption || typeof value !== 'string' ||
          bound.authorText.trim().toLowerCase().replace(/-/g, ' ') !==
          value.toLowerCase().replace(/-/g, ' ')))
      throw new PlanningProvenanceError('invented-explicit-choice', 'Model-derived planning cannot impersonate an explicit author choice.')
    if (item.basis === 'inferred' && bound.delegated)
      throw new PlanningProvenanceError('delegation-as-inference', 'Delegation cannot masquerade as an author inference.')
    if (typeof value === 'object' && value !== null && !bound.delegated) {
      const numerals = bound.authorText.match(/\b\d+(?:\.\d+)?\b/g) ?? []
      const numeric = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen|couple|few|several|hour|minute)\b/i.test(bound.authorText)
      if (!numerals.length && !numeric)
        throw new PlanningProvenanceError('missing-quantitative-source', 'Numeric planning estimates need an explicit quantitative source or delegation.')
      if (item.path.startsWith('planning.production.') && (value as { firmness?: string }).firmness === 'hard') {
        if (!/\b(?:hard|strict|maximum|max|at most|no more than|limit|cap|cannot exceed|must not exceed)\b/i.test(bound.authorText))
          throw new PlanningProvenanceError('invented-hard-limit', 'A model cannot fabricate a hard author production limit.')
        const exactCap = /(?:at most|max(?:imum)?|limit(?:ed)? to|no more than|cap(?:ped)? at)\s+(\d+)\b/i.exec(bound.authorText)
        const statedCap = exactCap ? Number(exactCap[1]) : numerals.length === 1 ? Number(numerals[0]) : undefined
        if (statedCap !== undefined &&
            (value as { count: { max: number } }).count.max !== statedCap)
          throw new PlanningClarificationRequired('The proposed hard production cap differs from the author quantity; ask rather than changing a protected limit.')
      }
      if (item.path === 'planning.first_playthrough') {
        const range = /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(bound.authorText)
        if (range) {
          const factor = /^(?:hour|hr)/i.test(range[3]!) ? 60 : 1
          const target = value as { min_minutes: number; max_minutes: number }
          if (target.min_minutes !== Number(range[1]) * factor ||
              target.max_minutes !== Number(range[2]) * factor)
            throw new PlanningClarificationRequired('The proposed duration differs from the author-specified playthrough range; ask for clarification.')
        }
      }
    }
    return { path: item.path as string, value: JSON.stringify(value),
      source: bound.source, sourceDecisionId: bound.decisionId,
      basis: item.basis as PlanningInterpretation['basis'], rationale: item.rationale as string }
  })
}

/** Hide the canonical appendix in the UI when the equivalent structured
 * interpretation review is already visible above the Story narrative. */
export function creativeDirectionNarrativeBody(body: string): string {
  const marker = '\n\n## Planning interpretations\n\n'
  const at = body.lastIndexOf(marker)
  return at < 0 ? body : body.slice(0, at)
}

/** Render only the interpretation and a reference to its existing canonical
 * Creative Decision. Full Question Set transcripts remain in Studio. */
export function renderPlanningInterpretations(
  interpretations: PlanningInterpretation[], evidence: PlanningEvidence[]): string {
  if (!interpretations.length) return ''
  const sourceByKey = new Map(evidence.map(e => [planningSourceKey(e.source), e]))
  return '\n\n## Planning interpretations\n\n' +
    interpretations.map(item => {
      const source = sourceByKey.get(planningSourceKey(item.source))!
      return '- **' + item.path + '**: ' + item.value + ' — ' +
        (item.basis === 'explicit' ? 'explicitly selected' :
          item.basis === 'delegated' ? 'chosen by NovelTea Studio under author delegation' :
            'inferred by NovelTea Studio from author wording') +
        '; source: Creative Decision `' + source.decisionId + '`. ' + item.rationale
    }).join('\n')
}
