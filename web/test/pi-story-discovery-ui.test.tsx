import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import type { PiStoryDiscovery as PiDiscoveryComponent } from '../src/routes/_protected/repositories/-PiStoryDiscovery'

const temp = mkdtempSync(join(tmpdir(), 'nt-discovery-ui-'))
let PiStoryDiscovery: typeof PiDiscoveryComponent
before(async () => {
  const config = { baseURL: 'http://localhost:3000',
    secret: 'repository-question-test-secret-0123456789',
    github: { clientId: 'test', clientSecret: 'test' },
    gitlab: { clientId: 'test', clientSecret: 'test' } }
  process.env.NT_STUDIO_DB_PATH = join(temp, 'studio.sqlite')
  process.env.BETTER_AUTH_URL = config.baseURL
  process.env.BETTER_AUTH_SECRET = config.secret
  process.env.GITHUB_CLIENT_ID = config.github.clientId
  process.env.GITHUB_CLIENT_SECRET = config.github.clientSecret
  process.env.GITLAB_CLIENT_ID = config.gitlab.clientId
  process.env.GITLAB_CLIENT_SECRET = config.gitlab.clientSecret
  const store = openStudioDatabase(process.env.NT_STUDIO_DB_PATH)
  await migrateStudio(store, config)
  await store.close()
  PiStoryDiscovery = (await import('../src/routes/_protected/repositories/-PiStoryDiscovery')).PiStoryDiscovery
})
after(() => rmSync(temp, { recursive: true, force: true }))

const repositoryId = '11111111-1111-4111-8111-111111111111'
const workspace = 'new-story'
const question = { id: 'tone', kind: 'alternatives', question: 'Which tone should the story have?',
  options: [{ id: 'uneasy', title: 'Uneasy' }, { id: 'hopeful', title: 'Hopeful' }],
  recommendedId: 'uneasy', allowStudioDecision: true, delegationAllowed: true }

function renderSession(session: Record<string, unknown>): string {
  const client = new QueryClient()
  client.setQueryData(['pi-discovery', repositoryId, workspace], { session })
  client.setQueryData(['pi-models'], { models: [] })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(PiStoryDiscovery, { repositoryId, workspace, initialBrief: '', onApproved: () => {} })))
}

test('repository Guided Story creation renders shared structured Question Set controls, not prose pre', () => {
  const html = renderSession({ phase: 'questions', revision: 2,
    model: { provider: 'test', id: 'mock' }, turns: [{ role: 'user', text: 'A mystery' }],
    questions: { id: 'a'.repeat(64), revision: 2, questions: [question,
      { id: 'length', kind: 'free-text', question: 'How long should the story be?',
        placeholder: 'About two hours', delegationAllowed: false }] },
    drafts: {}, accepted: [], proposal: null, digest: null,
    skillId: 'b'.repeat(64), startedAt: null })
  assert.match(html, /Story discovery questions/)
  assert.match(html, /Which tone should the story have\?/)
  assert.match(html, /Recommended/)
  assert.match(html, /Decide for me/)
  assert.match(html, /placeholder="About two hours"/)
  assert.doesNotMatch(html, /<pre[^>]*>.*Which tone/)
  assert.doesNotMatch(html, /Your answers \(partial answers and delegation are allowed\)/)
})

test('Creative Direction proposals are not labelled as author-approved before exact approval', () => {
  const foundation = { id: 'foundation', title: 'The Last Bell',
    premise: 'The bell is missing', central_conflict: 'Concealed truth',
    genre: 'Mystery', tone: 'Uneasy', player_experience: 'Follow clues',
    scope: 'One town', body: 'The investigator has one night.',
    decisions: [{ id: 'suggestion', statement: 'Trust the archivist',
      origin: 'agent', authority: 'user-protected' }] }
  const session = { phase: 'proposed', revision: 5,
    model: { provider: 'test', id: 'mock' }, turns: [{ role: 'user', text: 'A mystery' }],
    questions: null, proposal: { foundation, task: 'Make a mystery', interpretations: [] },
    digest: 'c'.repeat(64), skillId: 'b'.repeat(64), startedAt: null }
  const proposed = renderSession(session)
  assert.match(proposed, /Studio proposal \(awaiting approval\)/)
  assert.doesNotMatch(proposed, /Studio proposal \(approved\)/)
  const approved = renderSession({ ...session, phase: 'approved' })
  assert.match(approved, /Studio proposal \(approved\)/)
})

test('pre-v1 proposed discovery must restart instead of presenting obsolete approval controls', () => {
  const html = renderSession({ phase: 'proposed', revision: 5,
    model: { provider: 'test', id: 'mock' }, turns: [{ role: 'user', text: 'A mystery' }],
    legacyQuestions: true, questions: null, proposal: { foundation: { title: 'Old result' } },
    digest: 'c'.repeat(64), skillId: 'b'.repeat(64), startedAt: null })
  assert.match(html, /Restart discovery questions/)
  assert.doesNotMatch(html, /Approve exact Creative Direction|Review the proposed Creative Direction/)
})

test('pre-v1 repository discovery shows an explicit restart path without rendering old text questions', () => {
  const html = renderSession({ phase: 'questions', revision: 4,
    model: { provider: 'test', id: 'mock' }, turns: [{ role: 'user', text: 'A mystery' }],
    legacyQuestions: true, questions: null, proposal: null, digest: null,
    skillId: 'b'.repeat(64), startedAt: null })
  assert.match(html, /Restart discovery questions/)
  assert.doesNotMatch(html, /<pre/)
  assert.doesNotMatch(html, /Send answers/)
})
