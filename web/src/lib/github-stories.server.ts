import { randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent } from '../db/migrations'
import { actorFor, errorResponse, github, GithubError, json, matchingRepository } from './github-repositories.server'

// The cap applies to uncompressed Git blobs at a single pinned commit, not
// repository history, Git transfer size, or the eventual worktree disk quota.
export const STORY_LIMIT_BYTES = 100_000_000
const MAX_TREE_REQUESTS = 400
const MAX_BLOBS_TO_INSPECT = 1000
const MAX_ATTRIBUTES_TO_INSPECT = 100
const LFS_POINTER_MAX_BYTES = 2048
const shaPattern = /^[a-f0-9]{40}$/i
const canonicalDirs = new Set([
  'creative-direction', 'arcs', 'milestones', 'events', 'beats', 'characters',
  'world-entities', 'facts', 'relationships', 'revelations', 'choices', 'puzzles',
])

type TreeEntry = { path: string; type: string; mode: string; sha: string; size?: number }
type GithubTree = { sha: string; tree: TreeEntry[]; truncated: boolean }
type GitCommit = { sha: string; tree?: { sha: string }; commit?: { tree?: { sha: string } } }
type TreeReader = {
  tree(sha: string, recursive?: boolean): Promise<GithubTree>
  blob(sha: string): Promise<string>
}
type GitBlob = { content: string; encoding: string; size: number; truncated?: boolean }
type GitDirectory = { name: string; path: string }
type Snapshot = { commit: string; root: string; repository: string }

function badTree(): never {
  throw new GithubError(422, 'GitHub tree metadata is incomplete or unsupported; Story size cannot be verified.')
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && shaPattern.test(value)
}

function directoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) throw new GithubError(400, 'Invalid Story directory')
  const path = value.replace(/\/$/, '')
  if (path === '') return ''
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part =>
    !part || part === '.' || part === '..' || part === '.git' || /[\x00-\x1f\x7f]/.test(part))) {
    throw new GithubError(400, 'Invalid Story directory')
  }
  return path
}

function checkEntry(entry: TreeEntry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path ||
      entry.path.split('/').some(p => !p || p === '.' || p === '..') ||
      !validSha(entry.sha) || typeof entry.mode !== 'string' || typeof entry.type !== 'string') badTree()
}

// Unsupported objects elsewhere in a monorepo do not affect a Story's size.
// Only the selected subtree must be entirely ordinary trees and sized blobs.
function supportedStoryEntry(entry: TreeEntry) {
  if (entry.type === 'tree' && entry.mode === '040000') return
  if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755') &&
      Number.isSafeInteger(entry.size) && entry.size! >= 0) return
  // Reject symlinks (120000), submodules (160000), unknown modes and sizes.
  badTree()
}

function checkTree(body: GithubTree, sha: string) {
  if (!body || !Array.isArray(body.tree) || !validSha(body.sha) || body.sha.toLowerCase() !== sha.toLowerCase() ||
      typeof body.truncated !== 'boolean') badTree()
  const seen = new Set<string>()
  for (const entry of body.tree) {
    checkEntry(entry)
    if (seen.has(entry.path)) badTree()
    seen.add(entry.path)
  }
  return body
}

function makeReader(token: string, repository: string): TreeReader {
  let budget = 0
  return {
    async tree(sha, recursive = false) {
      if (!validSha(sha)) badTree()
      if (++budget > MAX_TREE_REQUESTS) throw new GithubError(422, 'Too many Git trees to verify. Select a narrower Story directory.')
      const result = await github<GithubTree>(token, `/repos/${repository}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`)
      return checkTree(result, sha)
    },
    async blob(sha) {
      if (!validSha(sha)) badTree()
      const result = await github<GitBlob>(token, `/repos/${repository}/git/blobs/${sha}`)
      if (result.encoding !== 'base64' || typeof result.content !== 'string' ||
          !Number.isSafeInteger(result.size) || result.truncated) badTree()
      const data = Buffer.from(result.content.replace(/\s/g, ''), 'base64')
      if (data.byteLength !== result.size) badTree()
      return data.toString('utf8')
    },
  }
}

