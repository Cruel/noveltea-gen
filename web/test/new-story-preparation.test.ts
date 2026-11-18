import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pinnedInitializationCommit, confirmPreparedInitialization } from '../src/lib/new-story-preparation'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const jobId = '22222222-2222-4222-8222-222222222222'
const record = { story: { id: '33333333-3333-4333-8333-333333333333' },
  jobId, baseSha: base, commit: head, headSha: head }

test('the initial GitHub job is reopened by its provider-pinned base, NOT the newly created HEAD', () => {
  assert.equal(pinnedInitializationCommit('github', record, base), base)
  assert.equal(pinnedInitializationCommit('github', { ...record, baseSha: undefined }, base), base,
    'an already-created job from the previous client may be resumed')
  assert.throws(() => pinnedInitializationCommit('github', { ...record, baseSha: undefined }, null),
    /pinned initialization/)
  assert.throws(() => pinnedInitializationCommit('github', { ...record, baseSha: 'c'.repeat(40) }, base),
    /changed/)
})

test('GitLab preparation uses the provider commit and never borrows the GitHub base', () => {
  assert.equal(pinnedInitializationCommit('gitlab', record, base), head)
})

test('prepared job must be exactly the same saved initialization job and HEAD', () => {
  assert.equal(confirmPreparedInitialization(record, { id: jobId, headSha: head }), head)
  assert.throws(() => confirmPreparedInitialization(record,
    { id: '44444444-4444-4444-8444-444444444444', headSha: head }), /mismatch/)
  assert.throws(() => confirmPreparedInitialization(record,
    { id: jobId, headSha: base }), /mismatch/)
})

test('onboarding prepares the initialized GitHub job before saving generation configuration and on retry', () => {
  const text = readFileSync(new URL('../src/routes/_protected/repositories/-NewStoryOnboarding.tsx', import.meta.url), 'utf8')
  assert.match(text, /prepareRepositoryJob\(/)
  assert.match(text, /pinnedInitializationCommit\(/)
  assert.match(text, /confirmPreparedInitialization\(/)
  assert.doesNotMatch(text, /setJobReady\(true\)\s*\}\s*else \{/,
    'GitHub must not mark an unprepared job ready immediately after creating its commit')
})
