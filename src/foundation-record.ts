/** Shared pure canonical Creative Direction serializer for CLI and Studio onboarding. */
export interface FoundationDraft {
  id: string
  title: string
  premise: string
  central_conflict: string
  genre: string
  tone: string
  player_experience: string
  scope: string
  decisions: Array<{
    id: string
    statement: string
    origin: 'user' | 'agent'
    authority: 'user-protected' | 'delegated'
  }>
  body: string
}
function yaml(value: string): string {
  // JSON-escaped double-quoted scalars are valid YAML 1.2 and prevent
  // unintended YAML tags, newlines, aliases, keys or implicit booleans.
  return JSON.stringify(value)
}
export function renderFoundation(draft: FoundationDraft): string {
  const decisions = draft.decisions.flatMap(d => [
    `  - id: ${d.id}`,
    `    statement: ${yaml(d.statement)}`,
    `    origin: ${d.origin}`,
    `    authority: ${d.authority}`,
  ])
  return [
    '---', "schema: '0.1'", 'type: creative-direction',
    `id: creative-direction.${draft.id}`,
    `title: ${yaml(draft.title)}`,
    'status: draft', 'decisions:', ...decisions,
    `premise: ${yaml(draft.premise)}`,
    `central_conflict: ${yaml(draft.central_conflict)}`,
    `genre: ${yaml(draft.genre)}`,
    `tone: ${yaml(draft.tone)}`,
    `player_experience: ${yaml(draft.player_experience)}`,
    `scope: ${yaml(draft.scope)}`,
    '---', '', draft.body, '',
  ].join('\n')
}
