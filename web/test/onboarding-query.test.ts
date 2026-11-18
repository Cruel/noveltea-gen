import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { onboardingQuery } from '../src/lib/onboarding-query'

test('Story onboarding URLs contain only repository and folder identity, never the author brief', () => {
  const submission = {
    repositoryId: '11111111-1111-4111-8111-111111111111',
    workspace: 'new-test',
    json: JSON.stringify({ action: 'start', text: 'A private science-fiction Story idea' }),
  }
  const query = onboardingQuery(submission)
  const entries = [...new URLSearchParams(query).entries()]
  assert.deepEqual(entries, [
    ['repositoryId', submission.repositoryId],
    ['workspace', submission.workspace],
  ])
  assert.doesNotMatch(query, /json|private|action|text|science/i)
  assert.deepEqual([...new URLSearchParams(onboardingQuery({
    repositoryId: submission.repositoryId, workspace: '',
  })).entries()], [['repositoryId', submission.repositoryId], ['workspace', '']])
})

test('all onboarding server functions use the identity-only query for GET, PUT and POST', () => {
  const source = readFileSync(new URL('../src/lib/story-workflows.functions.ts', import.meta.url), 'utf8')
  assert.equal((source.match(/onboardingQuery\(data\)/g) ?? []).length, 5,
    'questionnaire load/save/review and Pi load/act all use the same safe query')
  assert.doesNotMatch(source, /\/api\/onboarding(?:\/pi)?\?' \+ params\(data\)/)
})
