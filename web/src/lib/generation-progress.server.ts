import { execFileSync } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import type { JobStartResult } from '../../../src/job'
import { generationStages } from '../../../src/generation'
import type { GenerationStage } from '../../../src/generation-plan'

export type ProgressKind = 'started' | 'working' | 'verified' | 'finished' | 'interrupted'
export type ProgressStatus = 'paused' | 'blocked' | 'completed' | 'cancelled'
export type ProgressEvent = {
  id: number; kind: ProgressKind; stage: GenerationStage | null; milestone: string | null
  files: string[]; status: ProgressStatus | null; createdAt: string
}
type EventInput = {
  kind: ProgressKind; stage?: GenerationStage; milestone?: string
  files?: string[]; status?: ProgressStatus
}
type EventRow = Omit<ProgressEvent, 'files'> & { filesJson: string }

const stageSet = new Set<string>(generationStages)
const canonicalFile = (path: string) =>
  path.length <= 1024 && path.endsWith('.md') &&
  path.split('/').length >= 2 &&
  path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'))
const canonicalMilestone = (id: string) => /^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/.test(id) && id.length <= 160

/** Only controller-authored, bounded fields enter the durable event log. */
export function appendGenerationEvent(store: StudioDatabase, owner: string, jobId: string, input: EventInput) {
  if (input.stage && !stageSet.has(input.stage)) throw new Error('Invalid progress stage')
  if (input.milestone && !canonicalMilestone(input.milestone)) throw new Error('Invalid progress milestone')
  const files = [...new Set((input.files ?? []).filter(canonicalFile))].slice(0, 24)
  store.sqlite.prepare(`INSERT INTO generation_events
    (job_id, owner_user_id, kind, stage, milestone, files_json, status, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(jobId, owner, input.kind, input.stage ?? null,
    input.milestone ?? null, JSON.stringify(files), input.status ?? null, new Date().toISOString())
}

export function listGenerationEvents(store: StudioDatabase, owner: string, jobId: string,
  after: number, limit = 100): ProgressEvent[] {
  const rows = store.sqlite.prepare(`SELECT id,kind,stage,milestone,files_json AS filesJson,
    status,created_at AS createdAt FROM generation_events
    WHERE owner_user_id=? AND job_id=? AND id>? ORDER BY id LIMIT ?`)
    .all(owner, jobId, after, Math.max(1, Math.min(100, limit))) as EventRow[]
  return rows.map(({ filesJson, ...row }) => ({ ...row, files: JSON.parse(filesJson) as string[] }))
}

/** Read the newest bounded page in chronological order. Older events are
 * addressable by cursor without requiring an unbounded initial response. */
export function recentGenerationEvents(store: StudioDatabase, owner: string, jobId: string,
  before?: number): { events: ProgressEvent[]; hasMore: boolean } {
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
    throw new Error('Invalid history cursor')
  const rows = store.sqlite.prepare(`SELECT id,kind,stage,milestone,files_json AS filesJson,
    status,created_at AS createdAt FROM generation_events
    WHERE owner_user_id=? AND job_id=? AND id<? ORDER BY id DESC LIMIT 101`)
    .all(owner, jobId, before ?? Number.MAX_SAFE_INTEGER) as EventRow[]
  const hasMore = rows.length > 100
  return { events: rows.slice(0, 100).reverse().map(({ filesJson, ...row }) => ({
    ...row, files: JSON.parse(filesJson) as string[],
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
    assertStudioSchemaCurrent(store)
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
        const poll = () => {
          if (closed) return
          try {
            if ((c.desiredSize ?? 0) <= 0) {
              // A disconnected or slow client must not accumulate unlimited
              // buffered events while the durable log keeps growing.
              timer = setTimeout(poll, 600)
              return
            }
            const rows = listGenerationEvents(store, user.id, jobId, after, c.desiredSize ?? 1)
            for (const event of rows) {
              after = event.id
              c.enqueue(encoder.encode(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`))
            }
            // Heartbeats keep reverse proxies and EventSource reconnects healthy.
            if (++ticks % 25 === 0) c.enqueue(encoder.encode(': heartbeat\n\n'))
          } catch { close(); return }
          timer = setTimeout(poll, rowsAvailableSooner(store, user.id, jobId, after) ? 0 : 600)
        }
        poll()
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

function rowsAvailableSooner(store: StudioDatabase, owner: string, id: string, after: number): boolean {
  return !!store.sqlite.prepare(`SELECT 1 FROM generation_events
    WHERE owner_user_id=? AND job_id=? AND id>? LIMIT 1`).get(owner, id, after)
}
