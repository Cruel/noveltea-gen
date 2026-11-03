import { randomUUID } from 'node:crypto'
import type { StudioAuth } from './auth'
import type { StudioDatabase } from '../db/connection'
import { assertStudioSchemaCurrent, StudioSchemaError } from '../db/migrations'
import { actor, eligible, failure, gitlab, page, ProviderFailure, reply } from './gitlab-repositories.server'
import { CANONICAL_RECORD_DIRS, STORY_LIMIT_BYTES } from './story-discovery.shared'

const SHA = /^[a-f\d]{40}$/i
const PAGE_SIZE = 100
const MAX_API_REQUESTS = 800
const MAX_FILES = 5000
const MAX_SMALL_BLOBS = 1000
const MAX_ATTR_FILES = 100
const MAX_ATTR_SIZE = 65_536
const POINTER_SIZE = 2048
type Entry = { id: string; name: string; type: string; path: string; mode: string }
type FileEntry = Entry & { type: 'blob' }
type Listing = { entries: Entry[]; dirs: Array<{ name: string; path: string }>; isStory: boolean }
type Project = { default_branch?: string; path_with_namespace: string; archived: boolean; empty_repo?: boolean }
type GraphBlobs = { data?: { project?: { repository?: { blobs?: { nodes?: Array<{ path: string; size: number }> } } } }; errors?: unknown[] }

