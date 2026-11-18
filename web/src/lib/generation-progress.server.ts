import { execFileSync } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioStore as StudioDatabase } from '../persistence/store'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import type { JobStartResult } from '../../../src/job'
import { generationStages } from '../../../src/generation'
import type { GenerationStage } from '../../../src/generation-plan'
import type { PiWorkStatus } from '../../../src/pi-work-status'

export type ProgressKind = 'started' | 'working' | 'verified' | 'finished' | 'interrupted'
export type ProgressStatus = 'paused' | 'blocked' | 'completed' | 'cancelled'
/** Controller event provenance cannot be supplied by Pi. Only the status
 * reporter sets source=pi, with no verified SHA, diagnostics or review claim. */
export type ProgressDetail = {
  source: 'controller' | 'pi'
  specialist?: string
  turnId?: string
  headSha?: string
  changedRecordIds?: string[]
  validation?: 'passed' | 'rejected' | 'unverified' | 'error'
  diagnostics?: number
  outcome?: string
  review?: 'complete-in-scope' | 'incomplete' | 'blocked'
  summary?: string
  proposedPaths?: string[]
}
export type ProgressEvent = {
  id: number; kind: ProgressKind; stage: GenerationStage | null; milestone: string | null
  files: string[]; status: ProgressStatus | null; createdAt: string
  detail?: ProgressDetail
}
type EventInput = {
  kind: ProgressKind; stage?: GenerationStage; milestone?: string
  files?: string[]; status?: ProgressStatus
  headSha?: string; outcome?: string; specialist?: string; turnId?: string
  changedRecordIds?: string[]; validation?: ProgressDetail['validation']; diagnostics?: number
  piStatus?: PiWorkStatus
}

const stageSet = new Set<string>(generationStages)
const canonicalFile = (path: string) =>
  path.length <= 1024 && !path.includes('\\') && !path.startsWith('/') && path.endsWith('.md') &&
  path.split('/').length >= 2 &&
  path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'))
const canonicalMilestone = (id: string) => /^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/.test(id) && id.length <= 160

/** Only controller-authored, bounded fields enter the durable event log. */
export async function appendGenerationEvent(store: StudioDatabase, owner: string, jobId: string, input: EventInput) {
  if (input.stage && !stageSet.has(input.stage)) throw new Error('Invalid progress stage')
  if (input.milestone && !canonicalMilestone(input.milestone)) throw new Error('Invalid progress milestone')
  if (input.piStatus && (input.kind !== 'working' || input.files?.length || input.headSha ||
      input.outcome || input.specialist || input.status || input.changedRecordIds?.length ||
      input.validation || input.diagnostics !== undefined))
    throw new Error('Model status cannot claim controller evidence')
  if (input.headSha && !/^[a-f0-9]{40}$/i.test(input.headSha))
    throw new Error('Invalid verified progress SHA')
  if (input.diagnostics !== undefined && (!Number.isSafeInteger(input.diagnostics) ||
      input.diagnostics < 0 || input.diagnostics > 2_000))
    throw new Error('Invalid progress diagnostic count')
  const files = [...new Set((input.files ?? []).filter(canonicalFile))].slice(0, 24)
  const changedRecordIds = [...new Set((input.changedRecordIds ?? [])
    .filter(id => /^[a-z0-9][a-z0-9.-]{0,159}$/.test(id)))].slice(0, 24)
  const detail: ProgressDetail = input.piStatus ? {
    source: 'pi', summary: input.piStatus.summary,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    proposedPaths: input.piStatus.proposedPaths.filter(canonicalFile).slice(0, 12),
  } : {
    source: 'controller',
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(changedRecordIds.length ? { changedRecordIds } : {}),
    ...(input.validation ? { validation: input.validation } : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    ...(input.specialist ? { specialist: input.specialist.slice(0, 160) } : {}),
    ...(input.headSha ? { headSha: input.headSha } : {}),
    ...(input.outcome ? { outcome: input.outcome.slice(0, 160) } : {}),
    ...(input.kind === 'verified' && input.stage === 'review' &&
      (input.outcome === 'complete-in-scope' || input.outcome === 'incomplete' ||
        input.outcome === 'blocked') ? { review: input.outcome } : {}),
  }
  await store.persistence.generation.events.append(owner, jobId, {
    kind: input.kind, stage: input.stage ?? null, milestone: input.milestone ?? null,
    filesJson: JSON.stringify({ files, detail }), status: input.status ?? null,
    createdAt: new Date().toISOString(),
  })
}

/** Historical rows used a bare file array. Preserve them as controller
 * evidence without inventing a verified SHA or an independent review. */
export function decodeProgressFiles(value: string): { files: string[]; detail?: ProgressDetail } {
  const parsed: unknown = JSON.parse(value)
  if (Array.isArray(parsed)) return { files: parsed as string[] }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid persisted progress payload')
  const payload = parsed as { files?: unknown; detail?: ProgressDetail }
  if (!Array.isArray(payload.files) || !payload.files.every(path => typeof path === 'string'))
    throw new Error('Invalid persisted progress files')
  return { files: payload.files, detail: payload.detail }
}

export async function listGenerationEvents(store: StudioDatabase, owner: string, jobId: string,
  after: number, limit = 100): Promise<ProgressEvent[]> {
  const rows = await store.persistence.generation.events.after(
    owner, jobId, after, Math.max(1, Math.min(100, limit)))
  return rows.map(({ filesJson, ...row }) => ({
    ...row, stage: row.stage as GenerationStage | null, status: row.status as ProgressStatus | null,
    ...decodeProgressFiles(filesJson),
  }))
}

/** Read the newest bounded page in chronological order. Older events are
 * addressable by cursor without requiring an unbounded initial response. */
export async function recentGenerationEvents(store: StudioDatabase, owner: string, jobId: string,
  before?: number): Promise<{ events: ProgressEvent[]; hasMore: boolean }> {
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
    throw new Error('Invalid history cursor')
  const rows = await store.persistence.generation.events.recent(
    owner, jobId, before ?? Number.MAX_SAFE_INTEGER, 101)
  const hasMore = rows.length > 100
  return { events: rows.slice(0, 100).reverse().map(({ filesJson, ...row }) => ({
    ...row, stage: row.stage as GenerationStage | null, status: row.status as ProgressStatus | null,
    ...decodeProgressFiles(filesJson),
  })), hasMore }
}

/** Filenames are canonical Story-relative paths between committed revisions,
 * not untrusted working-tree output or arbitrary host paths. This does not
 * expose diff contents, validation internals, or private Pi tool transcripts. */
export function committedStoryFiles(job: JobStartResult, before: string, after: string): string[] {
  if (before === after) return []
  const storyPath = relative(job.worktreeRoot, job.worktreeStoryRoot)
  if (storyPath === '..' || storyPath.startsWith('..' + sep) || storyPath.startsWith('/'))
    throw new Error('Story root escaped job worktree')
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
  const buffer = execFileSync('git', ['diff', '--name-only', '-z', '--no-ext-diff', before, after,
    '--', storyPath], { cwd: job.worktreeRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 })
  const prefix = storyPath === '' ? '' : storyPath + '/'
  return [...new Set(buffer.toString('utf8').split('\0')
    .filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length))
    .filter(canonicalFile))].slice(0, 24)
}

