import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStudioAuth } from '../src/lib/auth'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from '../src/db/migrations'
import {
  discoverRepositoryCatalog, loadRepositorySourcePage,
} from '../src/lib/repository-candidates.server'
import { eligibleCandidates, mergeCandidates, sourceKey } from '../src/lib/repository-candidates.shared'
import type { AvailableRepository } from '../src/lib/repository-candidates.server'

const origin = 'http://localhost:3000'
const secret = 'combined-repository-tests-secret-0123456789abcdefghijk'
const config = {
  baseURL: origin, secret,
  github: { clientId: 'github', clientSecret: 'github-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'gitlab-secret' },
}

test('unified catalog reads both connected providers, preserves auth and supports independent pagination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-repository-catalog-'))
  const store = openStudioDatabase(join(dir, 'studio.sqlite'))
  const previousFetch = globalThis.fetch
  const previousSlug = process.env.GITHUB_APP_SLUG
  const previousBaseURL = process.env.BETTER_AUTH_URL
  process.env.GITHUB_APP_SLUG = 'noveltea-tests'
  process.env.BETTER_AUTH_URL = origin
  let gitlabDenied = false
  const queries: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const token = new Headers(init?.headers).get('authorization')
    queries.push(url)
    if (url.startsWith('https://api.github.com')) {
      assert.equal(token, 'Bearer github-catalog-token')
      if (url.includes('/user/installations/31/repositories')) {
        const page = Number(new URL(url).searchParams.get('page'))
        return Response.json(page === 1
          ? { total_count: 101, repositories: [
            { id: 301, full_name: 'acme/Novel', permissions: { push: true }, private: true },
            { id: 302, full_name: 'acme/ReadOnly', permissions: { push: false }, private: true },
          ] }
          : { total_count: 101, repositories: [
            { id: 303, full_name: 'acme/NextPage', permissions: { push: true }, private: false },
          ] })
      }
      if (url.includes('/user/installations')) return Response.json({
        total_count: 1, installations: [{
          id: 31, account: { login: 'acme', type: 'Organization' },
          repository_selection: 'selected', permissions: { contents: 'write' }, suspended_at: null,
        }],
      })
    }
    if (url.startsWith('https://gitlab.com/api/v4/projects')) {
      assert.equal(token, 'Bearer gitlab-catalog-token')
      if (gitlabDenied) return Response.json({ error: 'Expired' }, { status: 401 })
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json(page === 1 ? [
        { id: 501, path_with_namespace: 'studio/Story', name_with_namespace: 'Studio / Story',
          visibility: 'private', archived: false },
        { id: 502, path_with_namespace: 'studio/Archived', name_with_namespace: 'Studio / Archived',
          visibility: 'private', archived: true },
      ] : [
        { id: 503, path_with_namespace: 'studio/Next', name_with_namespace: 'Studio / Next',
          visibility: 'public', archived: false },
      ], { headers: { 'x-next-page': page === 1 ? '2' : '' } })
    }
    throw new Error('Unexpected remote request: ' + url)
  }
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config)
    const context = await auth.$context
    const owner = await context.internalAdapter.createUser({
      name: 'Alice', email: 'alice@tests.invalid', emailVerified: true,
    }, { method: 'test' })
    const other = await context.internalAdapter.createUser({
      name: 'Bob', email: 'bob@tests.invalid', emailVerified: true,
    }, { method: 'test' })
    await context.internalAdapter.createAccount({
      userId: owner.id, providerId: 'github', accountId: 'github-owner',
      accessToken: 'github-catalog-token',
    })
    await context.internalAdapter.createAccount({
      userId: owner.id, providerId: 'gitlab', accountId: 'gitlab-owner',
      accessToken: 'gitlab-catalog-token',
    })
    const headersFor = async (id: string) => {
      const session = await context.internalAdapter.createSession(id)
      const signature = createHmac('sha256', secret).update(session.token).digest('base64')
      return new Headers({ cookie: 'better-auth.session_token=' + session.token + '.' + signature, origin })
    }
    const headers = await headersFor(owner.id)
    const otherHeaders = await headersFor(other.id)

    const catalog = await discoverRepositoryCatalog(auth, store, headers, origin)
    assert.deepEqual(catalog.accounts.map(account => account.provider), ['github', 'gitlab'])
    assert.deepEqual(catalog.repositories.map(repo => repo.name), ['studio/Story', 'acme/Novel'])
    assert.equal(catalog.repositories.every(repo => !repo.added), true)
    assert.deepEqual(catalog.sources.map(source => source.hasMore), [true, true])
    assert.equal(catalog.warnings.length, 0)
    assert.ok(queries.some(url => url.startsWith('https://api.github.com')))
    assert.ok(queries.some(url => url.startsWith('https://gitlab.com')))
    assert.doesNotMatch(JSON.stringify(catalog), /catalog-token/)

    const pages = await Promise.all(catalog.sources.map(source =>
      loadRepositorySourcePage(auth, store, headers, origin, { ...source, page: 2 })))
    assert.deepEqual(pages.flatMap(page => page.repositories.map(repo => repo.name)),
      ['studio/Next', 'acme/NextPage'])
    assert.equal(pages.every(page => !page.source.hasMore), true)
    await assert.rejects(() =>
      loadRepositorySourcePage(auth, store, otherHeaders, origin, { ...catalog.sources[0]!, page: 2 }),
    /identity is no longer connected/)

    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at,connection_id)
      VALUES (?,?,?,?,?,?,NULL)`).run(
      '44444444-4444-4444-8444-444444444444', owner.id, 'github', '301',
      'acme/Novel', new Date().toISOString(),
    )
    const repeated = await discoverRepositoryCatalog(auth, store, headers, origin)
    assert.equal(repeated.repositories.find(repo => repo.providerRepositoryId === '301')?.added, true)
    assert.deepEqual(eligibleCandidates(repeated.repositories, '', new Set()).map(repo => repo.name),
      ['studio/Story'])

    gitlabDenied = true
    const partial = await discoverRepositoryCatalog(auth, store, headers, origin)
    assert.deepEqual(partial.repositories.map(repo => repo.name), ['acme/Novel'],
      'GitLab token failure must not hide usable GitHub repositories')
    assert.match(partial.warnings.join(' '), /GitLab.*expired/i)

    const bob = await discoverRepositoryCatalog(auth, store, otherHeaders, origin)
    assert.deepEqual(bob.repositories, [])
    assert.deepEqual(bob.accounts, [])
    assert.equal(await Promise.resolve(bob.warnings.length), 0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG
    else process.env.GITHUB_APP_SLUG = previousSlug
    if (previousBaseURL === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = previousBaseURL
    store.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merged candidate lists filter imported entries and deduplicate provider pages', () => {
  const mk = (id: string, provider: 'github' | 'gitlab', added = false): AvailableRepository => ({
    provider, providerRepositoryId: id, name: 'team/' + id,
    account: provider, connectionId: null, private: true, empty: false, added,
  })
  const first = [mk('1', 'github'), mk('2', 'gitlab')]
  const combined = mergeCandidates(first, [mk('1', 'github'), mk('3', 'gitlab', true)])
  assert.deepEqual(combined.map(item => item.name), ['team/1', 'team/2', 'team/3'])
  assert.deepEqual(eligibleCandidates(combined, 'github', new Set()).map(item => item.name), ['team/1'])
  assert.deepEqual(eligibleCandidates(combined, '', new Set(['github:1:legacy']))
    .map(item => item.name), ['team/2'])
  assert.notEqual(sourceKey({ provider: 'github', connectionId: null, label: 'GH',
    installationId: 10, page: 1, hasMore: true }),
  sourceKey({ provider: 'github', connectionId: null, label: 'GH',
    installationId: 11, page: 1, hasMore: true }))
})