async function snapshot(token: string, name: string, requestedCommit: string | null): Promise<Snapshot> {
  // Only a verified catalog repository is used to construct provider paths.
  // A new browse pins the default branch to a commit; subsequent navigation
  // and selection must carry that immutable SHA.
  let commit: GitCommit
  if (requestedCommit !== null) {
    if (!validSha(requestedCommit)) throw new GithubError(400, 'Invalid pinned commit')
    commit = await github<GitCommit>(token, `/repos/${name}/git/commits/${requestedCommit}`)
    if (commit.sha !== requestedCommit || !validSha(commit.tree?.sha)) badTree()
    return { commit: commit.sha, root: commit.tree.sha, repository: name }
  }
  const metadata = await github<{ default_branch: string }>(token, `/repos/${name}`)
  if (!metadata || typeof metadata.default_branch !== 'string' || !metadata.default_branch ||
      metadata.default_branch.length > 250) badTree()
  commit = await github<GitCommit>(token, `/repos/${name}/commits/${encodeURIComponent(metadata.default_branch)}`)
  if (!validSha(commit?.sha) || !validSha(commit.commit?.tree?.sha)) badTree()
  return { commit: commit.sha, root: commit.commit.tree.sha, repository: name }
}

async function followDirectory(reader: TreeReader, root: string, path: string) {
  let current = root
  for (const part of path ? path.split('/') : []) {
    const page = await reader.tree(current)
    if (page.truncated) badTree()
    const child = page.tree.find(entry => entry.path === part)
    if (!child || child.type !== 'tree' || child.mode !== '040000') {
      throw new GithubError(404, 'Story directory does not exist at this commit.')
    }
    current = child.sha
  }
  return current
}

async function isStory(reader: TreeReader, sha: string): Promise<boolean> {
  const root = await reader.tree(sha)
  if (root.truncated) badTree()
  for (const entry of root.tree) {
    if (!canonicalDirs.has(entry.path) || entry.type !== 'tree') continue
    supportedStoryEntry(entry)
    const contents = await reader.tree(entry.sha)
    if (contents.truncated) badTree()
    if (contents.tree.some(file => file.type === 'blob' && file.path.endsWith('.md'))) return true
  }
  return false
}

async function listDirectory(reader: TreeReader, sha: string, directory: string) {
  const page = await reader.tree(sha)
  if (page.truncated) badTree()
  const directories: GitDirectory[] = page.tree.filter(item => item.type === 'tree')
    .map(item => ({ name: item.path, path: [directory, item.path].filter(Boolean).join('/') }))
  return { directories, isStory: await isStory(reader, sha) }
}

async function discover(reader: TreeReader, root: string) {
  // For ordinary repositories a single recursive Tree API response identifies
  // candidates without downloading even one Git blob. GitHub may truncate it
  // for large repositories: resume via bounded, nonrecursive directory walks.
  const response = await reader.tree(root, true)
  if (!response.truncated) {
    const files = response.tree.filter(item => item.type === 'blob' && item.path.endsWith('.md'))
    const roots = new Set<string>()
    for (const entry of files) {
      const parts = entry.path.split('/')
      if (parts.length < 2 || !canonicalDirs.has(parts[parts.length - 2]!)) continue
      roots.add(parts.slice(0, -2).join('/'))
    }
    return [...roots].sort()
  }
  const roots = new Set<string>()
  const queue = [{ sha: root, path: '' }]
  while (queue.length) {
    const { sha, path } = queue.shift()!
    const page = await reader.tree(sha)
    if (page.truncated) badTree()
    // A discovered root can contain nested Story directories; do not skip
    // traversal after a match.
    if (await isStory(reader, sha)) roots.add(path)
    for (const entry of page.tree) {
      if (entry.type === 'tree') queue.push({ sha: entry.sha, path: [path, entry.path].filter(Boolean).join('/') })
    }
  }
  return [...roots].sort()
}

