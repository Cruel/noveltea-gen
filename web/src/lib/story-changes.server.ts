import { execFileSync } from 'node:child_process'
import { relative, sep } from 'node:path'
import type { JobStartResult } from '../../../src/job'

export type StoryChangeKind = 'added' | 'modified' | 'deleted'
export type StoryChange = { committed?: StoryChangeKind; uncommitted?: StoryChangeKind }
export type DeletedStoryRecord = {
  id: string | null; type: string | null; title: string; path: string; arcs: string[]; change: StoryChange
}
export type StoryChangeOverlay = {
  byPath: Record<string, StoryChange>
  deletedRecords: DeletedStoryRecord[]
  /** Safe, path-only changes not yet recognized by the native catalog. */
  unindexedRecords: Array<{ path: string; change: StoryChange }>
}

const MAX_CHANGES = 20_000
const MAX_BLOB = 512 * 1024
const MAX_HISTORICAL_LABELS = 64 // all deletions still show as paths beyond this bound
const ID = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/

function canonicalPath(path: string): boolean {
  return path.length <= 1024 && path.endsWith('.md') && !path.includes('\\') &&
    path.split('/').length >= 2 && path.split('/').every(part =>
      !!part && part !== '.' && part !== '..' && !part.startsWith('.'))
}

/** The Git process never inherits an ambient repository override. */
function git(job: JobStartResult, ...args: string[]): Buffer {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'])
    delete env[key]
  return execFileSync('git', args, {
    cwd: job.worktreeRoot, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  })
}

function relativeStory(job: JobStartResult): string {
  const story = relative(job.worktreeRoot, job.worktreeStoryRoot)
  if (story === '..' || story.startsWith('..' + sep) || story.startsWith('/') || story.includes('\\'))
    throw new Error('Story content root escaped registered job worktree')
  return story
}

function recordMetadata(markdown: string): { id: string; type: string; title: string; arcs: string[] } | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1]
  if (!front) return null
  const scalar = (key: string) => {
    const value = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(front)?.[1]?.trim() ?? ''
    return value.replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  const id = scalar('id'), type = scalar('type'), title = scalar('title')
  if (!ID.test(id) || !/^[a-z][a-z0-9-]*$/.test(type) || !id.startsWith(type + '.'))
    return null
  const inline = /^arcs:\s*\[([^\]]*)\]/m.exec(front)?.[1]
  const block = /^arcs:\s*\r?\n((?:\s+-[^\r\n]+\r?\n?)+)/m.exec(front)?.[1]
  const arcs = (inline !== undefined ? inline.split(',') :
    block ? [...block.matchAll(/^\s+-\s+(.+)$/gm)].map(m => m[1]!) : [])
    .map(value => value.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(value => ID.test(value) && value.startsWith('arc.'))
  return { id, type, title: title.slice(0, 240) || id, arcs }
}

/** Derive a label from the exact historical Git blob, never from a filename's
 * directory or invented type. Missing/malformed metadata stays path-only. */
function deletedRecord(job: JobStartResult, sha: string, fullPath: string,
  path: string, change: StoryChange, readMetadata: boolean): DeletedStoryRecord {
  let metadata: ReturnType<typeof recordMetadata> = null
  try {
    if (!readMetadata) throw new Error('Historical label budget exhausted')
    // A historical symlink (120000) is not a Markdown record. Do not read its target.
    const entry = git(job, 'ls-tree', sha, '--', ':(literal)' + fullPath).toString('utf8')
    if (entry.startsWith('100644 blob ')) {
      const blob = git(job, 'show', sha + ':' + fullPath)
      if (blob.length <= MAX_BLOB) metadata = recordMetadata(blob.toString('utf8'))
    }
  } catch { /* The deletion remains visible by path without invented metadata. */ }
  return { id: metadata?.id ?? null, type: metadata?.type ?? null,
    title: metadata?.title ?? path, path, arcs: metadata?.arcs ?? [], change }
}

/** Compare the *entire* canonical Story against its pinned base; separately
 * project the index/working-tree delta against verified HEAD. No 24-file
 * progress-log cap or speculative inference from the native catalog. */
export function storyChangeOverlay(job: JobStartResult, head: string,
  current: ReadonlyArray<{ id: string; path: string }>): StoryChangeOverlay {
  const story = relativeStory(job)
  const prefix = story ? story + '/' : ''
  const byPath: Record<string, StoryChange> = Object.create(null)
  const changed = new Set<string>()
  const set = (fullPath: string, source: keyof StoryChange, kind: StoryChangeKind) => {
    if (!fullPath.startsWith(prefix)) return
    const path = fullPath.slice(prefix.length)
    if (!canonicalPath(path)) return
    if (!changed.has(path) && changed.size >= MAX_CHANGES)
      throw new Error('Story Git changes exceed the explorer limit')
    changed.add(path)
    byPath[path] ??= {}
    byPath[path]![source] = kind
  }
  const verified = git(job, 'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff',
    job.baseSha, head, '--', story).toString('utf8').split('\0')
  for (let i = 0; i < verified.length - 1; i += 2) {
    const code = verified[i]!
    if (!['A', 'M', 'D'].includes(code)) throw new Error('Unexpected verified Git record change')
    set(verified[i + 1]!, 'committed', code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified')
  }
  // Disable rename coalescing so deletions and additions each get a visible
  // placeholder/indicator. -z handles whitespace and odd but safe filenames.
  const worktree = git(job, '-c', 'status.renames=false', 'status', '--porcelain=v1', '-z',
    '--untracked-files=all', '--', story).toString('utf8').split('\0')
  for (const entry of worktree.slice(0, -1)) {
    if (entry.length < 4) throw new Error('Malformed Git working-tree status')
    const state = entry.slice(0, 2), path = entry.slice(3)
    const kind: StoryChangeKind = state.includes('D') ? 'deleted' :
      state === '??' || state.includes('A') ? 'added' : 'modified'
    set(path, 'uncommitted', kind)
  }
  const present = new Set(current.map(record => record.path))
  const ids = new Set(current.map(record => record.id))
  const deletedRecords: DeletedStoryRecord[] = []
  let historicalLabels = 0
  for (const path of changed) {
    const change = byPath[path]!
    if (present.has(path) ||
        change.uncommitted !== 'deleted' && change.committed !== 'deleted') continue
    const source = change.uncommitted === 'deleted' ? head : job.baseSha
    const placeholder = deletedRecord(job, source, prefix + path, path, change,
      historicalLabels++ < MAX_HISTORICAL_LABELS)
    if (placeholder.id && ids.has(placeholder.id)) continue // renamed typed record
    deletedRecords.push(placeholder)
  }
  deletedRecords.sort((a, b) => a.path.localeCompare(b.path))
  const deletedPaths = new Set(deletedRecords.map(record => record.path))
  const unindexedRecords = [...changed].filter(path => !present.has(path) && !deletedPaths.has(path))
    .map(path => ({ path, change: byPath[path]! }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return { byPath, deletedRecords, unindexedRecords }
}