function parseCursor(value: string | null): number | null {
  if (value === null) return 0
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Authenticated SSE GET. Last-Event-ID survives automatic browser reconnect;
 * after= allows clients to resume explicitly. Never accept user-supplied job paths. */
export async function generationEventsRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, jobId: string): Promise<Response> {
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 })
  try {
    await store.assertReady()
    const user = await requireUser(auth, request.headers)
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 })
    await authorizedStoryJob(store, user.id, jobId)
    const cursor = parseCursor(request.headers.get('last-event-id') ??
      new URL(request.url).searchParams.get('after'))
    if (cursor === null) return Response.json({ error: 'Invalid event cursor' }, { status: 400 })
    const encoder = new TextEncoder()
    let after = cursor
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const close = () => {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      request.signal.removeEventListener('abort', close)
      try { controller?.close() } catch { /* client disconnected */ }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
        request.signal.addEventListener('abort', close, { once: true })
        if (request.signal.aborted) { close(); return }
        let ticks = 0
        const poll = async () => {
          if (closed) return
          try {
            if ((c.desiredSize ?? 0) <= 0) {
              // A disconnected or slow client must not accumulate unlimited
              // buffered events while the durable log keeps growing.
              timer = setTimeout(() => void poll(), 600)
              return
            }
            const rows = await listGenerationEvents(store, user.id, jobId, after, c.desiredSize ?? 1)
            for (const event of rows) {
              if (closed) return
              after = event.id
              c.enqueue(encoder.encode(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`))
            }
            // Heartbeats keep reverse proxies and EventSource reconnects healthy.
            if (++ticks % 25 === 0) c.enqueue(encoder.encode(': heartbeat\n\n'))
            if (closed) return
            const hasPending = await rowsAvailableSooner(store, user.id, jobId, after)
            if (!closed) timer = setTimeout(() => void poll(), hasPending ? 0 : 600)
          } catch { close() }
        }
        void poll()
      },
      cancel() { close() },
    })
    return new Response(stream, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    } })
  } catch (error) {
    const status = error instanceof Error && 'status' in error &&
      typeof error.status === 'number' ? error.status : 409
    return Response.json({ error: 'Could not authorize or restore generation progress' },
      { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

async function rowsAvailableSooner(store: StudioDatabase, owner: string, id: string, after: number): Promise<boolean> {
  return store.persistence.generation.events.hasAfter(owner, id, after)
}
