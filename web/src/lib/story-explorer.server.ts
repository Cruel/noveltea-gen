import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { requireUser } from './access.server'
import { authorizedStoryJob } from './fixture-jobs.server'
import { validateStoryJob } from '../../../src/validator'

type RecordMetadata = { id?: unknown; type?: unknown; title?: unknown; status?: unknown;
  arcs?: unknown; fulfillment?: unknown }
type CatalogRecord = { path?: unknown; metadata?: RecordMetadata }
type Diagnostic = { path?: unknown; line?: unknown; column?: unknown; code?: unknown; message?: unknown }

export interface ExplorerRecord {
  id: string
  type: string
  title: string
  status: string
  path: string
  /** Canonical arcs from native metadata; no inference from mount directories. */
  arcs: string[]
  /** Canonical Event references from Milestone fulfillment alternatives. */
  events: string[]
}
export interface ExplorerDiagnostic {
  path?: string; line?: number; column?: number; code: string; message: string
}
export interface ExplorerIndex {
  records: ExplorerRecord[]
  diagnostics: ExplorerDiagnostic[]
  validation: 'passed' | 'rejected' | 'unverified'
  protection: string
  readiness: unknown
  baseSha: string
  headSha: string
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_RECORD_SIZE = 512 * 1024
const MAX_RECORDS = 10_000
const MAX_DIAGNOSTICS = 2_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

class ExplorerError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** A relative canonical Story record path, never a host path, inbox, or dotfile.
 * The registered Story root is the only filesystem access boundary. */
function canonicalPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') ||
      value.startsWith('/') || !value.endsWith('.md')) return false
  const parts = value.split('/')
  return parts.length >= 2 && parts.every(part => part && part !== '.' && part !== '..' &&
    !part.startsWith('.') && part !== '.story-inbox')
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string =>
    typeof id === 'string' && /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/.test(id)) : []
}
function eventReferences(value: unknown): string[] {
  const alternatives = (value as { any_of?: unknown } | null)?.any_of
  return Array.isArray(alternatives)
    ? [...new Set(alternatives.flatMap((option: unknown) => ids(option)).filter(id => id.startsWith('event.')))]
    : []
}

export function canonicalExplorerIndex(report: Record<string, unknown>, baseSha: string,
  headSha: string, validation: ExplorerIndex['validation']): ExplorerIndex {
  if (!Array.isArray(report.records) || !Array.isArray(report.diagnostics) ||
      report.records.length > MAX_RECORDS || report.diagnostics.length > MAX_DIAGNOSTICS ||
      !report.protection || typeof report.protection !== 'object') {
    throw new ExplorerError(409, 'Canonical Story validation returned an incomplete or oversized catalog.')
  }
  const records: ExplorerRecord[] = []
  const seen = new Set<string>()
  for (const value of report.records as CatalogRecord[]) {
    const meta = value.metadata
    if (!canonicalPath(value.path) || !meta ||
        typeof meta.id !== 'string' || !/^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/.test(meta.id) ||
        typeof meta.type !== 'string' ||
        !/^[a-z][a-z0-9-]*$/.test(meta.type) ||
        !meta.id.startsWith(meta.type + '.') || seen.has(meta.id)) {
      throw new ExplorerError(409, 'Canonical Story index contains an invalid, unsafe, or duplicate typed record.')
    }
    seen.add(meta.id)
    records.push({
      id: meta.id, type: meta.type, path: value.path,
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.slice(0, 240) : meta.id,
      status: typeof meta.status === 'string' ? meta.status.slice(0, 80) : 'unknown',
      arcs: ids(meta.arcs), events: eventReferences(meta.fulfillment),
    })
  }
  const diagnostics: ExplorerDiagnostic[] = []
  for (const diag of report.diagnostics as Diagnostic[]) {
    if (!diag || typeof diag.code !== 'string' || typeof diag.message !== 'string') {
      throw new ExplorerError(409, 'Canonical Story diagnostics are malformed.')
    }
    // Never relay paths outside the canonical record tree, even if the native
    // validator someday reports errors in sibling trusted-author files.
    if (diag.path !== undefined && !canonicalPath(diag.path)) continue
    diagnostics.push({
      ...(typeof diag.path === 'string' ? { path: diag.path } : {}),
      ...(Number.isSafeInteger(diag.line) && (diag.line as number) > 0 ? { line: diag.line as number } : {}),
      ...(Number.isSafeInteger(diag.column) && (diag.column as number) > 0 ? { column: diag.column as number } : {}),
      code: diag.code.slice(0, 120), message: diag.message.slice(0, 2000),
    })
  }
  const protection = report.protection as { status?: unknown }
  return { records, diagnostics, validation,
    protection: typeof protection.status === 'string' ? protection.status : 'unverified',
    readiness: report.readiness ?? null, baseSha, headSha }
}

