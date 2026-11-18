import type { PlanningInterpretation } from '../../../src/planning-interpretation'

const descriptions: Record<string, string> = {
  choice_frequency: 'Choice frequency',
  choice_impact: 'Choice impact',
  'branching.depth': 'Branching depth',
  'branching.route_exclusivity': 'Route-exclusive content',
  puzzle_emphasis: 'Puzzle emphasis',
  puzzle_count: 'Puzzle count',
  choice_points: 'Choice points',
  pacing: 'Pacing',
  first_playthrough: 'Single-route playthrough (minutes)',
  'production.illustrated_backgrounds': 'Illustrated background budget',
  'production.background_variants': 'Background variant budget',
  'production.character_artwork.main': 'Main Character artwork budget',
  'production.character_artwork.supporting': 'Supporting Character artwork budget',
  'production.character_artwork.extra': 'Extra Character artwork budget',
  illustration_concepts: 'Illustration concepts',
}
function displayValue(entry: PlanningInterpretation): string {
  let value: unknown
  try { value = JSON.parse(entry.value) }
  catch { return entry.value }
  if (typeof value === 'string') return value.replace(/-/g, ' ')
  if (entry.path === 'first_playthrough' && value && typeof value === 'object' &&
      'min_minutes' in value && 'max_minutes' in value)
    return String(value.min_minutes) + '–' + String(value.max_minutes) + ' minutes per route'
  if (value && typeof value === 'object' && 'count' in value &&
      value.count && typeof value.count === 'object' && 'max' in value.count) {
    const count = value.count as { min?: number; max: number }
    const limit = count.min !== undefined ? count.min + '–' + count.max : 'up to ' + count.max
    return limit + ('firmness' in value && typeof value.firmness === 'string'
      ? ' (' + value.firmness + ' budget)' : '')
  }
  if (value && typeof value === 'object' && 'max' in value)
    return 'up to ' + String(value.max)
  if (entry.path === 'illustration_concepts' && Array.isArray(value))
    return value.length + ' illustration concepts'
  return entry.value
}
const basisName: Record<PlanningInterpretation['basis'], string> = {
  explicit: 'Author selection',
  inferred: 'Studio interpretation of author wording',
  delegated: 'Studio decision under author delegation',
}
/** A review of the exact bound value and why Studio proposed it, not a
 * substitute for the distinct protected Creative Direction approval. */
export function PlanningInterpretationsView({ interpretations, decisions }: {
  interpretations: PlanningInterpretation[]
  decisions: Array<{ id: string; statement: string }>
}) {
  if (!interpretations.length) return null
  return <section aria-label="Planning interpretations" className="grid gap-2">
    <h4 className="m-0 font-semibold">How your direction was interpreted</h4>
    <p className="m-0 text-xs text-muted-foreground">
      These are proposed planning values, not quotations from you. Approving Creative Direction
      confirms the interpretation shown here. Original answers remain separate.
    </p>
    <dl className="grid gap-2">
      {interpretations.map(entry => {
        const source = decisions.find(d => d.id === entry.sourceDecisionId)
        const value = displayValue(entry)
        return <div key={entry.path} className="grid gap-0.5 border-b border-border/40 pb-2 last:border-0">
          <dt className="text-xs font-medium">{descriptions[entry.path] ?? entry.path}</dt>
          <dd className="m-0 break-words text-sm"><strong>{value}</strong>
            <span className="ml-2 text-xs text-muted-foreground">({basisName[entry.basis]})</span>
          </dd>
          <dd className="m-0 text-xs text-muted-foreground">{entry.rationale}</dd>
          {source && <dd className="m-0 text-xs text-muted-foreground">
            Source — {source.statement}
          </dd>}
        </div>
      })}
    </dl>
  </section>
}