function invalid(reason: string): never { throw new ProviderFailure(422, reason) }
function validSha(value: unknown): value is string { return typeof value === 'string' && SHA.test(value) }
function directoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) throw new ProviderFailure(400, 'Invalid Story directory')
  const path = value.replace(/\/$/, '')
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part =>
    (path && !part) || part === '.' || part === '..' || part === '.git' || /[\x00-\x1f\x7f]/.test(part))) {
    throw new ProviderFailure(400, 'Invalid Story directory')
  }
  return path
}
function supported(entry: Entry) {
  if (entry.type === 'tree' && entry.mode === '040000') return
  if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) return
  invalid('Selected Story contains unsupported Git objects (symlinks or submodules).')
}
function inspectEntries(raw: unknown, directory: string): Entry[] {
  if (!Array.isArray(raw) || raw.length > PAGE_SIZE) invalid('GitLab returned invalid tree pagination metadata.')
  const seen = new Set<string>()
  return raw.map(entry => {
    if (!entry || typeof entry !== 'object' || !validSha(entry.id) ||
      typeof entry.name !== 'string' || !entry.name || entry.name.includes('/') ||
      typeof entry.path !== 'string' || entry.path !== [directory, entry.name].filter(Boolean).join('/') ||
      typeof entry.mode !== 'string' || typeof entry.type !== 'string' ||
      entry.name === '.' || entry.name === '..' || /[\x00-\x1f\x7f]/.test(entry.name) ||
      seen.has(entry.path)) invalid('GitLab returned inconsistent tree metadata.')
    seen.add(entry.path)
    return entry as Entry
  })
}
function remoteError(status: number): never {
  if (status === 401) throw new ProviderFailure(409, 'GitLab access expired. Reconnect GitLab.')
  if (status === 403) throw new ProviderFailure(403, 'GitLab denied repository access.')
  if (status === 404) throw new ProviderFailure(404, 'GitLab repository path or revision was not found.')
  if (status === 429) throw new ProviderFailure(503, 'GitLab rate limit reached. Retry later.')
  throw new ProviderFailure(502, 'GitLab returned an unexpected response while checking the Story.')
}
class Reader {
  private calls = 0
  private trees = new Map<string, Entry[]>()
  constructor(readonly token: string, readonly projectId: number, readonly commit: string) {}
  private budget() {
    if (++this.calls > MAX_API_REQUESTS) invalid('Too many GitLab metadata requests to verify this Story.')
  }
  private async request(path: string, init?: RequestInit) {
    this.budget()
    let response: Response
    try {
      response = await fetch('https://gitlab.com/api' + (path === '/graphql' ? path : '/v4' + path), {
        ...init,
        headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json', ...init?.headers },
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
    } catch { throw new ProviderFailure(502, 'Could not contact GitLab. Retry later.') }
    if (!response.ok) remoteError(response.status)
    return response
  }
  private fileUrl(path: string) {
    return `/projects/${this.projectId}/repository/files/${encodeURIComponent(path)}?ref=${this.commit}`
  }
  async tree(directory: string): Promise<Entry[]> {
    if (this.trees.has(directory)) return this.trees.get(directory)!
    const entries: Entry[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= MAX_API_REQUESTS; page++) {
      const url = `/projects/${this.projectId}/repository/tree?ref=${this.commit}&path=${encodeURIComponent(directory)}&per_page=${PAGE_SIZE}&page=${page}`
      const response = await this.request(url)
      let body: unknown
      try { body = await response.json() } catch { invalid('GitLab returned invalid tree JSON.') }
      const batch = inspectEntries(body, directory)
      for (const entry of batch) {
        if (seen.has(entry.path)) invalid('GitLab returned duplicate tree entries across pages.')
        seen.add(entry.path)
        entries.push(entry)
      }
      const nextRaw = response.headers.get('x-next-page')
      if (nextRaw && (!/^[1-9]\d*$/.test(nextRaw) || Number(nextRaw) !== page + 1)) {
        invalid('GitLab returned invalid pagination metadata.')
      }
      if (nextRaw || batch.length === PAGE_SIZE) continue
      this.trees.set(directory, entries)
      return entries
    }
    invalid('GitLab tree pagination exceeds the metadata request budget.')
  }
  async head(entry: FileEntry): Promise<number> {
    const response = await this.request(this.fileUrl(entry.path), { method: 'HEAD' })
    const size = response.headers.get('x-gitlab-size')
    if (!size || !/^(0|[1-9]\d*)$/.test(size) || !Number.isSafeInteger(Number(size)) ||
      response.headers.get('x-gitlab-blob-id')?.toLowerCase() !== entry.id.toLowerCase() ||
      response.headers.get('x-gitlab-commit-id')?.toLowerCase() !== this.commit.toLowerCase() ||
      (response.headers.get('x-gitlab-ref') && response.headers.get('x-gitlab-ref')!.toLowerCase() !== this.commit.toLowerCase())) {
      invalid('GitLab file metadata is incomplete or not pinned to the selected commit.')
    }
    return Number(size)
  }
  async content(entry: FileEntry, expectedSize: number): Promise<string> {
    const result = await this.request(this.fileUrl(entry.path))
    let body: any
    try { body = await result.json() } catch { invalid('GitLab returned invalid file JSON.') }
    if (!body || body.encoding !== 'base64' || typeof body.content !== 'string' ||
      body.blob_id?.toLowerCase() !== entry.id.toLowerCase() ||
      body.commit_id?.toLowerCase() !== this.commit.toLowerCase() ||
      body.file_path !== entry.path || body.size !== expectedSize) {
      invalid('GitLab file content cannot be verified against the selected commit.')
    }
    const encoded = body.content.replace(/\s/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('GitLab returned malformed Base64 content.')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length !== expectedSize) invalid('GitLab returned inconsistent Git blob content.')
    return bytes.toString('utf8')
  }
  async sizes(files: FileEntry[], fullPath: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>()
    // GraphQL obtains size metadata in bounded batches, without downloading blobs.
    // A GraphQL schema/availability failure uses the verified HEAD fallback.
    const query = `query($fullPath: ID!, $ref: String!, $paths: [String!]!) {
      project(fullPath: $fullPath) { repository { blobs(paths: $paths, ref: $ref) { nodes { path size } } } }
    }`
    for (let offset = 0; offset < files.length; offset += 100) {
      const batch = files.slice(offset, offset + 100)
      let metadata: Map<string, number> | null = null
      try {
        const response = await this.request('/graphql', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { fullPath, ref: this.commit, paths: batch.map(file => file.path) } }),
        })
        const value = await response.json() as GraphBlobs
        const nodes = value.data?.project?.repository?.blobs?.nodes
        if ((!value.errors || (Array.isArray(value.errors) && value.errors.length === 0)) &&
          Array.isArray(nodes) && nodes.length === batch.length) {
          const received = new Map<string, number>()
          for (const node of nodes) {
            if (!node || typeof node.path !== 'string' || !Number.isSafeInteger(node.size) || node.size < 0 ||
              received.has(node.path) || !batch.some(file => file.path === node.path)) {
              received.clear(); break
            }
            received.set(node.path, node.size)
          }
          if (received.size === batch.length) metadata = received
        }
      } catch (error) {
        // A denied/expired token must not be masked as a metadata fallback.
        if (error instanceof ProviderFailure && [403, 409, 503].includes(error.status)) throw error
      }
      for (const file of batch) {
        // A HEAD response always verifies the returned blob ID and commit.
        // GraphQL sizes are already pinned via the immutable ref.
        sizes.set(file.path, metadata?.get(file.path) ?? await this.head(file))
      }
    }
    return sizes
  }
}
async function authorizedProject(token: string, projectId: number) {
  for (let n = 1; n <= 100; n++) {
    const result = await page(token, n)
    if (!Array.isArray(result.data)) invalid('GitLab returned an invalid membership list.')
    const project = result.data.find(p => p.id === projectId && eligible(p))
    if (project) return project
    if (!result.next) break
    if (n === 100) throw new ProviderFailure(503, 'Too many projects to verify access safely.')
  }
  throw new ProviderFailure(403, 'Project is no longer among your writable GitLab projects.')
}
async function commitSnapshot(token: string, projectId: number, pinned: string | null) {
  if (pinned && !validSha(pinned)) throw new ProviderFailure(400, 'Invalid pinned commit.')
  const project = (await gitlab<Project>(token, `/projects/${projectId}`)).data
  if (!project || project.empty_repo || !project.default_branch) {
    throw new ProviderFailure(409, 'GitLab repository has no commits. Create an initial commit before browsing Stories.')
  }
  const ref = pinned ?? project.default_branch
  const commit = (await gitlab<{ id: string }>(token, `/projects/${projectId}/repository/commits/${encodeURIComponent(ref)}`)).data
  if (!validSha(commit?.id) || (pinned && pinned.toLowerCase() !== commit.id.toLowerCase())) {
    invalid('GitLab returned an unverified commit ID.')
  }
  return commit.id
}
async function isStory(reader: Reader, directory: string): Promise<boolean> {
  const children = await reader.tree(directory)
  for (const entry of children) {
    if (entry.type !== 'tree' || !CANONICAL_RECORD_DIRS.has(entry.name)) continue
    supported(entry)
    if ((await reader.tree(entry.path)).some(child => child.type === 'blob' && child.name.endsWith('.md'))) return true
  }
  return false
}
async function discover(reader: Reader) {
  const result = new Set<string>()
  const queue = ['']
  while (queue.length) {
    const directory = queue.shift()!
    const entries = await reader.tree(directory)
    if (await isStory(reader, directory)) result.add(directory)
    for (const entry of entries) if (entry.type === 'tree') queue.push(entry.path)
    if (queue.length > MAX_API_REQUESTS) invalid('GitLab discovery is too large; browse the selected directory instead.')
  }
  return [...result].sort()
}
async function selectedBlobs(reader: Reader, directory: string) {
  const files: FileEntry[] = []
  const queue = [directory]
  while (queue.length) {
    const entries = await reader.tree(queue.shift()!)
    for (const entry of entries) {
      supported(entry)
      if (entry.type === 'tree') queue.push(entry.path)
      else files.push(entry as FileEntry)
      if (files.length > MAX_FILES) invalid('Too many Story files to verify safely.')
    }
  }
  return files
}
function matchPattern(pattern: string, file: string): boolean {
  if (!pattern || /[\[\]{}\\!]/.test(pattern) || pattern.endsWith('/')) {
    invalid('Unsupported Git LFS attributes pattern; Story size is uncertain.')
  }
  const anchored = pattern.includes('/')
  const input = pattern.replace(/^\//, '')
  let re = '^'
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === '*' && input.slice(i, i + 3) === '**/') { re += '(?:.*/)?'; i += 2 }
    else if (c === '*' && input[i + 1] === '*') { re += '.*'; i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if ('.+^$()|'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(re + '$').test(anchored ? file : file.split('/').at(-1)!)
}
async function verifyLfs(reader: Reader, directory: string, files: FileEntry[], sizes: Map<string, number>) {
  const attrs = new Map<string, FileEntry>()
  for (const file of files) if (file.name === '.gitattributes') attrs.set(file.path, file)
  // Ancestor attributes also apply to the selected Story subtree.
  let parent = ''
  for (const part of ['', ...directory.split('/').filter(Boolean)]) {
    if (part) parent = [parent, part].filter(Boolean).join('/')
    const entry = (await reader.tree(parent)).find(item => item.name === '.gitattributes')
    if (entry) { supported(entry); attrs.set(entry.path, entry as FileEntry) }
  }
  if (attrs.size > MAX_ATTR_FILES) invalid('Too many Git attributes files to verify.')
  for (const [path, attr] of attrs) {
    const size = sizes.get(path) ?? await reader.head(attr)
    if (size > MAX_ATTR_SIZE) invalid('Git attributes are too large to inspect.')
    const body = await reader.content(attr, size)
    const base = path.slice(0, -'.gitattributes'.length).replace(/\/$/, '')
    for (const line of body.split('\n')) {
      const words = line.trim().split(/\s+/)
      if (words.length < 2 || words[0]!.startsWith('#') || !words.slice(1).includes('filter=lfs')) continue
      for (const file of files) {
        if (base && !file.path.startsWith(base + '/')) continue
        const relative = base ? file.path.slice(base.length + 1) : file.path
        if (matchPattern(words[0]!, relative)) invalid('Git LFS attributes apply to the selected Story; size cannot be verified.')
      }
    }
  }
  const small = files.filter(file => sizes.get(file.path)! <= POINTER_SIZE)
  if (small.length > MAX_SMALL_BLOBS) invalid('Too many small Story files to inspect for Git LFS pointers.')
  for (const file of small) {
    const body = await reader.content(file, sizes.get(file.path)!)
    if (body.startsWith('version https://git-lfs.github.com/spec/v1')) {
      invalid('Git LFS pointer detected; underlying Story size cannot be verified.')
    }
  }
}
async function preflight(reader: Reader, directory: string, fullPath: string) {
  if (!await isStory(reader, directory)) invalid('Selected directory has no canonical Story Markdown records.')
  const files = await selectedBlobs(reader, directory)
  const sizes = await reader.sizes(files, fullPath)
  let sizeBytes = 0
  for (const file of files) {
    const bytes = sizes.get(file.path)
    if (!Number.isSafeInteger(bytes) || bytes! < 0) invalid('GitLab did not provide a reliable size for every Story blob.')
    sizeBytes += bytes!
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > STORY_LIMIT_BYTES) {
      invalid('Story exceeds the 100 MB uncompressed Git-blob limit.')
    }
  }
  await verifyLfs(reader, directory, files, sizes)
  return { sizeBytes, limitBytes: STORY_LIMIT_BYTES, blobCount: files.length }
}
/** Verify the cataloged GitLab project and pinned Story again before Git transfer. */
export async function verifyGitlabStorySelection(
  token: string, projectId: number, repository: string, commit: string, directory: string,
) {
  const path = directoryPath(directory)
  const authorized = await authorizedProject(token, projectId)
  if (authorized.path_with_namespace !== repository) {
    invalid('GitLab project identity changed since connection; reconnect it before creating a job.')
  }
  const pinned = await commitSnapshot(token, projectId, commit)
  return preflight(new Reader(token, projectId, pinned), path, authorized.path_with_namespace)
}

export async function gitlabStoryRequest(auth: StudioAuth, store: StudioDatabase, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) {
    return reply({ error: 'Cross-origin write refused' }, 403)
  }
  try {
    const candidate = request.method === 'GET' ? new URL(request.url).searchParams.get('repositoryId') :
      (await request.clone().json().catch(() => null))?.repositoryId
    const current = await actor(auth, store, request.headers,
      typeof candidate === 'string' ? candidate : undefined)
    const params = request.method === 'GET' ? new URL(request.url).searchParams : null
    const body = request.method === 'POST' ? await request.json().catch(() => null) : null
    const repositoryId = params?.get('repositoryId') ?? body?.repositoryId
    const directory = directoryPath(params?.get('directory') ?? body?.directory ?? '')
    if (typeof repositoryId !== 'string' || !/^[a-f\d-]{36}$/i.test(repositoryId)) {
      throw new ProviderFailure(400, 'Invalid repository ID.')
    }
    const row = store.sqlite.prepare(`SELECT name,provider_repository_id AS projectId FROM repositories
      WHERE id=? AND owner_user_id=? AND provider='gitlab'`)
      .get(repositoryId, current.id) as { name: string; projectId: string } | undefined
    if (!row) throw new ProviderFailure(404, 'GitLab project is not connected.')
    const projectId = Number(row.projectId)
    if (!Number.isSafeInteger(projectId) || projectId <= 0) invalid('GitLab catalog has invalid project metadata.')
    if (request.method === 'POST') assertStudioSchemaCurrent(store)
    const authorized = await authorizedProject(current.token, projectId)
    if (authorized.path_with_namespace !== row.name) {
      invalid('GitLab project identity changed since connection; reconnect it before browsing.')
    }
    const pinned = params?.get('commit') ?? body?.commit ?? null
    if (pinned !== null && typeof pinned !== 'string') throw new ProviderFailure(400, 'Invalid pinned commit.')
    if (request.method === 'POST' && !pinned) throw new ProviderFailure(400, 'Select a pinned commit before importing a Story.')
    const commit = await commitSnapshot(current.token, projectId, pinned)
    const reader = new Reader(current.token, projectId, commit)
    if (request.method === 'GET' && params?.get('mode') === 'discover') {
      return reply({ commit, stories: await discover(reader) })
    }
    const entries = await reader.tree(directory)
    if (request.method === 'GET') {
      return reply({ commit, directory,
        directories: entries.filter(e => e.type === 'tree').map(e => ({ name: e.name, path: e.path })),
        isStory: await isStory(reader, directory) })
    }
    const result = await preflight(reader, directory, authorized.path_with_namespace)
    const now = new Date().toISOString()
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(repository_id,directory) DO UPDATE SET title=excluded.title,source_commit_sha=excluded.source_commit_sha`)
      .run(randomUUID(), current.id, repositoryId, directory,
        directory.split('/').filter(Boolean).at(-1) || row.name, now, commit)
    const story = store.sqlite.prepare(`SELECT id,directory,title,source_commit_sha AS commitSha FROM stories
      WHERE repository_id=? AND owner_user_id=? AND directory=?`)
      .get(repositoryId, current.id, directory) as { id: string; title: string; directory: string; commitSha: string }
    return reply({ story: { id: story.id, title: story.title, directory: story.directory, commit: story.commitSha }, ...result })
  } catch (error) {
    if (error instanceof StudioSchemaError) return reply({ error: error.message }, 503)
    return failure(error)
  }
}
