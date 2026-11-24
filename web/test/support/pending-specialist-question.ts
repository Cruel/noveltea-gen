// HTTP/queue boundary fixture only. The production Pi/Git regression is
// R14I production World question in test/generation.test.ts.
import { Annotation, StateGraph, START, END } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createGenerationQuestionGraph } from '../../../src/generation-author-question'
import { assignmentChildConfig, type AssignmentIdentity } from '../../../src/generation-assignment-lifecycle'
import { SpecialistChoiceRequiredError, inspectSpecialistChoice, type SpecialistChoiceReceipt } from '../../../src/specialist-choice'
import type { JobStartResult } from '../../../src/job'
import { openWebGenerationGraph } from '../../../src/web-fixture-runtime'

export async function stagePendingQuestion(job: JobStartResult, thread: string,
  choice: SpecialistChoiceReceipt, source?: Record<string, unknown>) {
  const path = join(job.stateDir, 'web-generation.sqlite')
  // Preserve the pinned request and inspected fields for the API-only
  // fixture, but replace the prior test question's completed journal.
  let initial = source
  if (!initial) {
    const { saver, graph } = openWebGenerationGraph(path)
    try { initial = (await graph.getState({ configurable: { thread_id: thread } })).values }
    finally { saver.db.close() }
  }
  const turnDigest = (initial?.request as { turnPlanDigest?: string } | undefined)?.turnPlanDigest ?? 'a'.repeat(64)
  const state = { ...initial, request: { ...(initial?.request as object), turnPlanDigest: turnDigest },
    status: 'running', planVersion: initial?.planVersion || 1 }
  const identity: AssignmentIdentity = {
    schema: 'noveltea-assignment-identity/v1', jobId: job.jobId, jobThreadId: job.threadId,
    graphThreadId: thread, turnDigest, assignmentId: choice.workItem,
    planVersion: Number(state.planVersion), sourceHeadSha: choice.headSha,
    scopeDigest: createHash('sha256').update(choice.id).digest('hex'),
  }
  rmSync(path, { force: true })
  const saver = SqliteSaver.fromConnString(path)
  try {
    const channels = Annotation.Root(Object.fromEntries(Object.keys(state).map(key => [key, Annotation<unknown>()])))
    const child = createGenerationQuestionGraph(job, identity, choice.workItem, {
      preflight: async () => null,
      invoke: async () => { throw new SpecialistChoiceRequiredError() },
      verify: async () => { throw Error('HTTP fixture must not invoke a writer') },
    })
    const graph = new StateGraph(channels)
      .addNode('specialist_dispatch', async (_state, config) => {
        await child.invoke({ identity, submission: null, submissionKey: null,
          outcome: null, continuationRef: null }, assignmentChildConfig(config, identity))
        return {}
      }).addEdge(START, 'specialist_dispatch').addEdge('specialist_dispatch', END)
      .compile({ checkpointer: saver })
    await graph.invoke(state, { configurable: { thread_id: thread }, durability: 'sync' })
    return await inspectSpecialistChoice(job, choice.id)
  } finally { saver.db.close() }
}
