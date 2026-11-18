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
  if (!bound) throw Error('Planning source is not a submitted author response.')
  return bound
}

/** A specific delegation authorizes its named topic, not unrelated creative
 * direction. Broad baseline grants are themselves explicit author answers. */
export function resolveDelegatedDecision(raw: unknown, evidence: PlanningEvidence[], statement: string) {
  const bound = resolvePlanningEvidence(raw, evidence)
  if (!bound.delegated) throw Error('Studio decision lacks an author delegation.')
  if (bound.source.kind === 'turn' || delegationForBaseline.test(bound.statement)) return bound
  const topics = ['ending', 'branch', 'puzzle', 'tone', 'genre', 'character', 'protagonist',
    'setting', 'location', 'clue', 'conflict', 'mystery', 'pacing', 'artwork', 'background']
  if (!topics.some(topic => new RegExp('\\b' + topic, 'i').test(bound.statement) &&
      new RegExp('\\b' + topic, 'i').test(statement)))
    throw Error('The author delegated a different creative topic.')
  return bound
}
const required = ['choice_frequency', 'choice_impact', 'branching.depth',
  'branching.route_exclusivity', 'puzzle_emphasis', 'pacing', 'first_playthrough'] as const

/** Enumerate meaningful planning fields, not arbitrary JSON leaves. Production
 * limits and duration stay grouped with their explicit units and firmness. */
export function planningDimensions(p: StoryPlanning): Array<{ path: string; value: unknown }> {
  const values: Array<{ path: string; value: unknown }> = []
  const add = (path: string, value: unknown) => {
    if (value !== undefined) values.push({ path, value })
  }
  for (const key of ['choice_frequency', 'choice_impact', 'choice_points'] as const) add(key, p[key])
  add('branching.depth', p.branching?.depth)
  add('branching.route_exclusivity', p.branching?.route_exclusivity)
  for (const key of ['puzzle_emphasis', 'puzzle_count', 'pacing', 'first_playthrough'] as const)
    add(key, p[key])
  add('production.illustrated_backgrounds', p.production?.illustrated_backgrounds)
  add('production.background_variants', p.production?.background_variants)
  for (const key of ['main', 'supporting', 'extra'] as const)
    add('production.character_artwork.' + key, p.production?.character_artwork?.[key])
  add('illustration_concepts', p.illustration_concepts)
  return values
}
const subject = (path: string) => path.startsWith('branching.') ? /branch|linear|route|divergen|exclusive|ending/i
  : path.startsWith('choice_') ? /choice|decision|impact|frequen/i
  : path.startsWith('puzzle_') ? /puzzle|mechanic|challenge/i
  : path === 'pacing' ? /pac|narrative|explor|dialogue/i
  : path === 'first_playthrough' ? /playthrough|playtime|duration|length|minute|hour|time/i
  : /production|budget|artwork|asset|illustrat|background|variant|concept/i