async function allBlobs(reader: TreeReader, root: string) {
  const response = await reader.tree(root, true)
  if (!response.truncated) {
    response.tree.forEach(supportedStoryEntry)
    return response.tree.filter(entry => entry.type === 'blob')
  }
  const blobs: TreeEntry[] = []
  const queue = [root]
  while (queue.length) {
    const page = await reader.tree(queue.shift()!)
    if (page.truncated) badTree()
    for (const entry of page.tree) {
      supportedStoryEntry(entry)
      if (entry.type === 'tree') queue.push(entry.sha)
      else blobs.push(entry)
    }
  }
  return blobs
}

// Git Trees expose only pointer-file sizes for LFS. Inspect applicable Git
// attributes at every ancestor and within the selected subtree. Reject any
// selected LFS-tracked file, even if its pointer has nonstandard extra fields.
function matchesAttributePattern(pattern: string, relative: string): boolean {
  // Unsupported pattern syntax is an uncertainty, not an allow decision.
  if (!pattern || ['[', ']', '{', '}', '\\', '!'].some(char => pattern.includes(char)) ||
      pattern.endsWith('/')) badTree()
  const anchored = pattern.includes('/')
  const input = pattern.startsWith('/') ? pattern.slice(1) : pattern
  let regex = '^'
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === '*' && input[i + 1] === '*' && input[i + 2] === '/') {
      regex += '(?:.*/)?'; i += 2
    } else if (c === '*' && input[i + 1] === '*') {
      regex += '.*'; i++
    } else if (c === '*') regex += '[^/]*'
    else if (c === '?') regex += '[^/]'
    else if ('.+^$()|'.includes(c)) regex += '\\' + c
    else regex += c
  }
  regex += '$'
  const target = anchored ? relative : relative.split('/').at(-1)!
  return new RegExp(regex).test(target)
}

async function checkLfsAttributes(reader: TreeReader, root: string, directory: string, blobs: TreeEntry[]) {
  const attrs = new Map<string, TreeEntry>()
  let current = root
  let prefix = ''
  const parts = directory ? directory.split('/') : []
  for (const part of [...parts, '']) {
    const page = await reader.tree(current)
    if (page.truncated) badTree()
    const attr = page.tree.find(e => e.path === '.gitattributes')
    if (attr) attrs.set([prefix, '.gitattributes'].filter(Boolean).join('/'), attr)
    if (!part) break
    const next = page.tree.find(e => e.path === part)
    if (!next || next.type !== 'tree' || next.mode !== '040000') badTree()
    current = next.sha
    prefix = [prefix, part].filter(Boolean).join('/')
  }
  for (const blob of blobs) {
    if (blob.path === '.gitattributes' || blob.path.endsWith('/.gitattributes')) {
      attrs.set([directory, blob.path].filter(Boolean).join('/'), blob)
    }
  }
  if (attrs.size > MAX_ATTRIBUTES_TO_INSPECT) {
    throw new GithubError(422, 'Too many Git attributes files to verify safely.')
  }
  const paths = blobs.map(blob => [directory, blob.path].filter(Boolean).join('/'))
  for (const [path, attr] of attrs) {
    supportedStoryEntry(attr)
    if (attr.size! > 65_536) {
      throw new GithubError(422, 'Git attributes are too large to verify LFS tracking safely.')
    }
    const contents = await reader.blob(attr.sha)
    const base = path.slice(0, -'.gitattributes'.length).replace(/\/$/, '')
    for (const line of contents.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const words = trimmed.split(/\s+/)
      if (!words.slice(1).includes('filter=lfs')) continue
      const pattern = words[0]!
      for (const file of paths) {
        if (base && !file.startsWith(base + '/')) continue
        const relative = base ? file.slice(base.length + 1) : file
        if (matchesAttributePattern(pattern, relative)) {
          throw new GithubError(422, 'Git LFS tracking applies to Story files; underlying sizes cannot be verified.')
        }
      }
    }
  }
}

