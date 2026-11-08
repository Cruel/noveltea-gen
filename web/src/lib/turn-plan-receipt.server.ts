import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { assertTurnPlan, verifyTurnPlan, type TurnPlan } from './turn-plan'

const file = (job: JobStartResult) => join(job.stateDir, 'turn-plan.json')

/** Immutable per-execution Turn intent. A crash leaves an inspectable receipt;
 * a retry must reuse the identical request/base/assignments, never rewrite it. */
export async function saveJobTurnPlan(job: JobStartResult, plan: TurnPlan): Promise<void> {
  verifyTurnPlan(plan)
  if (job.baseSha !== plan.source.verifiedSha)
    throw new Error('Turn plan base is not the exact pinned Git source revision.')
  const payload = JSON.stringify(plan, null, 2) + '\n'
  try {
    await writeFile(file(job), payload, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readJobTurnPlan(job)
    if (!existing) throw new Error('Turn plan receipt disappeared during admission.')
    assertTurnPlan(existing, plan)
  }
}

export async function readJobTurnPlan(job: JobStartResult): Promise<TurnPlan | null> {
  let raw: string
  try { raw = await readFile(file(job), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let plan: TurnPlan
  try { plan = JSON.parse(raw) as TurnPlan }
  catch { throw new Error('Persisted Turn plan is corrupt.') }
  verifyTurnPlan(plan)
  if (plan.source.verifiedSha !== job.baseSha)
    throw new Error('Persisted Turn plan belongs to a different source Git revision.')
  return plan
}