const delegationForBaseline = /\b(?:remaining|rest|everything|all other|all remaining|entire|whole)\b[\s\S]{0,100}\b(?:baseline|creative|story|direction|decision|detail|choice|requirement)s?\b|\b(?:all|remaining|rest)\s+(?:story\s+)?(?:baseline|planning)\b/i
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
  const deepBranch = has('branch', /\b(?:deep|extensive|heavily) branching\b|\bmany exclusive routes\b/)
  const noPuzzles = has('puzzle', /\b(?:no|zero|without) puzzles?\b|\bpuzzle[- ]free\b/)
  const wantsPuzzles = has('puzzle', /\b(?:(?:must|definitely)\s+(?:include|have)\s+|(?:require|include)\s+)(?:(?:some|custom|several|many|interactive)\s+)?puzzles?\b/)
  if ((strictLinear && deepBranch) || (noPuzzles && wantsPuzzles) ||
      (somewhatLinear && (strictLinear || deepBranch)))
    throw new PlanningClarificationRequired('Author requirements conflict: ask a focused clarification question before proposing Creative Direction.')
  if (somewhatLinear && (planning.branching?.depth !== 'shallow' ||
      planning.branching?.route_exclusivity !== 'limited'))
    throw new PlanningClarificationRequired('A somewhat-linear preference needs shallow branching and limited route-exclusive content; ask for clarification if a different design is intended.')
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
  if (raw.length !== dimensions.length)
    throw Error('Every proposed planning dimension needs one source-bound interpretation.')
  const values = new Map(dimensions.map(item => [item.path, item.value]))
  const seen = new Set<string>()
  return raw.map(item => {
    if (!own(item) || Object.keys(item).sort().join(',') !== 'basis,path,rationale,source' ||
        typeof item.path !== 'string' || seen.has(item.path) || !values.has(item.path) ||
        !['explicit', 'inferred', 'delegated'].includes(String(item.basis)) ||
        typeof item.rationale !== 'string' || !item.rationale.trim() ||
        item.rationale.length > 320 || /[\r\n\0]/.test(item.rationale) ||
        !own(item.source))
      throw Error('Invalid or unsupported planning interpretation.')
    seen.add(item.path)
    const bound = resolvePlanningEvidence(item.source, evidence)
    if ((item.basis === 'delegated') !== bound.delegated)
      throw Error('Planning interpretation has no matching submitted author evidence or delegation.')
    const relevantClarification = item.path.startsWith('branching.')
      ? clarification(evidence, 'branch') : item.path.startsWith('puzzle_')
        ? clarification(evidence, 'puzzle') : undefined
    if (relevantClarification && planningSourceKey(bound.source) !== planningSourceKey(relevantClarification.source))
      throw Error('A resolved planning conflict must cite its later author clarification.')
    // A delegation to decide an ending cannot authorize an unrelated production
    // budget. A broad baseline delegation is expressly allowed for missing values.
    if (!subject(item.path).test(bound.statement) &&
        !(bound.delegated && (bound.source.kind === 'turn' ||
          delegationForBaseline.test(bound.statement))))
      throw Error('Planning interpretation source does not concern this dimension.')
    // Never claim that a model's normalization was literally chosen by the author.
    // An exact categorical selection is explicit only when the original words
    // actually contain that category; other author inputs require 'inferred'.
    const value = values.get(item.path)
    if (item.basis === 'explicit' &&
        (!bound.selectedOption || typeof value !== 'string' ||
          !bound.authorText.toLowerCase().includes(value.replace(/-/g, ' ')) &&
          !bound.authorText.toLowerCase().includes(value)))
      throw Error('Model-derived planning cannot impersonate an explicit author choice.')
    if (item.basis === 'inferred' && bound.delegated)
      throw Error('Delegation cannot masquerade as an author inference.')
    if (typeof value === 'object' && value !== null && !bound.delegated) {
      const numerals = bound.authorText.match(/\b\d+(?:\.\d+)?\b/g) ?? []
      const numeric = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|dozen|couple|few|several|hour|minute)\b/i.test(bound.authorText)
      if (!numerals.length && !numeric)
        throw Error('Numeric planning estimates need an explicit quantitative source or delegation.')
      if (item.path.startsWith('production.') && (value as { firmness?: string }).firmness === 'hard') {
        if (!/\b(?:hard|strict|maximum|max|at most|no more than|limit|cap|cannot exceed|must not exceed)\b/i.test(bound.authorText))
          throw Error('A model cannot fabricate a hard author production limit.')
        const exactCap = /(?:at most|max(?:imum)?|limit(?:ed)? to|no more than|cap(?:ped)? at)\s+(\d+)\b/i.exec(bound.authorText)
        const statedCap = exactCap ? Number(exactCap[1]) : numerals.length === 1 ? Number(numerals[0]) : undefined
        if (statedCap !== undefined &&
            (value as { count: { max: number } }).count.max !== statedCap)
          throw new PlanningClarificationRequired('The proposed hard production cap differs from the author quantity; ask rather than changing a protected limit.')
      }
      if (item.path === 'first_playthrough') {
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
