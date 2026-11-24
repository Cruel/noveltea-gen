import type { StudioStore } from '../persistence/store'
import type { DiscoveryHandoff } from '../../../src/discovery-generation-handoff'

const stages = ['prepared', 'provider-started', 'provider-verified', 'worktree-started',
  'worktree-settled', 'foundation-started', 'foundation-settled', 'queue-started', 'queue-settled'] as const
export type HandoffStage = typeof stages[number]
export type ProviderHandoffEffect = (stage: 'provider-verified' | 'worktree-started' | 'worktree-settled') => Promise<void>
type State = { revision: number; digest: string; stage: HandoffStage }

export const handoffWorkspace = (story: string, turn: string) => 'story-discovery-handoff,' + story + ',' + turn

/** Studio's owner-scoped CAS store records the original external effect
 * boundary, not another executor or a replay permission. */
export async function readHandoffEffect(store: StudioStore, owner: string, repo: string,
  story: string, turn: string): Promise<State | null> {
  const row = await store.persistence.onboarding.conversation(owner, repo, handoffWorkspace(story, turn))
  if (!row) return null
  const state = JSON.parse(row.state) as State
  if (state.revision !== row.revision || !/^[a-f0-9]{64}$/.test(state.digest) ||
      !stages.includes(state.stage)) throw Error('Invalid Discovery handoff effect receipt.')
  return state
}

export async function handoffEffects(store: StudioStore, receipt: DiscoveryHandoff) {
  const { owner, repositoryId: repo, storyId: story, firstTurnId: turn, digest } = receipt
  const read = async () => {
    const state = await readHandoffEffect(store, owner, repo, story, turn)
    if (state && state.digest !== digest) throw Error('Original Discovery handoff effect identity changed.')
    return state
  }
  const advance = async (stage: HandoffStage) => {
    const previous = await read()
    if (previous && stages.indexOf(previous.stage) >= stages.indexOf(stage)) return
    const state = { revision: (previous?.revision ?? 0) + 1, digest, stage }
    if (!await store.persistence.onboarding.saveConversation(owner, repo, handoffWorkspace(story, turn),
      state.revision, JSON.stringify(state), previous?.revision ?? null, new Date().toISOString()))
      throw Error('Discovery handoff effect receipt changed concurrently.')
  }
  return { read, advance }
}
