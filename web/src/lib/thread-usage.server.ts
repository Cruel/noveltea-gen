import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { JobStartResult } from '../../../src/job'
import { inspectPiPolicy, type PiBudgetUsage, type PiPolicy } from '../../../src/job-pi-policy'
import type { SavedGenerationJob } from '../persistence/generation-contracts'
import type { UsageRunRecord } from '../persistence/conversation-contracts'
import type { StudioStore } from '../persistence/store'
import { restoreJob } from './fixture-jobs.server'

export type UsageOrigin = 'pi-transcript' | 'retained-summary' | 'fixture' | 'prepared' | 'unavailable'
/** Retain only numeric accounting and the provenance category after physical
 * execution cleanup. Never retain transcript, model prompts, file paths, or credentials. */
export type RunUsageSnapshot = {
  version: 1; origin: UsageOrigin
  limits: PiPolicy['limits'] | null; spent: PiBudgetUsage | null
}
export type RunUsage = RunUsageSnapshot & {
  jobId: string; threadId: string; runOrder: number; status: string; deleted: boolean
}
export type UsageAggregate = {
  runs: number; unavailableRuns: number; modelCalls: number; steps: number;
  costUsd: number; unpricedCalls: number; unknownTokenCalls: number;
  tokens: PiBudgetUsage['tokens'];
}
export type StoryUsage = { storyId: string; total: UsageAggregate;
  threads: Array<{ threadId: string; total: UsageAggregate; runs: RunUsage[] }> }

const emptyUsage = (): PiBudgetUsage => ({
  steps: 0, modelCalls: 0, costUsd: 0, unpricedCalls: 0,
  unknownTokenCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
const emptyAggregate = (): UsageAggregate => ({
  runs: 0, unavailableRuns: 0, steps: 0, modelCalls: 0, costUsd: 0,
  unpricedCalls: 0, unknownTokenCalls: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

function requestOrigin(requestJson: string | null): UsageOrigin {
  if (requestJson === null) return 'prepared'
  try {
    const request = JSON.parse(requestJson) as { fixture?: unknown } | null
    if (typeof request?.fixture !== 'boolean') return 'unavailable'
    return request.fixture ? 'fixture' : 'pi-transcript'
  } catch { return 'unavailable' }
}

export async function snapshotJobUsage(row: Pick<SavedGenerationJob, 'requestJson'>,
  job: JobStartResult): Promise<RunUsageSnapshot> {
  const origin = requestOrigin(row.requestJson)
  if (origin === 'unavailable') return unavailable()
  if (origin === 'fixture' || origin === 'prepared')
    return { version: 1, origin, limits: null, spent: emptyUsage() }
  // inspectPiPolicy defaults missing budget state to an empty counter for
  // first-run admission. Reporting must not treat absent evidence as zero spend.
  if (!existsSync(join(job.stateDir, 'pi-budget.json'))) return unavailable()
  const { policy, budget } = await inspectPiPolicy(job)
  return { version: 1, origin, limits: policy.limits, spent: budget }
}

const validUsageNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const validCount = (value: unknown): value is number =>
  validUsageNumber(value) && Number.isSafeInteger(value)

function validMeter(value: unknown): value is PiBudgetUsage {
  if (!value || typeof value !== 'object') return false
  const spent = value as Partial<PiBudgetUsage>
  return validCount(spent.steps) && validCount(spent.modelCalls) &&
    validUsageNumber(spent.costUsd) && validCount(spent.unpricedCalls) &&
    validCount(spent.unknownTokenCalls) && !!spent.tokens &&
    (['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      .every(name => validCount(spent.tokens?.[name]))
}

function retainedSnapshot(row: UsageRunRecord): RunUsageSnapshot | null {
  if (!row.deletionPlanJson) return null
  try {
    const plan = JSON.parse(row.deletionPlanJson) as {
      usageSummaries?: Record<string, RunUsageSnapshot>
    }
    const snapshot = plan.usageSummaries?.[row.jobId]
    if (snapshot?.version !== 1 ||
        !['pi-transcript', 'fixture', 'prepared', 'unavailable'].includes(snapshot.origin) ||
        (snapshot.spent !== null && !validMeter(snapshot.spent))) return null
    return snapshot
  } catch { return null }
}

function unavailable(): RunUsageSnapshot {
  return { version: 1, origin: 'unavailable', limits: null, spent: null }
}

/** Pure accumulation by job ID. Parent/child Thread edges and copied messages
 * do not represent model executions; they must never add to the totals. */
export function aggregateUsage(runs: readonly RunUsage[]): UsageAggregate {
  const total = emptyAggregate()
  const seen = new Set<string>()
  for (const run of runs) {
    if (seen.has(run.jobId)) continue
    seen.add(run.jobId)
    total.runs++
    if (!run.spent) { total.unavailableRuns++; continue }
    const u = run.spent
    total.steps += u.steps
    total.modelCalls += u.modelCalls
    total.costUsd += u.costUsd
    total.unpricedCalls += u.unpricedCalls
    total.unknownTokenCalls += u.unknownTokenCalls
    for (const name of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      total.tokens[name] += u.tokens[name]
  }
  return total
}

/** Owner-derived Story and Run membership come exclusively from the persistence
 * port. Missing offline cache state is reported as unknown, not fabricated zero. */
export async function inspectStoryUsage(store: StudioStore, owner: string, storyId: string): Promise<StoryUsage> {
  if (!await store.persistence.conversations.story(owner, storyId)) throw new Error('Story not found.')
  await store.persistence.conversations.reconcileRoots(owner, storyId)
  const rows = await store.persistence.conversations.usageRuns(owner, storyId)
  const runs = await Promise.all(rows.map(async row => {
    let snapshot: RunUsageSnapshot
    if (row.deletedAt) {
      const retained = retainedSnapshot(row)
      snapshot = retained ? { ...retained, origin: 'retained-summary' } : unavailable()
    } else if (requestOrigin(row.requestJson) !== 'pi-transcript') {
      const origin = requestOrigin(row.requestJson)
      snapshot = origin === 'unavailable' ? unavailable() :
        { version: 1, origin, limits: null, spent: emptyUsage() }
    } else {
      try {
        const saved = await store.persistence.generation.jobs.selected(owner, row.jobId)
        snapshot = saved ? await snapshotJobUsage(saved, await restoreJob(saved, owner)) : unavailable()
      } catch {
        snapshot = unavailable()
      }
    }
    return { ...snapshot, jobId: row.jobId, threadId: row.threadId,
      runOrder: row.runOrder, status: row.status, deleted: row.deletedAt !== null } satisfies RunUsage
  }))
  const grouped = new Map<string, RunUsage[]>()
  for (const run of runs) {
    const group = grouped.get(run.threadId) ?? []
    group.push(run)
    grouped.set(run.threadId, group)
  }
  return { storyId, total: aggregateUsage(runs),
    threads: [...grouped].map(([threadId, items]) =>
      ({ threadId, total: aggregateUsage(items), runs: items })) }
}
