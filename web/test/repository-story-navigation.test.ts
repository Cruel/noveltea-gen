import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repositoryBrowseHref, validateRepositoryBrowseSearch } from '../src/lib/repository-story-navigation'

const commit = 'a'.repeat(40)
const repositoryId = 'f3c03cff-4d87-41c7-95cd-ed63748ed75b'

test('repository Story links are provider-neutral and retain the pinned directory and revision', () => {
  const href = repositoryBrowseHref(repositoryId, 'stories/a b', commit.toUpperCase())
  const url = new URL(href, 'https://studio.example')
  assert.equal(url.pathname, '/repositories/' + repositoryId)
  assert.deepEqual(validateRepositoryBrowseSearch(Object.fromEntries(url.searchParams)), {
    directory: 'stories/a b', commit,
  })
  assert.equal(repositoryBrowseHref(repositoryId), '/repositories/' + repositoryId)
  assert.equal(repositoryBrowseHref(repositoryId, 'story'),
    '/repositories/' + repositoryId + '?directory=story',
    'a Story without a stored SHA still has a repository link')
  assert.ok(repositoryBrowseHref(repositoryId, 'works/space', commit)
    .endsWith('?directory=works%2Fspace&commit=' + commit))
})

test('a pinned link rejects invalid revisions without accepting a moving HEAD alias', () => {
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 'story', commit }), {
    directory: 'story', commit,
  })
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 'story', commit: 'HEAD' }), {
    directory: 'story', commit: '',
  })
  assert.deepEqual(validateRepositoryBrowseSearch({ directory: 0, commit: null }), {
    directory: '', commit: '',
  })
  assert.equal(repositoryBrowseHref(repositoryId, '', 'HEAD'),
    '/repositories/' + repositoryId)
})
