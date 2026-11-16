/** Shared pure canonical Creative Direction serializer for CLI and Studio onboarding. */
import { parseStoryPlanning, type StoryPlanning } from './story-planning.js'

export interface FoundationDraft {
  id: string
  title: string
  premise: string
  central_conflict: string
  genre: string
  tone: string
  player_experience: string
  scope: string
  planning?: StoryPlanning
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
/** Check the authored Creative Direction's decision provenance without treating body prose as metadata.
 * The canonical validator separately checks the YAML and decision schema. */
export function hasUserProtectedDecision(record: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(record)
  if (!match) return false
  const frontmatter = match[1]!
  const decisions = /^decisions:\s*\r?\n((?:[ \t]+.*\r?\n)*)/m.exec(frontmatter)?.[1]
  if (!decisions) return false
  // YAML permits plain, single-quoted and double-quoted enum scalars.
  // The validator checks the full schema separately; this guard only detects
  // paired provenance fields on the same canonical decision item.
  return decisions.split(/\r?\n(?=  - id:)/).some(block =>
    /^    origin:[ \t]*(?:user|"user"|'user')[ \t]*$/m.test(block) &&
    /^    authority:[ \t]*(?:user-protected|"user-protected"|'user-protected')[ \t]*$/m.test(block))
}

export function renderFoundation(draft: FoundationDraft, status: 'draft' | 'approved' = 'draft'): string {
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
    `status: ${status}`, 'decisions:', ...decisions,
    `premise: ${yaml(draft.premise)}`,
    `central_conflict: ${yaml(draft.central_conflict)}`,
    `genre: ${yaml(draft.genre)}`,
    `tone: ${yaml(draft.tone)}`,
    `player_experience: ${yaml(draft.player_experience)}`,
    `scope: ${yaml(draft.scope)}`,
    ...(draft.planning ? [`planning: ${JSON.stringify(parseStoryPlanning(draft.planning))}`] : []),
    '---', '', draft.body, '',
  ].join('\n')
}
