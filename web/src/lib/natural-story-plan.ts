import { createHash } from 'node:crypto'
import { generationStages, parseGenerationContract } from '../../../src/generation'
import type { GenerationStage } from '../../../src/generation-plan'
import type { CompletionContract } from '../../../src/architecture'

export type PlanEdits = {
  presentation?: string
  constraints?: string[]
  hardLimits?: string[]
  preferences?: string[]
}
export type NaturalStoryPlan = {
  task: string
  contract: CompletionContract
  stages: Array<{ id: GenerationStage; description: string; dependsOn: GenerationStage[] }>
  reviewRequired: boolean
  clarification: string | null
  digest: string
}

// Planned stages are obligations, not evidence that a specialist has completed
// them. Individual Milestone work items are determined only from the verified
// architecture and canonical catalog after execution starts.
const fullStoryStages: NaturalStoryPlan['stages'] = [
  { id: 'foundation', dependsOn: [], description: 'Creative Direction and narrative goals' },
  { id: 'architecture', dependsOn: ['foundation'], description: 'Arcs, Milestones and dependencies' },
  { id: 'foundations', dependsOn: ['architecture'], description: 'World and Character foundations' },
  { id: 'event', dependsOn: ['foundations'], description: 'Causal Events for each Milestone' },
  { id: 'interactive', dependsOn: ['event'], description: 'Choices and interactive narrative' },
  { id: 'composition', dependsOn: ['interactive'], description: 'Authored scenes and dialogue' },
  { id: 'review', dependsOn: ['composition'], description: 'Independent narrative and scope review' },
]

const printable = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const boundedLines = (input: unknown, label: string): string[] => {
  if (!Array.isArray(input) || input.length > 16 ||
      input.some(value => typeof value !== 'string' || !value.trim() ||
        value.length > 1000 || !printable(value))) {
    throw new Error(label + ' must contain at most 16 printable lines of 1–1000 characters.')
  }
  return input.map((item: string) => item.trim())
}
function defaultConstraints(task: string) {
  // Include the complete brief in the typed completion contract, even when a
  // natural-language request does not use formal "constraint" terminology.
  return task.match(/[\s\S]{1,850}/g)!.map(chunk => 'Honor this author brief: ' + chunk)
}
function reviewReason(task: string) {
  if (/\b(?:outline|synopsis|pitch|brainstorm|idea list|only plan|just plan|not a full story)\b/i.test(task))
    return 'This sounds like an outline or ideation request rather than a fully authored Story. Confirm full-Story composition, or use advanced generation settings for bounded scope.'
  if (/\b(?:not sure|undecided|maybe instead|or perhaps)\b/i.test(task))
    return 'The requested direction has alternatives. Confirm that NovelTea should compose a full Story from this brief.'
  if (/\?$/.test(task))
    return 'This reads as a question. Confirm that you want NovelTea to generate a complete Story.'
  return null
}

/** Conservative initial/full-Story interpretation. A partial or focused
 * revision is NEVER inferred here: those require a separate scoped contract.
 * The controller, not the model or browser, remains the write authority. */
export function interpretNaturalStoryPrompt(input: unknown, edits: PlanEdits = {}): NaturalStoryPlan {
  if (typeof input !== 'string' || !input.trim() || input.length > 4000 ||
      !printable(input)) throw new Error('Describe your Story in 1–4000 printable characters.')
  const task = input.trim()
  if (!edits || typeof edits !== 'object' || Array.isArray(edits) ||
      Object.keys(edits).some(key => !['presentation', 'constraints', 'hardLimits', 'preferences'].includes(key))) {
    throw new Error('Unknown plan edits. Full-Story write scope cannot be changed here.')
  }
  const presentation = edits.presentation ?? 'Complete interactive visual-novel Story with authored scenes, dialogue, meaningful choices and coherent branch outcomes'
  if (typeof presentation !== 'string' || !presentation.trim() ||
      presentation.length > 2000 || !printable(presentation))
    throw new Error('Presentation must be printable text of 1–2000 characters.')
  const contract = parseGenerationContract({
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: edits.constraints === undefined ? defaultConstraints(task) : boundedLines(edits.constraints, 'Constraints'),
    envelope: {
      presentation: presentation.trim(),
      hardLimits: edits.hardLimits === undefined ? [] : boundedLines(edits.hardLimits, 'Hard limits'),
      preferences: edits.preferences === undefined ? [] : boundedLines(edits.preferences, 'Preferences'),
    },
  })
  // The preview's executable stage inventory must stay in sync with the
  // trusted generation graph. Missing, reordered or cyclic stages block
  // admission rather than advertising an invented plan.
  const required = generationStages.filter(stage => stage !== 'focus')
  const ordered = new Set<GenerationStage>()
  for (const [index, stage] of fullStoryStages.entries()) {
    if (stage.id !== required[index] || stage.dependsOn.some(parent => !ordered.has(parent)))
      throw new Error('The full-Story execution plan is not compatible with the generation graph.')
    ordered.add(stage.id)
  }
  if (ordered.size !== required.length)
    throw new Error('The full-Story execution plan has missing or duplicated stages.')
  const clarification = reviewReason(task)
  const digest = createHash('sha256').update(JSON.stringify({ task, contract, stages: fullStoryStages })).digest('hex')
  return { task, contract, stages: fullStoryStages, reviewRequired: !!clarification, clarification, digest }
}
