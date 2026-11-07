import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Importing the browser component directly from a Node test also initializes
// TanStack's server runtime. Verify route wiring without accessing Studio DBs.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('GitHub and GitLab routes use one browser and identical pinned navigation contracts', () => {
  const shared = read('../src/routes/_protected/repositories/-RepositoryStoryBrowser.tsx')
  for (const provider of ['github', 'gitlab'] as const) {
    const route = read('../src/routes/_protected/repositories/' + provider + '/$repositoryId.tsx')
    assert.match(route, /import \{ RepositoryStoryBrowser \} from '\.\.\/\-RepositoryStoryBrowser'/)
    assert.match(route, /validateSearch: validateRepositoryBrowseSearch/)
    assert.ok(route.includes('provider="' + provider + '"'))
    assert.ok(route.includes('onNavigate='))
    assert.ok(route.includes('key={repositoryId}'))
  }
  assert.match(shared, /<h1>Repository Stories<\/h1>/)
  assert.match(shared, /<h2>Directory browser<\/h2>/)
  assert.match(shared, /<h2>Detected Story directories<\/h2>/)
  assert.match(shared, /Verify size and add Story/)
  assert.match(shared, /Create isolated job worktree/)
  assert.match(shared, /Refresh HEAD/)
  assert.match(shared, /<NewStoryOnboarding/)

  const dashboard = read('../src/routes/_protected/dashboard.tsx')
  assert.match(dashboard, /repositoryBrowseHref\(repository\.provider, repository\.id, story\.directory, story\.commitSha\)/)
  assert.match(dashboard, /Browse repository/)
  assert.doesNotMatch(dashboard, /provider === 'gitlab'/,
    'Story actions must not depend on the Git provider')

  const providerIcon = read('../src/components/git-provider-icon.tsx')
  assert.match(providerIcon, /role="img" aria-label=\{names\[provider\]\}/)
})
