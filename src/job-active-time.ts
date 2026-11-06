import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { JobStartResult } from './job.js'

type Meter = { version: 1; elapsedMs: number }
type Active = { baseMs: number; start: number; failure?: Error }
const active = new Map<string, Active>()
const path = (job: JobStartResult) => join(job.stateDir, 'pi-active-time.json')

async function saved(job: JobStartResult): Promise<number> {
  let value: Meter
  try { value = JSON.parse(await readFile(path(job), 'utf8')) as Meter }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw new Error('Corrupt or unreadable durable Pi execution-time meter.')
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0)
    throw new Error('Invalid persisted Pi execution-time meter.')
  return value.elapsedMs
}
async function persist(job: JobStartResult, elapsedMs: number) {
  await mkdir(dirname(path(job)), { recursive: true })
  const temporary = path(job) + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify({ version: 1, elapsedMs: Math.ceil(elapsedMs) }) + '\n',
    { mode: 0o600, flag: 'wx' })
  await rename(temporary, path(job))
}

/** Only a live controller process may add ongoing elapsed time. A killed
 * worker leaves its last durable heartbeat, never bills author-approval
 * waiting or process downtime, and resumes the same cumulative meter. */
export async function observedActiveSeconds(job: JobStartResult): Promise<number> {
  const running = active.get(job.stateDir)
  if (running?.failure) throw running.failure
  const ms = running
    ? running.baseMs + Math.max(0, performance.now() - running.start)
    : await saved(job)
  return ms / 1000
}

export async function withActiveExecutionTime<T>(job: JobStartResult, work: () => Promise<T>): Promise<T> {
  if (active.has(job.stateDir)) throw new Error('Pi execution-time meter is already active for this job.')
  const entry: Active = { baseMs: await saved(job), start: performance.now() }
  active.set(job.stateDir, entry)
  let pending = Promise.resolve()
  const record = () => {
    pending = pending.then(() => persist(job, entry.baseMs + Math.max(0, performance.now() - entry.start)))
      .catch(error => { entry.failure = error instanceof Error ? error : new Error('Pi execution-time meter failed.') })
  }
  record()
  const interval = setInterval(record, 1000)
  interval.unref()
  try {
    const result = await work()
    if (entry.failure) throw entry.failure
    return result
  } finally {
    clearInterval(interval)
    record()
    await pending
    active.delete(job.stateDir)
    if (entry.failure) throw entry.failure
  }
}
