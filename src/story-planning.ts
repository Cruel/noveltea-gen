/** Canonical Creative Direction planning metadata shared by Studio and job authoring.
 * This is input admission, not a second narrative analyzer: the native CLI
 * alone validates the rendered record and computes source-bound metrics. */
export interface CountRange { min?: number; max: number }
export interface MinuteRange { min_minutes: number; max_minutes: number }
export interface BudgetLimit { count: CountRange; firmness: 'hard' | 'soft' }
export interface StoryPlanning {
  choice_frequency?: 'none' | 'occasional' | 'frequent' | 'continuous'
  choice_impact?: 'local' | 'mixed' | 'lasting'
  choice_points?: CountRange
  branching?: { depth?: 'linear' | 'shallow' | 'deep'; route_exclusivity?: 'none' | 'limited' | 'substantial' }
  puzzle_emphasis?: 'none' | 'adventure' | 'custom' | 'hybrid'
  puzzle_count?: CountRange
  pacing?: 'narrative-led' | 'balanced' | 'exploration-led'
  first_playthrough?: MinuteRange
  production?: {
    illustrated_backgrounds?: BudgetLimit
    background_variants?: BudgetLimit
    character_artwork?: { main?: BudgetLimit; supporting?: BudgetLimit; extra?: BudgetLimit }
  }
  illustration_concepts?: Array<{
    id: string; description: string; variants?: Array<{ id: string; description: string }>
  }>
}

function object(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error('Invalid ' + label + ': unexpected fields or object shape')
  return value as Record<string, unknown>
}
function option(value: unknown, label: string, choices: readonly string[]) {
  if (value !== undefined && (typeof value !== 'string' || !choices.includes(value)))
    throw new Error('Invalid ' + label)
}
function count(value: unknown, label: string) {
  const v = object(value, label, ['min', 'max'])
  if (!Number.isSafeInteger(v.max) || (v.max as number) < 0 ||
    (v.min !== undefined && (!Number.isSafeInteger(v.min) ||
      (v.min as number) < 0 || (v.min as number) > (v.max as number))))
    throw new Error('Invalid ' + label + ' count')
}
function minutes(value: unknown, label: string) {
  const v = object(value, label, ['min_minutes', 'max_minutes'])
  if (typeof v.min_minutes !== 'number' || !Number.isFinite(v.min_minutes) || v.min_minutes < 0 ||
    typeof v.max_minutes !== 'number' || !Number.isFinite(v.max_minutes) ||
    v.max_minutes < v.min_minutes)
    throw new Error('Invalid ' + label + ' minutes')
}
function budget(value: unknown, label: string) {
  const v = object(value, label, ['count', 'firmness'])
  option(v.firmness, label + ' firmness', ['hard', 'soft'])
  if (v.firmness === undefined) throw new Error('Missing ' + label + ' firmness')
  count(v.count, label)
}
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** requireBaseline is for a NEW Chat discovery proposal, not legacy/on-disk
 * Foundations or focused Turns. No numeric quotas are invented here. */
export function parseStoryPlanning(value: unknown, requireBaseline = false): StoryPlanning {
  const p = object(value, 'Story planning', [
    'choice_frequency', 'choice_impact', 'choice_points', 'branching', 'puzzle_emphasis',
    'puzzle_count', 'pacing', 'first_playthrough', 'production', 'illustration_concepts',
  ])
  option(p.choice_frequency, 'Choice frequency', ['none', 'occasional', 'frequent', 'continuous'])
  option(p.choice_impact, 'Choice impact', ['local', 'mixed', 'lasting'])
  option(p.puzzle_emphasis, 'Puzzle emphasis', ['none', 'adventure', 'custom', 'hybrid'])
  option(p.pacing, 'Narrative/Exploration pacing', ['narrative-led', 'balanced', 'exploration-led'])
  if (p.choice_points !== undefined) count(p.choice_points, 'Choice points')
  if (p.puzzle_count !== undefined) count(p.puzzle_count, 'Puzzle count')
  if (p.branching !== undefined) {
    const b = object(p.branching, 'branching', ['depth', 'route_exclusivity'])
    option(b.depth, 'branching depth', ['linear', 'shallow', 'deep'])
    option(b.route_exclusivity, 'route exclusivity', ['none', 'limited', 'substantial'])
  }
  if (p.first_playthrough !== undefined) minutes(p.first_playthrough, 'first playthrough')
  if (p.production !== undefined) {
    const b = object(p.production, 'production budget', [
      'illustrated_backgrounds', 'background_variants', 'character_artwork',
    ])
    for (const kind of ['illustrated_backgrounds', 'background_variants']) {
      if (b[kind] !== undefined) budget(b[kind], kind)
    }
    if (b.character_artwork !== undefined) {
      const tiers = object(b.character_artwork, 'character artwork', ['main', 'supporting', 'extra'])
      for (const tier of ['main', 'supporting', 'extra'])
        if (tiers[tier] !== undefined) budget(tiers[tier], tier + ' Character artwork')
    }
  }
  if (p.illustration_concepts !== undefined) {
    if (!Array.isArray(p.illustration_concepts) || p.illustration_concepts.length > 64)
      throw new Error('Invalid illustration concepts')
    const ids = new Set<string>()
    for (const item of p.illustration_concepts) {
      const concept = object(item, 'illustration concept', ['id', 'description', 'variants'])
      if (typeof concept.id !== 'string' || !slug.test(concept.id) ||
        typeof concept.description !== 'string' || !concept.description.trim() ||
        concept.description.length > 1000 || ids.has(concept.id))
        throw new Error('Invalid or duplicate illustration concept')
      ids.add(concept.id)
      if (concept.variants === undefined) continue
      if (!Array.isArray(concept.variants) || concept.variants.length > 32)
        throw new Error('Invalid illustration variants')
      const variants = new Set<string>()
      for (const v of concept.variants) {
        const variant = object(v, 'illustration variant', ['id', 'description'])
        if (typeof variant.id !== 'string' || !slug.test(variant.id) || variants.has(variant.id) ||
          typeof variant.description !== 'string' || !variant.description.trim() ||
          variant.description.length > 1000)
          throw new Error('Invalid or duplicate illustration variant')
        variants.add(variant.id)
      }
    }
  }
  if (p.puzzle_emphasis === 'none' && p.puzzle_count !== undefined &&
    (p.puzzle_count as CountRange).max !== 0)
    throw new Error('No-Puzzle brief cannot propose a positive Puzzle count')
  if (p.branching && (p.branching as StoryPlanning['branching'])?.depth === 'linear' &&
    (p.branching as StoryPlanning['branching'])?.route_exclusivity === 'substantial')
    throw new Error('Linear branching cannot claim substantial route-exclusive content')
  if (requireBaseline && (!p.choice_frequency || !p.choice_impact ||
    !(p.branching as StoryPlanning['branching'])?.depth ||
    !(p.branching as StoryPlanning['branching'])?.route_exclusivity ||
    !p.puzzle_emphasis || !p.pacing || !p.first_playthrough || !p.production ||
    !Object.keys(p.production as object).length))
    throw new Error('New Story baseline needs Choice, branching, Puzzle, pacing, duration and production preferences')
  if (JSON.stringify(p).length > 12000) throw new Error('Planning metadata exceeds bounded size')
  return p as StoryPlanning
}
