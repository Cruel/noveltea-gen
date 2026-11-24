import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { StudioStore } from '../persistence/store'
import type { DiscoveryHandoff } from '../../../src/discovery-generation-handoff'

const stages = ['prepared', 'provider-started', 'provider-verified', 'worktree-started',
  'worktree-settled', 'foundation-started', 'foundation-settled', 'queue-started', 'queue-settled'] as const
export type HandoffStage = typeof stages[number]
export type ProviderHandoffEffect = (stage: 'provider-verified' | 'worktree-started' | 'worktree-settled') => Promise<void>
type Lease = { host: string; pid: number; nonce: string }
type State = { revision: number; digest: string; stage: HandoffStage; lease?: Lease }

function dead(lease: Lease) {
  if (lease.host !== hostname()) return false
  try { process.kill(lease.pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

export const handoffWorkspace = (story: string, turn: string) => 'story-discovery-handoff,' + story + ',' + turn

/** Studio's owner-scoped CAS store records the original external effect
 * boundary, not another executor or a replay permission. */
export async function readHandoffEffect(store: StudioStore, owner: string, repo: string,
  story: string, turn: string): Promise<State | null> {
  const row = await store.persistence.onboarding.conversation(owner, repo, handoffWorkspace(story, turn))
  if (!row) return null
  const state = JSON.parse(row.state) as State
  if (state.revision !== row.revision || !/^[a-f0-9]{64}$/.test(state.digest) ||
      !stages.includes(state.stage) || (state.lease && (!state.lease.host ||
        !Number.isSafeInteger(state.lease.pid) || state.lease.pid <= 0 ||
        !/^[a-f0-9-]{36}$/.test(state.lease.nonce)))) throw Error('Invalid Discovery handoff effect receipt.')
  return state
}

export async function handoffEffects(store: StudioStore, receipt: DiscoveryHandoff) {
  const { owner, repositoryId: repo, storyId: story, firstTurnId: turn, digest } = receipt
  const read = async () => {
    const state = await readHandoffEffect(store, owner, repo, story, turn)
    if (state && state.digest !== digest) throw Error('Original Discovery handoff effect identity changed.')
    return state
  }
  const lease: Lease = { host: hostname(), pid: process.pid, nonce: randomUUID() }
  const save = async (previous: State | null, stage: HandoffStage, nextLease?: Lease) => {
    const state: State = { revision: (previous?.revision ?? 0) + 1, digest, stage, lease: nextLease }
    return store.persistence.onboarding.saveConversation(owner, repo, handoffWorkspace(story, turn),
      state.revision, JSON.stringify(state), previous?.revision ?? null, new Date().toISOString())
  }
  const claim = async () => {
    const previous = await read()
    if (previous?.lease && !dead(previous.lease)) return null
    return await save(previous, previous?.stage ?? 'prepared', lease) ? { previous } : null
  }
  const advance = async (stage: HandoffStage) => {
    const previous = await read()
    if (previous?.lease?.nonce !== lease.nonce)
      throw Error('Discovery handoff no longer owns its original admission.')
    if (stages.indexOf(previous.stage) >= stages.indexOf(stage)) return
    if (!await save(previous, stage, lease))
      throw Error('Discovery handoff effect receipt changed concurrently.')
  }
  const release = async () => {
    const previous = await read()
    if (previous?.lease?.nonce === lease.nonce && !await save(previous, previous.stage))
      throw Error('Discovery handoff admission changed concurrently.')
  }
  return { read, claim, advance, release }
}
