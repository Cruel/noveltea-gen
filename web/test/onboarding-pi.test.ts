import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { removeTestTree } from '../../test/helpers'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { migrateStudio } from './support/studio-database'
import { createStudioAuth } from '../src/lib/auth'
import { onboardingPiRequest, assertApprovedPiFoundation, type DiscoveryInference } from '../src/lib/onboarding-pi.server'
import { userPiCredentials, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { candidate } from '../src/lib/story-foundation.server'
import { hasUserProtectedDecision } from '../../src/foundation-record'

const url = 'http://localhost:3000'
const structuredQuestions = (questions: unknown[]) => JSON.stringify({
  phase: 'questions', questions: { questions },
})
const config = {
  baseURL: url, secret: 'pi-onboarding-test-secret-0123456789abcdefghijklmnop',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const repo = '11111111-1111-4111-8111-111111111111'
const proposed = JSON.stringify({ phase: 'proposal', task: 'Expand the branching mystery',
  foundation: { id: 'foundation', title: 'The Last Bell', premise: 'A bell disappears',
    central_conflict: 'The town hides the truth', genre: 'Mystery', tone: 'Somber',
    player_experience: 'Question evidence and choose loyalties', scope: 'One town, two outcomes',
    body: 'The player investigates a bell that was heard after it vanished. The cause remains grounded in personal loyalty.',
    decisions: [{ statement: 'No fixed heroic ending', authority: 'delegated' }] } })

function makeSkills(root: string) {
  const source = join(root, 'skills-checkout')
  const discovery = join(source, 'skills', 'nt-story-discovery')
  const catalog = join(source, 'skills', 'nt-catalog')
  mkdirSync(discovery, { recursive: true })
  mkdirSync(join(catalog, 'references'), { recursive: true })
  execFileSync('git', ['init', '-q', source])
  writeFileSync(join(discovery, 'SKILL.md'),
    '---\nname: nt-story-discovery\ndescription: Collaborate creatively\n---\nAsk all currently answerable creative questions.\n')
  writeFileSync(join(catalog, 'SKILL.md'),
    '---\nname: nt-catalog\ndescription: Canonical records\n---\nPreserve decision authority.\n')
  for (const file of ['records.md', 'authority-and-validation.md', 'glossary.md'])
    writeFileSync(join(catalog, 'references', file), 'Canonical Story guidance: ' + file + '\n')
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Pinned skill fixture'])
  return source
}
test('Pi discovery is multi-round, owner-scoped, restart-safe and exact-proposal bound before Git', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-pi-onboard-'))
  const env = { key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR }
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = makeSkills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshot-cache')
  const db = join(root, 'studio.sqlite')
  let store = openStudioDatabase(db)
  try {
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice', email: 'alice@pi-onboard.test',
      emailVerified: true }, { method: 'test' })
    const bob = await ctx.internalAdapter.createUser({ name: 'Bob', email: 'bob@pi-onboard.test',
      emailVerified: true }, { method: 'test' })
    const cookie = async (id: string) => {
      const session = await ctx.internalAdapter.createSession(id)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const own = await cookie(alice.id), foreign = await cookie(bob.id)
    await store.persistence.repositories.upsert(alice.id, 'github', '1',
      'test/repo', null, repo, '2026-11-01')
    await userPiCredentials(store, alice.id).modify('openai',
      async () => ({ type: 'api_key', key: 'TEST-USER-ONLY-KEY' }))
    const models = await availableUserPiModels(store, alice.id)
    assert.ok(models.length, 'the user must have an actual selectable Pi model')
    const model = {provider: models[0]!.provider, id: models[0]!.id }
    const calls: string[] = []
    const infer: DiscoveryInference = async (state, prompt) => {
      calls.push(state.phase + ':' + state.turns.length)
      assert.match(prompt, /nt-story-discovery\/SKILL.md/)
      assert.match(prompt, /nt-catalog\/SKILL.md/)
      assert.match(prompt, /Ask all currently answerable creative questions/)
      return state.turns.length === 1
        ? structuredQuestions([{ id: 'feeling', kind: 'free-text',
          question: 'How should players feel while investigating?',
          placeholder: 'For example, wary and curious', allowStudioDecision: false }])
        : state.turns.length === 3
          ? structuredQuestions([{ id: 'ending', kind: 'yes-no',
            question: 'Should the ending always be fixed?', allowStudioDecision: true },
            { id: 'direction', kind: 'free-text',
              question: 'What creative guidance should shape the ending?',
              allowStudioDecision: false }])
          : JSON.stringify({ ...JSON.parse(proposed), foundation: {
            ...JSON.parse(proposed).foundation, decisions: [
              { statement: 'No fixed heroic ending', authority: 'delegated',
                source: { kind: 'answer', setId: state.accepted![1]!.setId, questionId: 'ending' } },
            ],
          } })
    }
    const request = async (method: 'GET' | 'POST', value?: unknown, who = own, origin = url,
      inferStep = infer, workspace = 'projects/demo') => {
      const response = await onboardingPiRequest(auth, store,
        new Request(url + '/api/onboarding/pi?' + new URLSearchParams({
          repositoryId: repo, workspace,
        }), { method, headers: {cookie: who, origin},
          ...(method === 'POST' ? {body: JSON.stringify(value)} : {}) }), url, inferStep)
      return { status: response.status, body: await response.json() as any }
    }
    assert.equal((await request('GET', undefined, '')).status, 401)
    assert.equal((await request('GET', undefined, foreign)).status, 404)
    assert.equal((await request('POST', {action: 'start', model, text: 'A missing bell'},
      own, 'https://other.test')).status, 403)
    assert.equal((await request('GET')).body.session, null)
    const first = await request('POST', { action: 'start', model, text: 'A missing bell in a small town' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.session.phase, 'questions')
    assert.equal(first.body.session.questions.questions[0].id, 'feeling')
    assert.equal(first.body.session.revision, 2)
    assert.equal((await request('POST', { action: 'start', model, text: 'Duplicate' })).status, 409)
    assert.equal((await request('POST', { action: 'answer', revision: 2, text: 'wary' },
      foreign)).status, 404)
    assert.equal((await request('POST', { action: 'answer', revision: 1, text: 'wary' })).status, 409)
    const firstSet = first.body.session.questions
    const second = await request('POST', { action: 'answer', revision: 2,
      setId: firstSet.id, setRevision: firstSet.revision,
      responses: [{ questionId: 'feeling', answer: { kind: 'custom',
        text: 'The player should feel wary, and always have a choice.', note: '' } }],
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.session.phase, 'questions')
    store.close()
    store = openStudioDatabase(db)
    auth = createStudioAuth(store, config)
    const reopened = await request('GET')
    assert.equal(reopened.body.session.phase, 'questions')
    assert.equal(reopened.body.session.turns.length, 4)
    const secondSet = reopened.body.session.questions
    assert.equal(secondSet.questions.length, 2)
    const validResponses = [
      { questionId: 'ending', answer: { kind: 'delegate', note: '' } },
      { questionId: 'direction', answer: { kind: 'custom',
        text: 'Please choose the ending structure; preserve player choice.', note: '' } },
    ]
    assert.equal((await request('POST', { action: 'answer', revision: 4,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: validResponses.slice(0, 1),
    })).status, 422, 'missing mandatory answers cannot partially commit')
    assert.equal((await request('POST', { action: 'answer', revision: 4,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: [{ questionId: 'ending', answer: { kind: 'option', optionId: 'yes', note: '' } },
        { questionId: 'direction', answer: { kind: 'delegate', note: '' } }],
    })).status, 422, 'agent cannot delegate an author-controlled item')
    const draft = { direction: { selection: '__answer__', selectedIds: [],
      multiCustom: false, customAnswer: 'Please choose the ending structure; preserve player choice.',
      note: '' } }
    const savedDraft = await request('POST', { action: 'draft', revision: 4,
      setId: secondSet.id, setRevision: secondSet.revision, drafts: draft })
    assert.equal(savedDraft.status, 200)
    assert.equal(savedDraft.body.session.revision, 5)
    assert.deepEqual(savedDraft.body.session.drafts, draft)
    assert.equal((await request('POST', { action: 'draft', revision: 4,
      setId: secondSet.id, setRevision: secondSet.revision, drafts: {} })).status, 409,
      'second-tab stale draft must not overwrite newer input')
    store.close()
    store = openStudioDatabase(db)
    auth = createStudioAuth(store, config)
    assert.deepEqual((await request('GET')).body.session.drafts, draft,
      'unsubmitted input survives server restart')
    const third = await request('POST', { action: 'answer', revision: 5,
      setId: secondSet.id, setRevision: secondSet.revision,
      responses: validResponses,
    })
    assert.equal(third.status, 200, JSON.stringify(third.body))
    assert.equal(third.body.session.phase, 'proposed')
    assert.equal(third.body.session.proposal.foundation.decisions.length, 5)
    assert.equal(third.body.session.proposal.foundation.decisions[0].origin, 'user')
    assert.equal(third.body.session.proposal.foundation.decisions[2].origin, 'user')
    assert.equal(third.body.session.proposal.foundation.decisions[4].origin, 'agent')
    assert.equal(third.body.session.proposal.foundation.decisions[4].authority, 'delegated')
    assert.match(third.body.session.proposal.foundation.decisions[3].statement, /Please choose/)
    const foundation = third.body.session.proposal.foundation
    assert.equal((await request('POST', {action: 'approve', revision: 6, digest: 'f'.repeat(64)})).status, 409)
    assert.equal((await request('POST', {action: 'approve', revision: 4,
      digest: third.body.session.digest})).status, 409)
    assert.equal((await request('POST', {action: 'revise', revision: 4,
      text: 'Unapproved edit'})).status, 409)
    const accepted = await request('POST', {action: 'approve', revision: 7,
      digest: third.body.session.digest})
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.equal(accepted.body.session.phase, 'approved')
    assert.ok(hasUserProtectedDecision(candidate(foundation).file))
    const ref = { revision: accepted.body.session.revision, digest: accepted.body.session.digest }
    await assert.doesNotReject(() => assertApprovedPiFoundation(store, alice.id, repo,
      'projects/demo', ref, foundation))
    await assert.rejects(() => assertApprovedPiFoundation(store, alice.id, repo,
      'projects/other', ref, foundation), /does not match/)
    await assert.rejects(() => assertApprovedPiFoundation(store, alice.id, repo,
      'projects/demo', ref, {...foundation, title: 'Altered'}), /does not match/)
    await assert.rejects(() => assertApprovedPiFoundation(store, alice.id, repo,
      'projects/demo', {...ref, revision: ref.revision - 1}, foundation), /does not match/)
    assert.equal((await request('POST', {action: 'answer', revision: ref.revision, text: 'Late'})).status, 409)
    assert.equal((await request('GET', undefined, foreign)).status, 404)
    assert.equal(calls.length, 3)

    // The shared contract permits 16 typed questions, each with 4,000 custom
    // text and 1,000 note characters. Both the autosave and final-answer
    // transport must accept every validated combination, including CJK UTF-8.
    const bulkRequest = (body: unknown, inferStep: DiscoveryInference = async () =>
      structuredQuestions([{ id: 'follow-up', kind: 'free-text',
        question: 'What should happen next after the accepted answers?' }])) =>
      request('POST', body, own, url, inferStep, 'projects/bulk')
    const bulkStart = await bulkRequest({ action: 'start', model,
      text: 'A mystery about a vanished bell' }, async () => structuredQuestions(
      Array.from({ length: 16 }, (_, i) => ({ id: 'direction-' + i,
        kind: 'free-text', question: 'What should the author decide for part ' + (i + 1) + '?' }))))
    assert.equal(bulkStart.status, 200, JSON.stringify(bulkStart.body))
    assert.equal(bulkStart.body.session.questions.questions.length, 16)
    const set = bulkStart.body.session.questions
    const text = '界'.repeat(4000), note = '界'.repeat(1000)
    const drafts = Object.fromEntries(set.questions.map((q: { id: string }) =>
      [q.id, { selection: '__answer__', selectedIds: [], multiCustom: false,
        customAnswer: text, note }]))
    const responses = set.questions.map((q: { id: string }) => ({
      questionId: q.id, answer: { kind: 'custom', text, note },
    }))
    // Nine full CJK answers already breached the previous 100 KB cap.
    const nine = Object.fromEntries(Object.entries(drafts).slice(0, 9))
    const ninePayload = { action: 'draft', revision: bulkStart.body.session.revision,
      setId: set.id, setRevision: set.revision, drafts: nine }
    assert.ok(Buffer.byteLength(JSON.stringify(ninePayload), 'utf8') > 100_000)
    const nineSaved = await bulkRequest(ninePayload)
    assert.equal(nineSaved.status, 200, JSON.stringify(nineSaved.body))
    assert.equal(Object.keys(nineSaved.body.session.drafts).length, 9)
    const fullPayload = { ...ninePayload, revision: nineSaved.body.session.revision, drafts }
    const fullBytes = Buffer.byteLength(JSON.stringify(fullPayload), 'utf8')
    assert.ok(fullBytes > 200_000 && fullBytes < 512_000, String(fullBytes))
    const fullSaved = await bulkRequest(fullPayload)
    assert.equal(fullSaved.status, 200, JSON.stringify(fullSaved.body))
    assert.equal(Object.keys(fullSaved.body.session.drafts).length, 16)
    const control = String.fromCharCode(0)
    const escapedDrafts = Object.fromEntries(set.questions.map((q: { id: string }) =>
      [q.id, { selection: '__answer__', selectedIds: [], multiCustom: false,
        customAnswer: control.repeat(4000), note: control.repeat(1000) }]))
    const escapedPayload = { ...fullPayload, revision: fullSaved.body.session.revision,
      drafts: escapedDrafts }
    const escapedBytes = Buffer.byteLength(JSON.stringify(escapedPayload), 'utf8')
    assert.ok(escapedBytes > 480_000 && escapedBytes < 512_000, String(escapedBytes))
    const escapedSaved = await bulkRequest(escapedPayload)
    assert.equal(escapedSaved.status, 200, JSON.stringify(escapedSaved.body))
    const oversized = await bulkRequest({ action: 'draft',
      revision: escapedSaved.body.session.revision, setId: set.id,
      setRevision: set.revision, drafts, padding: 'a'.repeat(512_000) })
    assert.equal(oversized.status, 413, 'request reader must remain bounded')
    const acceptedBatch = { action: 'answer', revision: escapedSaved.body.session.revision,
      setId: set.id, setRevision: set.revision, responses }
    assert.ok(Buffer.byteLength(JSON.stringify(acceptedBatch), 'utf8') > 200_000)
    const acceptedBulk = await bulkRequest(acceptedBatch)
    assert.equal(acceptedBulk.status, 200, JSON.stringify(acceptedBulk.body))
    assert.equal(acceptedBulk.body.session.accepted[0].responses.length, 16)
    assert.equal(acceptedBulk.body.session.accepted[0].responses[0].answer.text, text)
    assert.equal(acceptedBulk.body.session.phase, 'questions')
    assert.equal((await store.persistence.dashboard.forOwner(alice.id)).stories.length, 0,
      'discovery and approval cannot write canonical Story before provider initialization')
  } finally {
    store.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', env.key], ['NT_STUDIO_SKILLS_SOURCE', env.source],
      ['NT_SKILL_CACHE_DIR', env.cache]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})

test('failed Pi turns are preserved and only user-initiated retry can reissue them', {
  timeout: 120_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-web-pi-retry-'))
  const prev = {key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR}
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = makeSkills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshot-cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const alice = await ctx.internalAdapter.createUser({ name: 'Alice2', email: 'alice2@pi-onboard.test',
      emailVerified: true }, {method:'test'})
    const sess = await ctx.internalAdapter.createSession(alice.id)
    const cookie = 'better-auth.session_token=' + sess.token + '.' +
      createHmac('sha256', config.secret).update(sess.token).digest('base64')
    await store.persistence.repositories.upsert(alice.id, 'github', '1',
      'test/repo', null, repo, '2026-11-01')
    await userPiCredentials(store, alice.id).modify('openai', async () =>
      ({type:'api_key', key:'TEST-USER-ONLY-KEY'}))
    const model = (await availableUserPiModels(store, alice.id))[0]!
    const req = async (data: unknown, infer: DiscoveryInference) => {
      const response = await onboardingPiRequest(auth, store,
        new Request(url + '/api/onboarding/pi?' + new URLSearchParams({ repositoryId: repo, workspace: '' }),
          {method:'POST', headers:{origin:url, cookie}, body: JSON.stringify(data)}), url, infer)
      return {status: response.status, body: await response.json() as any}
    }
    const fail = await req({action:'start', model:{provider:model.provider, id:model.id},
      text:'A small-town mystery'}, async () => { throw new Error('provider secret: NOT-FOR-UI') })
    assert.equal(fail.status, 503)
    assert.doesNotMatch(JSON.stringify(fail.body), /NOT-FOR-UI/)
    const resubmit = await req({action:'start', model:{provider:model.provider, id:model.id},
      text:'A small-town mystery'}, async () => { throw new Error('should never be called') })
    assert.equal(resubmit.status, 409)
    const revision = (await store.persistence.onboarding.conversation(alice.id, repo, ''))!.revision
    let calls = 0
    const retry = await req({action:'retry', revision}, async (state, instructions) => {
      calls++
      assert.equal(state.turns.length, 1)
      if (calls === 1) return structuredQuestions([{ id: 'conflict', kind: 'free-text',
        question: 'What is the main dramatic conflict?', allowStudioDecision: true,
        recommendationReason: 'Prefer a strong personal stake' }])
      assert.match(instructions, /Invalid Question Set recommendation/)
      assert.match(instructions, /free-text question omit recommendedId and recommendationReason/)
      assert.doesNotMatch(instructions, /provider secret: NOT-FOR-UI/)
      return structuredQuestions([{ id: 'conflict', kind: 'free-text',
        question: 'What is the main dramatic conflict?', allowStudioDecision: true,
        placeholder: 'A conflict with a personal stake' }])
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.body.session.phase, 'questions')
    assert.equal(calls, 2)
    assert.equal((await req({action:'retry', revision}, async () => { throw new Error('unexpected') })).status, 409)
    // Simulate a worker dying after reserving an expensive Pi turn. Recovery
    // must require an explicit acknowledgement, with no automatic model call.
    const existing = (await store.persistence.onboarding.conversation(alice.id, repo, ''))!
    const hanging = {...JSON.parse(existing.state), revision: existing.revision + 1,
      phase: 'running', startedAt: Date.now() - 11 * 60_000 }
    assert.equal(await store.persistence.onboarding.saveConversation(alice.id, repo, '',
      hanging.revision, JSON.stringify(hanging), existing.revision, new Date().toISOString()), true)
    const recovered = await req({action:'reconcile',revision:hanging.revision}, async () => {
      throw new Error('reconcile must not call Pi')
    })
    assert.equal(recovered.status, 200)
    assert.equal(recovered.body.session.phase, 'blocked')
    assert.equal(calls, 2)
    assert.equal((await req({action:'reconcile',revision:hanging.revision}, async () => {
      throw new Error('duplicate reconcile must not call Pi')
    })).status, 409)
  } finally {
    store.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', prev.key], ['NT_STUDIO_SKILLS_SOURCE', prev.source],
      ['NT_SKILL_CACHE_DIR', prev.cache]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
