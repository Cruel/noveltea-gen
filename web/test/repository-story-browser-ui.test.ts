import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Importing a browser component in Node starts the TanStack server runtime.
// Verify the route contract without touching a deployment database.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('one owner-resolved route renders the shared browser; old provider routes redirect pinned links', () => {
  const canonical = read('../src/routes/_protected/repositories/$repositoryId.tsx')
  assert.match(canonical, /getRepositoryForBrowser\(\{ data: params\.repositoryId \}\)/)
  assert.match(canonical, /provider=\{repository\.provider\}/)
  assert.match(canonical, /validateSearch: validateRepositoryBrowseSearch/)
  assert.match(canonical, /<RepositoryStoryBrowser/)
  for (const provider of ['github', 'gitlab'] as const) {
    const legacy = read('../src/routes/_protected/repositories/' + provider + '/$repositoryId.tsx')
    assert.match(legacy, /beforeLoad:/)
    assert.match(legacy, /throw redirect\(/)
    assert.match(legacy, /to: '\/repositories\/\$repositoryId'/)
    assert.match(legacy, /search, replace: true/)
    assert.match(legacy, /validateSearch: validateRepositoryBrowseSearch/)
    assert.doesNotMatch(legacy, /<RepositoryStoryBrowser/)
  }

  const shared = read('../src/routes/_protected/repositories/-RepositoryStoryBrowser.tsx')
  for (const name of ['Repository Stories', 'Directory browser', 'Detected Story directories',
    'Verify size and add Story', 'Create isolated job worktree', 'Refresh HEAD']) {
    assert.ok(shared.includes(name))
  }
  assert.match(shared, /<NewStoryOnboarding/)
  const dashboard = read('../src/routes/_protected/dashboard.tsx')
  assert.match(dashboard, /repositoryBrowseHref\(repository\.id, story\.directory, story\.commitSha\)/)
  assert.match(dashboard, /Browse repository/)
  assert.doesNotMatch(dashboard, /provider === 'gitlab'/)
  const icon = read('../src/components/git-provider-icon.tsx')
  assert.match(icon, /role="img" aria-label=\{names\[provider\]\}/)
})
