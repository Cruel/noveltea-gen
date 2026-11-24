import { Annotation, Command, END, interrupt, START, StateGraph, type StateSnapshot } from '@langchain/langgraph'
import type { StudioDiscoveryCheckpoints } from '../persistence/discovery-checkpoints'

export type DiscoveryOperation = Readonly<{
  id: number
  kind: 'start' | 'restart' | 'answer' | 'revise' | 'retry' | 'approve'
  from: string | null
  inputDigest: string
}>
export type DiscoveryGate = Readonly<{
  phase: 'questions' | 'proposed' | 'approved' | 'blocked'
  ref: string
  operationId: number
}>
type DiscoveryAdapter = {
  authenticate(operation: DiscoveryOperation, gate: DiscoveryGate | null): Promise<void>
  execute(operation: DiscoveryOperation): Promise<DiscoveryGate>
}
const Channels = Annotation.Root({
  identity: Annotation<string>(),
  operation: Annotation<DiscoveryOperation>(),
  gate: Annotation<DiscoveryGate | null>({ reducer: (_, next) => next, default: () => null }),
})

/** A separate Studio-owned graph. The state holds only operation and gate
 * references; questions, accepted answers and proposals remain in Studio.
 * Only a genuine pending author interrupt accepts Command(resume). */
export function discoveryGraph(identity: string, saver: StudioDiscoveryCheckpoints,
  adapter: DiscoveryAdapter) {
  const graph = new StateGraph(Channels)
    .addNode('execute_round', async state => {
      if (state.identity !== identity) throw Error('Discovery execution identity changed')
      await adapter.authenticate(state.operation, null)
      const gate = await adapter.execute(state.operation)
      if (gate.operationId !== state.operation.id) throw Error('Discovery result belongs to another operation')
      return { gate }
    })
    .addNode('await_author', async state => {
      if (state.identity !== identity || !state.gate || state.gate.phase === 'approved')
        throw Error('Invalid Discovery author interrupt')
      const operation = interrupt<DiscoveryGate, DiscoveryOperation>(state.gate)
      if (!operation || operation.from !== state.gate.ref)
        throw Error('Stale Discovery author interrupt')
      await adapter.authenticate(operation, state.gate)
      return { operation, gate: null }
    })
    .addEdge(START, 'execute_round')
    .addConditionalEdges('execute_round', state => state.gate?.phase === 'approved' ? END : 'await_author',
      [END, 'await_author'])
    .addEdge('await_author', 'execute_round')
    .compile({ checkpointer: saver })
  const config = { configurable: { thread_id: identity }, durability: 'sync' as const,
    recursionLimit: 12 }

  async function state() {
    return graph.getState(config)
  }
  function waiting(saved: StateSnapshot, ref: string | null) {
    return saved.next.length === 1 && saved.next[0] === 'await_author' &&
      saved.values.gate?.ref === ref && saved.tasks.some(task =>
        task.name === 'await_author' && task.interrupts.length === 1 &&
        (task.interrupts[0]?.value as DiscoveryGate | undefined)?.ref === ref)
  }
  async function advance(operation: DiscoveryOperation, fresh: boolean) {
    const saved = await state()
    if (fresh) {
      if (saved.values.identity || operation.from !== null) throw Error('Discovery graph already exists')
      await graph.invoke({ identity, operation, gate: null }, config)
    } else {
      if (saved.values.identity !== identity || !waiting(saved, operation.from))
        throw Error('No matching pending Discovery author interrupt')
      await graph.invoke(new Command({ resume: operation }), config)
    }
    return state()
  }
  async function reconcile(operation: DiscoveryOperation, expected: DiscoveryGate, unstarted = false) {
    let saved = await state()
    if (!saved.values.identity && unstarted && operation.from === null &&
        expected.phase === 'blocked' && (operation.kind === 'start' || operation.kind === 'restart')) {
      // Explicit reconciliation proved no invocation was claimed before the
      // initial checkpoint. Materialize its blocked receipt, not a Pi effect.
      saved = await advance(operation, true)
    }
    if (saved.values.identity !== identity)
      throw Error('Discovery checkpoint is missing or belongs to another execution')
    // A Studio receipt can be durable before the next graph checkpoint.
    // Replay only the already-settled reference, never a model invocation.
    if (saved.values.gate?.ref !== expected.ref) {
      if (saved.next.length === 1 && saved.next[0] === 'execute_round' &&
          saved.values.operation?.id === operation.id) {
        await graph.invoke(null, config)
        saved = await state()
      } else if (waiting(saved, operation.from)) {
        saved = await advance(operation, false)
      }
    }
    // A crash may persist execute_round's return before await_author ran.
    // Complete that purely referential node; only a real interrupt can resume.
    if (expected.phase !== 'approved' && saved.values.gate?.ref === expected.ref &&
        saved.next.length === 1 && saved.next[0] === 'await_author' &&
        !waiting(saved, expected.ref)) {
      await graph.invoke(null, config)
      saved = await state()
    }
    if (saved.values.gate?.ref !== expected.ref || saved.values.gate?.phase !== expected.phase ||
        (expected.phase === 'approved' ? saved.next.length !== 0 : !waiting(saved, expected.ref)))
      throw Error('Discovery Studio receipt and checkpoint do not agree')
    return saved
  }
  return { advance, reconcile }
}
