import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repositoryBrowseHref, validateRepositoryBrowseSearch } from '../src/lib/repository-story-navigation'

const commit = 'a'.repeat(40)
const repositoryId = 'f3c03cff-4d87-41c7-95cd-ed63748ed75b'

test('GitHub and GitLab Story links preserve the same repository, directory and immutable revision', () => {
  for (const provider of ['github', 'gitlab'] as const) {
    const href = repositoryBrowseHref(provider, repositoryId, 'stories/a b', commit.toUpperCase())
    const url = new URL(href, 'https://studio.example')
    assert.equal(url.pathname, '/repositories/' + provider + '/' + repositoryId)
    assert.deepEqual(validateRepositoryBrowseSearch(Object.fromEntries(url.searchParams)), {
      directory: 'stories/a b', commit,
    })
    assert.equal(repositoryBrowseHref(provider, repositoryId), '/repositories/' + provider + '/' + repositoryId)
    assert.equal(repositoryBrowseHref(provider, repositoryId, 'story'),
      '/repositories/' + provider + '/' + repositoryId + '?directory=story',
      'Story without a saved commit still has a repository browser link')
  }
})

test('both Story routes accept a pinned link and reject an invalid revision', () => {
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 'story', commit }), {
    directory: 'story', commit,
  })
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 'story', commit: 'HEAD' }), {
    directory: 'story', commit: '',
  })
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 0, commit: null }), {
    directory: '', commit: '',
  })
  assert.equal(repositoryBrowseHref('github', repositoryId, '', 'HEAD'),
    '/repositories/github/' + repositoryId)
  assert.ok(repositoryBrowseHref('gitlab', repositoryId, 'works/space', commit)
    .endsWith('?directory=works%2Fspace&commit=' + commit))
})