/** Check every path component without following symlinks, including the
 * last file; content is read ONLY after selecting an indexed typed ID. */
async function readCanonicalMarkdown(root: string, path: string): Promise<string> {
  if (!canonicalPath(path)) throw new ExplorerError(409, 'Unsafe canonical record path.')
  let current = root
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new ExplorerError(409, 'Story content root is not a real directory.')
  const segments = path.split('/')
  for (const [index, part] of segments.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() ||
        (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()))
      throw new ExplorerError(409, 'Story record contains a symlink or unsupported filesystem entry.')
    if (index === segments.length - 1 && info.size > MAX_RECORD_SIZE)
      throw new ExplorerError(413, 'Story record exceeds the read-only viewer size limit.')
  }
  const rel = relative(root, current)
  if (rel === '..' || rel.startsWith('..' + sep))
    throw new ExplorerError(409, 'Story record escaped its registered content root.')
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const [info, resolvedRoot, resolvedFile] = await Promise.all([
      file.stat(), realpath(root), realpath(current),
    ])
    if (!info.isFile() || info.size > MAX_RECORD_SIZE ||
        !resolvedFile.startsWith(resolvedRoot + sep)) {
      throw new ExplorerError(409, 'Record no longer resolves inside the canonical Story content root.')
    }
    const data = await file.readFile()
    if (data.byteLength > MAX_RECORD_SIZE) throw new ExplorerError(413, 'Story record exceeds the viewer size limit.')
    return data.toString('utf8')
  } finally { await file.close() }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
}

/** Owner-scoped read-only canonical explorer. id is a typed Story ID, NOT a
 * path; no client-originated path, Git revision or native CLI option is used. */
export async function storyExplorerRequest(auth: StudioAuth, store: StudioDatabase,
  request: Request, jobId: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405)
  try {
    assertStudioSchemaCurrent(store)
    const user = await requireUser(auth, request.headers)
    if (!user) throw new ExplorerError(401, 'Sign in required.')
    if (!uuid.test(jobId)) throw new ExplorerError(400, 'Invalid job ID.')
    const job = await authorizedStoryJob(store, user.id, jobId)
    const result = await validateStoryJob(job)
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[key]
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.worktreeRoot,
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (currentHead !== job.headSha)
      throw new ExplorerError(409, 'Job revision changed during validation. Refresh the Story explorer.')
    if (result.status === 'error' || !result.report) {
      throw new ExplorerError(409, 'Pinned canonical Story validator is unavailable or returned an invalid report. ' +
        'Restore the original validator and job state before browsing.')
    }
    const index = canonicalExplorerIndex(result.report, job.baseSha, job.headSha, result.status)
    const params = new URL(request.url).searchParams
    if ([...params.keys()].some(key => key !== 'id') || params.getAll('id').length > 1)
      throw new ExplorerError(400, 'Only an indexed typed Story ID may be selected.')
    const id = params.get('id')
    if (!id) {
      if (Buffer.byteLength(JSON.stringify(index)) > MAX_RESPONSE_BYTES)
        throw new ExplorerError(413, 'Canonical Story catalog exceeds the explorer response limit.')
      return json({ index })
    }
    const selected = index.records.find(record => record.id === id)
    if (!selected) throw new ExplorerError(404, 'Record ID is not present in the canonical Story index.')
    const markdown = await readCanonicalMarkdown(job.worktreeStoryRoot, selected.path)
    return json({ record: selected, markdown, headSha: index.headSha })
  } catch (error) {
    if (error instanceof ExplorerError) return json({ error: error.message }, error.status)
    if (error instanceof Error && 'status' in error &&
        typeof error.status === 'number' && error.status >= 400 && error.status < 500)
      return json({ error: error.message }, error.status)
    console.error('[Studio Story explorer] Unable to inspect registered Story', error instanceof Error ? error.stack : String(error))
    return json({ error: 'Story explorer could not verify its registered worktree and validator. Reconcile the saved job state.' }, 409)
  }
}