async function preflight(reader: TreeReader, root: string, directory: string, sha: string) {
  if (!await isStory(reader, sha)) {
    throw new GithubError(422, 'Selected directory has no canonical Story Markdown records.')
  }
  const blobs = await allBlobs(reader, sha)
  let bytes = 0
  const small: TreeEntry[] = []
  for (const entry of blobs) {
    bytes += entry.size!
    if (!Number.isSafeInteger(bytes) || bytes > STORY_LIMIT_BYTES) {
      throw new GithubError(422, 'Story exceeds the 100 MB uncompressed Git-blob limit.')
    }
    if (entry.size! <= LFS_POINTER_MAX_BYTES) small.push(entry)
  }
  if (small.length > MAX_BLOBS_TO_INSPECT) {
    throw new GithubError(422, 'Too many small blobs to exclude Git LFS pointers safely.')
  }
  await checkLfsAttributes(reader, root, directory, blobs)
  // A Git LFS pointer's Git-blob size is not the underlying content size.
  // Refuse the selection rather than silently counting a ~130-byte pointer.
  for (const entry of small) {
    const content = await reader.blob(entry.sha)
    if (content.startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new GithubError(422, 'Git LFS content detected; underlying Story size cannot be verified.')
    }
  }
  return { sizeBytes: bytes, limitBytes: STORY_LIMIT_BYTES, blobCount: blobs.length }
}

export async function githubStoryRequest(
  auth: StudioAuth, store: StudioDatabase, request: Request, baseURL: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== baseURL) {
    return json({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    const actor = await actorFor(auth, store, request.headers)
    if (actor instanceof Response) return actor
    const params = request.method === 'GET' ? new URL(request.url).searchParams : null
    const body = request.method === 'POST' ? await request.json().catch(() => null) : null
    const repositoryId = params?.get('repositoryId') ?? body?.repositoryId
    const directory = directoryPath(params?.get('directory') ?? body?.directory ?? '')
    if (typeof repositoryId !== 'string' || !/^[a-f0-9-]{36}$/i.test(repositoryId)) {
      throw new GithubError(400, 'Invalid repository ID')
    }
    const row = store.sqlite.prepare(`SELECT name FROM repositories
      WHERE id=? AND owner_user_id=? AND provider='github'`)
      .get(repositoryId, actor.id) as { name: string } | undefined
    if (!row) throw new GithubError(404, 'GitHub repository not connected.')
    if (request.method === 'POST') assertStudioSchemaCurrent(store)
    // A catalog row alone is not current authorization: GitHub installation
    // selection, membership or push rights may have been revoked.
    await matchingRepository(actor.token, row.name)
    const pinned = params?.get('commit') ?? body?.commit ?? null
    if (pinned !== null && typeof pinned !== 'string') throw new GithubError(400, 'Invalid pinned commit')
    if (request.method === 'POST' && !pinned) throw new GithubError(400, 'Select a pinned commit before importing a Story')
    const revision = await snapshot(actor.token, row.name, pinned)
    const reader = makeReader(actor.token, revision.repository)
    if (request.method === 'GET' && params?.get('mode') === 'discover') {
      return json({ commit: revision.commit, stories: await discover(reader, revision.root) })
    }
    const tree = await followDirectory(reader, revision.root, directory)
    if (request.method === 'GET') {
      return json({ commit: revision.commit, directory, ...await listDirectory(reader, tree, directory) })
    }
    const result = await preflight(reader, revision.root, directory, tree)
    const now = new Date().toISOString()
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(repository_id,directory) DO UPDATE SET
        title=excluded.title,source_commit_sha=excluded.source_commit_sha`)
      .run(randomUUID(), actor.id, repositoryId, directory,
        directory.split('/').filter(Boolean).at(-1) || row.name, now, revision.commit)
    const story = store.sqlite.prepare(`SELECT id,directory,title,source_commit_sha AS commitSha
      FROM stories WHERE repository_id=? AND owner_user_id=? AND directory=?`)
      .get(repositoryId, actor.id, directory) as { id: string; title: string; directory: string; commitSha: string }
    return json({ story: { id: story.id, title: story.title, directory: story.directory, commit: story.commitSha }, ...result })
  } catch (error) { return errorResponse(error) }
}
