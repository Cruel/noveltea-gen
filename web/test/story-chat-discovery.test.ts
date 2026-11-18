import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { createStudioAuth } from '../src/lib/auth'
import { submitFirstStoryTurn } from '../src/lib/story-first-chat.server'
import { storyChatDiscoveryRequest } from '../src/lib/story-chat-discovery.server'
import { openStudioDatabase, migrateStudio } from './support/studio-database'
import { userPiCredentials, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { listStoryThreads } from '../src/lib/story-threads.server'
import type { DiscoveryInference } from '../src/lib/onboarding-pi.server'
import { planningDimensions } from '../../src/planning-interpretation'

const url = 'http://localhost:3000'
const questionsReply = (questions: unknown[]) => JSON.stringify({ phase: 'questions',
  questions: { questions } })
const config = {
  baseURL: url, secret: 'chat-discovery-test-secret-0123456789abcdefghijklmnop',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const proposal = JSON.stringify({ phase: 'proposal', task: 'Model-suggested objective (must be ignored)',
  foundation: { id: 'foundation', title: 'The Last Bell', premise: 'A bell vanishes',
    central_conflict: 'The community conceals the culprit', genre: 'Mystery', tone: 'Somber',
    player_experience: 'Investigate clues and choose who to trust', scope: 'A coastal town',
    planning: { choice_frequency: 'occasional', choice_impact: 'lasting',
      branching: { depth: 'shallow', route_exclusivity: 'limited' },
      puzzle_emphasis: 'adventure', pacing: 'balanced',
      first_playthrough: { min_minutes: 90, max_minutes: 120 },
      production: { illustrated_backgrounds: { count: { max: 5 }, firmness: 'hard' },
        character_artwork: { main: { count: { max: 3 }, firmness: 'soft' } } } },
    body: 'A disappearance brings the inhabitants of a coastal town together. The investigator must navigate competing testimony and decide which loyalties are worth keeping.',
    decisions: [{statement: 'A branching resolution', authority: 'delegated'}] } })

const proposalFor = (session: { brief: string; accepted?: Array<{
  setId: string; responses: Array<{ questionId: string; answer: { kind: string } }> }> }) => {
  const value = JSON.parse(proposal)
  const accepted = session.accepted ?? []
  const baseline = accepted.find(batch => batch.responses.some(response =>
    response.questionId === 'baseline'))
  const branching = accepted.find(batch => batch.responses.some(response =>
    response.questionId === 'branching'))
  const puzzleClarification = accepted.find(batch => batch.responses.some(response =>
    response.questionId === 'puzzle-clarification'))
  if (puzzleClarification) value.foundation.planning.puzzle_emphasis = 'none'
  const delegatedAll = /decide everything/i.test(session.brief)
  value.foundation.decisions[0].source = delegatedAll
    ? { kind: 'turn', index: 0 }
    : { kind: 'answer', setId: baseline!.setId, questionId: 'baseline' }
  value.interpretations = planningDimensions(value.foundation.planning).map(({ path }) => {
    const fromBranching = path.startsWith('branching.') && branching
    const fromClarification = path === 'puzzle_emphasis' && puzzleClarification
    const source = fromClarification
      ? { kind: 'answer', setId: puzzleClarification.setId, questionId: 'puzzle-clarification' }
      : fromBranching
      ? { kind: 'answer', setId: branching.setId, questionId: 'branching' }
      : delegatedAll ? { kind: 'turn', index: 0 }
        : { kind: 'answer', setId: baseline!.setId, questionId: 'baseline' }
    return { path, source, basis: fromBranching || fromClarification ? 'inferred' : 'delegated',
      rationale: fromClarification ? 'The later explicit author clarification supersedes conflicting Puzzle requests.'
        : fromBranching ? 'The author requested modest branching without fully linear play.'
        : 'The author expressly delegated remaining baseline decisions to Studio.' }
  })
  return JSON.stringify(value)
}

function skills(root: string) {
  const source = join(root, 'skills-source')
  const discovery = join(source, 'skills', 'nt-story-discovery')
  const catalog = join(source, 'skills', 'nt-catalog')
  mkdirSync(discovery, { recursive: true })
  mkdirSync(join(catalog, 'references'), { recursive: true })
  execFileSync('git', ['init', '-q', source])
  writeFileSync(join(discovery, 'SKILL.md'),
    '---\nname: nt-story-discovery\ndescription: Discovery\n---\nAsk minimum baseline questions.\n')
  writeFileSync(join(catalog, 'SKILL.md'),
    '---\nname: nt-catalog\ndescription: Canonical catalog\n---\nProtect author decisions.\n')
  for (const name of ['records.md', 'authority-and-validation.md', 'glossary.md'])
    writeFileSync(join(catalog, 'references', name), 'Canonical: ' + name + '\n')
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'Pinned discovery fixture'])
  return source
}

test('ordinary Story Chat discovery uses one pinned first Turn, preserves partial and delegated answers and requires native-validated exact approval', {
  timeout: 180_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-chat-discovery-'))
  const previous = { key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR }
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  const filename = join(root, 'studio.sqlite')
  let store = openStudioDatabase(filename)
  try {
    await migrateStudio(store, config)
    let auth = createStudioAuth(store, config)
    const adapter = (await auth.$context).internalAdapter
    const alice = (await adapter.createUser({ name: 'Alice', email: 'alice@chat-discovery.test',
      emailVerified: true }, { method: 'test' })).id
    const bob = (await adapter.createUser({ name: 'Bob', email: 'bob@chat-discovery.test',
      emailVerified: true }, { method: 'test' })).id
    const cookie = async (owner: string) => {
      const session = await adapter.createSession(owner)
      return 'better-auth.session_token=' + session.token + '.' +
        createHmac('sha256', config.secret).update(session.token).digest('base64')
    }
    const aliceCookie = await cookie(alice)
    const bobCookie = await cookie(bob)
    const headers = new Headers({ cookie: aliceCookie })
    const repositoryId = randomUUID()
    await store.persistence.repositories.upsert(alice, 'github', '34',
      'noveltea/mysteries', null, repositoryId, 'now')
    await userPiCredentials(store, alice).modify('openai',
      async () => ({ type: 'api_key', key: 'TEST-USER-ONLY-KEY' }))
    const selected = (await availableUserPiModels(store, alice))[0]!
    const model = { provider: selected.provider, id: selected.id }
    await store.persistence.settings.putDefaultModel(alice, model, 'now')
    const storyIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const sourceSha = 'b'.repeat(40)
    for (const [i, storyId] of storyIds.entries()) {
      await store.persistence.onboarding.importStory({
        id: storyId, owner: alice, repositoryId, directory: 'stories/' + i,
        title: 'Unapproved Story', createdAt: 'now', commitSha: sourceSha,
      })
    }
    const req = async (storyId: string, firstTurnId: string, method: 'GET' | 'POST',
      value?: unknown, who = aliceCookie) => {
      const response = await storyChatDiscoveryRequest(auth, store,
        new Request(url + '/api/story-chat-discovery', {
          method, headers: { cookie: who, origin: url },
          ...(method === 'POST' ? { body: JSON.stringify(value) } : {}),
        }), url, storyId, firstTurnId)
      return { status: response.status, body: await response.json() as any }
    }
    const initial = 'Make me a mystery game'
    const firstId = randomUUID()
    let calls = 0
    const infer: DiscoveryInference = async (session, instructions) => {
      calls++
      assert.match(instructions, /nt-story-discovery\/SKILL.md/)
      assert.match(instructions, /initial baseline/)
      return questionsReply([
        { id: 'setting', kind: 'alternatives', question: 'Where should the mystery be set?',
          options: [{ id: 'coast', title: 'Coastal town' }, { id: 'mountains', title: 'Mountain village' }],
          recommendedId: 'coast', recommendationReason: 'Supports the investigation',
          allowStudioDecision: true },
        { id: 'branching', kind: 'free-text', question: 'How linear should the story be?',
          placeholder: 'Describe your preference', allowStudioDecision: false },
        { id: 'ending', kind: 'yes-no', question: 'Should multiple endings be available?',
          recommendedId: 'yes', allowStudioDecision: true },
        { id: 'baseline', kind: 'free-text',
          question: 'May Studio decide the remaining Story baseline requirements, including Choices, Puzzles, pacing, duration and production budget?',
          allowStudioDecision: true },
      ])
    }
    const first = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[0]!, jobId: firstId, prompt: initial, creativeMode: 'autonomous',
    }, infer)
    assert.equal(first.state, 'discovery')
    assert.equal(first.threadId, 'root:' + firstId)
    assert.equal(calls, 1)
    const questions = await req(storyIds[0]!, firstId, 'GET')
    assert.equal(questions.body.session.phase, 'questions')
    assert.equal(questions.body.session.questions.questions.length, 4)
    assert.equal(questions.body.session.questions.questions[0].recommendedId, 'coast')
    assert.deepEqual(questions.body.session.drafts, {}, 'default delegation is not saved consent')
    assert.equal(questions.body.session.chat.originalObjective, initial)
    assert.equal(questions.body.session.chat.sourceSha, sourceSha)
    assert.equal(questions.body.session.model.provider, model.provider)
    assert.ok(questions.body.session.skillId)
    const replay = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[0]!, jobId: firstId, prompt: initial, creativeMode: 'autonomous',
    }, async () => { throw new Error('Never call the model again on transport retry') })
    assert.equal(replay.state, 'discovery')
    assert.equal(calls, 1)
    const set = questions.body.session.questions
    const answers = [
      { questionId: 'setting', answer: { kind: 'option', optionId: 'coast', note: '' } },
      { questionId: 'branching', answer: { kind: 'custom',
        text: 'somewhat linear, but not too much', note: '' } },
      { questionId: 'ending', answer: { kind: 'delegate', note: '' } },
      { questionId: 'baseline', answer: { kind: 'delegate', note: '' } },
    ]
    const drafts = {
      setting: { selection: 'coast', selectedIds: [], multiCustom: false,
        customAnswer: '', note: '' },
      branching: { selection: '__answer__', selectedIds: [], multiCustom: false,
        customAnswer: 'somewhat linear, but not too much', note: '' },
    }
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'answer', revision: questions.body.session.revision, setId: set.id,
      setRevision: set.revision, responses: answers.slice(0, 2),
    })).status, 422, 'incomplete batch cannot advance')
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'answer', revision: questions.body.session.revision, setId: set.id,
      setRevision: set.revision, responses: [answers[0],
        { questionId: 'branching', answer: { kind: 'delegate', note: '' } }, answers[2]],
    })).status, 422, 'model delegation request cannot override explicit-only policy')
    const savedDraft = await req(storyIds[0]!, firstId, 'POST', {
      action: 'draft', revision: questions.body.session.revision, setId: set.id,
      setRevision: set.revision, drafts,
    })
    assert.equal(savedDraft.status, 200)
    assert.equal(savedDraft.body.session.drafts.branching.customAnswer, 'somewhat linear, but not too much')
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'draft', revision: questions.body.session.revision, setId: set.id,
      setRevision: set.revision, drafts: {},
    })).status, 409, 'stale second tab cannot overwrite newer draft')
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'answer', revision: savedDraft.body.session.revision, setId: set.id,
      setRevision: set.revision, responses: answers,
    }, bobCookie)).status, 404, 'foreign user cannot submit another owner’s set')
    const interrupted = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: savedDraft.body.session.revision,
          setId: set.id, setRevision: set.revision, responses: answers }),
      }), url, storyIds[0]!, firstId, async () => { throw new Error('synthetic provider interruption') })
    const partial = { status: interrupted.status, body: await interrupted.json() as any }
    assert.equal(partial.status, 503)
    const afterFailure = (await req(storyIds[0]!, firstId, 'GET')).body.session
    assert.equal(afterFailure.phase, 'blocked')
    assert.equal(afterFailure.accepted.length, 1)
    assert.deepEqual(afterFailure.accepted[0].responses, answers)
    assert.equal(afterFailure.turns[0].text, initial)
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'answer', revision: questions.body.session.revision, text: 'Stale',
    })).status, 409)
    const recovery = await storyChatDiscoveryRequest(auth, store, new Request(
      url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'retry', revision: partial.body.session?.revision ??
          (await req(storyIds[0]!, firstId, 'GET')).body.session.revision }),
      }), url, storyIds[0]!, firstId, async state => proposalFor(state))
    assert.equal(recovery.status, 200)
    const proposed = (await recovery.json() as any).session
    assert.equal(proposed.phase, 'proposed')
    assert.equal(proposed.proposal.task, initial, 'model task cannot replace the original objective')
    assert.deepEqual(proposed.proposal.foundation.decisions.map((d: any) => d.origin),
      ['user', 'user', 'user', 'user', 'user', 'agent'])
    assert.match(proposed.proposal.foundation.decisions[2].statement,
      /somewhat linear, but not too much/)
    assert.equal(proposed.proposal.foundation.decisions[0].authority, 'user-protected')
    assert.equal(proposed.proposal.foundation.decisions[5].authority, 'delegated')
    assert.equal(proposed.proposal.interpretations.find((i: any) =>
      i.path === 'branching.depth').value, '"shallow"')
    assert.equal(proposed.proposal.interpretations.find((i: any) =>
      i.path === 'branching.depth').basis, 'inferred')
    assert.match(proposed.proposal.foundation.body, /source: Creative Decision `author-answer-2`/)
    assert.equal(proposed.proposal.foundation.planning.production.illustrated_backgrounds.firmness, 'hard')
    assert.deepEqual(proposed.proposal.foundation.planning.first_playthrough,
      { min_minutes: 90, max_minutes: 120 })
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'approve', revision: proposed.revision, digest: 'a'.repeat(64),
    })).status, 409)
    // Native validation is not optional. An unavailable validator leaves the
    // exact proposal intact and cannot synthesize an approved foundation.
    const configuredCli = process.env.NT_NATIVE_CLI
    process.env.NT_NATIVE_CLI = '/does/not/exist/noveltea'
    try {
      assert.equal((await req(storyIds[0]!, firstId, 'POST', {
        action: 'approve', revision: proposed.revision, digest: proposed.digest,
      })).status, 503)
      assert.equal((await req(storyIds[0]!, firstId, 'GET')).body.session.phase, 'proposed')
    } finally {
      if (configuredCli === undefined) delete process.env.NT_NATIVE_CLI
      else process.env.NT_NATIVE_CLI = configuredCli
    }
    const approve = await req(storyIds[0]!, firstId, 'POST', {
      action: 'approve', revision: proposed.revision, digest: proposed.digest,
    })
    assert.equal(approve.status, 200, JSON.stringify(approve.body))
    assert.equal(approve.body.session.phase, 'approved')
    assert.equal(approve.body.continuation.state, 'blocked',
      'without a real controller the exact approval persists but no writer starts')
    assert.equal(approve.body.session.proposal.foundation.decisions.length, 6)
    assert.deepEqual(approve.body.session.proposal.foundation.planning,
      proposed.proposal.foundation.planning)
    const blockedContinuation = await req(storyIds[0]!, firstId, 'POST', {
      action: 'continue', revision: approve.body.session.revision, digest: approve.body.session.digest,
    })
    assert.equal(blockedContinuation.status, 200)
    assert.equal(blockedContinuation.body.continuation.state, 'blocked')
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'approve', revision: proposed.revision, digest: proposed.digest,
    })).status, 409)
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'revise', revision: proposed.revision, text: 'Tamper',
    })).status, 409)
    assert.equal((await req(storyIds[0]!, firstId, 'GET', undefined, bobCookie)).status, 404)
    assert.equal((await req(storyIds[1]!, firstId, 'GET')).status, 404,
      'the other Story cannot reuse this first Turn')
    assert.equal((await listStoryThreads(store, alice, storyIds[0]!)).threads.length, 1)
    assert.equal(await store.persistence.naturalStory.previousJob(alice, firstId), null,
      'discovery approval cannot enqueue generation or create a second execution')
    const persisted = await store.persistence.onboarding.conversation(alice, repositoryId,
      'story-chat,' + storyIds[0] + ',' + firstId)
    assert.equal(JSON.parse(persisted!.state).chat.sourceSha, sourceSha)
    store.close()
    store = openStudioDatabase(filename)
    auth = createStudioAuth(store, config)
    assert.equal((await req(storyIds[0]!, firstId, 'GET')).body.session.phase, 'approved')
    assert.deepEqual((await req(storyIds[0]!, firstId, 'GET')).body.session.proposal.foundation.planning,
      proposed.proposal.foundation.planning)
    await store.testing.records.update('stories', { id: storyIds[0]! },
      { sourceCommitSha: 'c'.repeat(40) })
    assert.equal((await req(storyIds[0]!, firstId, 'GET')).status, 409,
      'moving the Story source invalidates the bound discovery')
    // Explicit comprehensive delegation skips questions, not the exact review.
    const delegatedId = randomUUID()
    const delegatedPrompt = 'Make me a mystery game. Decide everything; do not ask me questions.'
    const delegated = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[1]!, jobId: delegatedId, prompt: delegatedPrompt,
      creativeMode: 'collaborative',
    }, async state => proposalFor(state))
    assert.equal(delegated.state, 'discovery')
    const delegatedSession = (await req(storyIds[1]!, delegatedId, 'GET')).body.session
    assert.equal(delegatedSession.phase, 'proposed')
    assert.equal(delegatedSession.proposal.task, delegatedPrompt)
    assert.equal((await req(storyIds[1]!, delegatedId, 'POST', {
      action: 'approve', revision: delegatedSession.revision, digest: delegatedSession.digest,
    })).status, 200)
    assert.equal((await listStoryThreads(store, alice, storyIds[1]!)).threads.length, 1)
    const collaborativeId = randomUUID()
    const collaborative = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[2]!, jobId: collaborativeId,
      prompt: 'Help me make a mystery game', creativeMode: 'collaborative',
    }, async state => {
      assert.equal(state.turns[0]?.text, 'Help me make a mystery game')
      return questionsReply([{ id: 'mystery', kind: 'free-text',
        question: 'What should the player investigate?', placeholder: 'For example, a disappearance',
        allowStudioDecision: true }])
    })
    assert.equal(collaborative.state, 'discovery')
    const roundOne = (await req(storyIds[2]!, collaborativeId, 'GET')).body.session
    assert.equal(roundOne.phase, 'questions')
    const followup = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: roundOne.revision,
          setId: roundOne.questions.id, setRevision: roundOne.questions.revision,
          responses: [{ questionId: 'mystery', answer: { kind: 'custom',
            text: 'Investigate a missing person', note: '' } }],
        }),
      }), url, storyIds[2]!, collaborativeId, async state => {
        assert.equal(state.accepted?.length, 1)
        assert.match(state.turns.at(-1)!.text, /Investigate a missing person/)
        return questionsReply([{ id: 'ending', kind: 'yes-no',
          question: 'Should the missing person return by the ending?',
          allowStudioDecision: true },
          { id: 'baseline', kind: 'free-text',
            question: 'May Studio decide all remaining Story baseline creative requirements?',
            allowStudioDecision: true }])
      })
    assert.equal(followup.status, 200)
    const roundTwo = (await followup.json() as any).session
    assert.equal(roundTwo.phase, 'questions')
    assert.notEqual(roundTwo.questions.id, roundOne.questions.id)
    assert.equal(roundTwo.accepted.length, 1)
    const resolved = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: roundTwo.revision,
          setId: roundTwo.questions.id, setRevision: roundTwo.questions.revision,
          responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } },
            { questionId: 'baseline', answer: { kind: 'delegate', note: '' } }],
        }),
      }), url, storyIds[2]!, collaborativeId, async state => proposalFor(state))
    assert.equal(resolved.status, 200)
    const resolvedSession = (await resolved.json() as any).session
    assert.equal(resolvedSession.phase, 'proposed')
    assert.equal(resolvedSession.accepted.length, 2)
    assert.match(resolvedSession.proposal.foundation.decisions[1].statement, /Investigate a missing person/)
    assert.equal(resolvedSession.proposal.task, 'Help me make a mystery game')
    assert.equal((await listStoryThreads(store, alice, storyIds[2]!)).threads.length, 1)
    // An insufficiently constrained model cannot treat Autonomous as implied
    // permission to skip baseline questions. Correct it once within the same
    // reserved turn, without persisting its premature proposal.
    const prematureId = randomUUID()
    let prematureCalls = 0
    const corrected = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[3]!, jobId: prematureId, prompt: initial,
      creativeMode: 'autonomous',
    }, async (_state, instructions) => {
      prematureCalls++
      if (prematureCalls === 1) {
        const premature = JSON.parse(proposal)
        premature.foundation.decisions[0].authority = 'user-protected'
        return JSON.stringify(premature)
      }
      assert.match(instructions, /required first baseline discovery questions|source-grounded planning/)
      return questionsReply([{ id: 'main-conflict', kind: 'free-text',
        question: 'What mystery matters to the protagonist?', allowStudioDecision: true }])
    })
    assert.equal(corrected.state, 'discovery')
    assert.equal(prematureCalls, 2)
    assert.equal((await req(storyIds[3]!, prematureId, 'GET')).body.session.phase, 'questions')
    assert.equal((await listStoryThreads(store, alice, storyIds[3]!)).threads.length, 1)
    // A pre-v1 textual questionnaire is explicitly restarted, never adapted
    // or replayed through a hidden compatibility reader/model call.
    const legacyKey = 'story-chat,' + storyIds[3] + ',' + prematureId
    const beforeLegacy = (await store.persistence.onboarding.conversation(alice,
      repositoryId, legacyKey))!
    const existingLegacy = JSON.parse(beforeLegacy.state)
    const oldSession = { ...existingLegacy, revision: beforeLegacy.revision + 1,
      questionContract: undefined, questions: '1. Old numbered question; answer in prose.' }
    assert.equal(await store.persistence.onboarding.saveConversation(alice,
      repositoryId, legacyKey, oldSession.revision, JSON.stringify(oldSession),
      beforeLegacy.revision, new Date().toISOString()), true)
    const legacy = (await req(storyIds[3]!, prematureId, 'GET')).body.session
    assert.equal(legacy.legacyQuestions, true)
    assert.equal(legacy.questions, null)
    assert.equal((await req(storyIds[3]!, prematureId, 'POST', {
      action: 'answer', revision: legacy.revision, text: 'Old unstructured answer',
    })).status, 409)
    const oldBlocked = { ...oldSession, phase: 'blocked',
      revision: oldSession.revision + 1 }
    assert.equal(await store.persistence.onboarding.saveConversation(alice,
      repositoryId, legacyKey, oldBlocked.revision, JSON.stringify(oldBlocked),
      oldSession.revision, new Date().toISOString()), true)
    let illegalRetryCalled = false
    const rejectedRetry = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'retry', revision: oldBlocked.revision }),
      }), url, storyIds[3]!, prematureId, async () => {
        illegalRetryCalled = true
        throw new Error('Never invoke the model for unsupported old sessions')
      })
    assert.equal(rejectedRetry.status, 409)
    assert.equal(illegalRetryCalled, false)
    // A pre-v1 session that already reached a proposal cannot quietly use
    // the new exact-approval path either. Require explicit reset in both UIs.
    const oldProposed = { ...oldSession, phase: 'proposed',
      revision: oldBlocked.revision + 1, proposal: proposed.proposal,
      digest: proposed.digest }
    assert.equal(await store.persistence.onboarding.saveConversation(alice,
      repositoryId, legacyKey, oldProposed.revision, JSON.stringify(oldProposed),
      oldBlocked.revision, new Date().toISOString()), true)
    const unsupported = (await req(storyIds[3]!, prematureId, 'GET')).body.session
    assert.equal(unsupported.legacyQuestions, true)
    assert.equal(unsupported.questions, null)
    assert.equal((await req(storyIds[3]!, prematureId, 'POST', {
      action: 'approve', revision: unsupported.revision, digest: unsupported.digest,
    })).status, 409)
    assert.equal((await req(storyIds[3]!, prematureId, 'POST', {
      action: 'revise', revision: unsupported.revision, text: 'Convert my old answers',
    })).status, 409)
    const restarted = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'restart', revision: unsupported.revision }),
      }), url, storyIds[3]!, prematureId, async state => {
        assert.equal(state.turns.length, 1)
        assert.equal(state.turns[0]?.text, initial)
        assert.equal(state.skillId, existingLegacy.skillId)
        return questionsReply([{ id: 'fresh-plot', kind: 'free-text',
          question: 'What mystery should the story revolve around?',
          allowStudioDecision: true }])
      })
    assert.equal(restarted.status, 200)
    const restartState = (await restarted.json() as any).session
    assert.equal(restartState.legacyQuestions, false)
    assert.equal(restartState.questions.questions[0].id, 'fresh-plot')
    assert.equal(restartState.chat.originalObjective, initial)
    // A contradictory answer requires a later clarification. The model cannot
    // choose its preferred interpretation or infer approval from the author.
    const conflictId = randomUUID()
    const conflict = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[4]!, jobId: conflictId, prompt: initial,
      creativeMode: 'collaborative',
    }, async () => questionsReply([
      { id: 'puzzle-guidance', kind: 'free-text',
        question: 'What Puzzle emphasis should the Story use?' },
      { id: 'baseline', kind: 'free-text',
        question: 'May Studio decide the remaining Story baseline creative requirements?',
        allowStudioDecision: true },
    ]))
    assert.equal(conflict.state, 'discovery')
    const openQuestions = (await req(storyIds[4]!, conflictId, 'GET')).body.session
    let correctionCalls = 0
    const conflicted = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: openQuestions.revision,
          setId: openQuestions.questions.id, setRevision: openQuestions.questions.revision,
          responses: [
            { questionId: 'puzzle-guidance', answer: { kind: 'custom',
              text: 'No puzzles, but I must include custom puzzles.', note: '' } },
            { questionId: 'baseline', answer: { kind: 'delegate', note: '' } },
          ],
        }),
      }), url, storyIds[4]!, conflictId, async (state, instructions) => {
        correctionCalls++
        if (correctionCalls === 1) return proposalFor(state)
        assert.match(instructions, /clarification required/i)
        return questionsReply([{ id: 'puzzle-clarification', kind: 'alternatives',
          question: 'Clarify conflicting Puzzle requirements: which outcome should prevail?',
          options: [{ id: 'no-puzzles', title: 'No Puzzles' },
            { id: 'custom', title: 'Include custom Puzzles' }] }])
      })
    assert.equal(conflicted.status, 200)
    const clarified = (await conflicted.json() as any).session
    assert.equal(correctionCalls, 2)
    assert.equal(clarified.phase, 'questions')
    assert.equal(clarified.accepted.length, 1)
    const resolvedConflict = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: clarified.revision,
          setId: clarified.questions.id, setRevision: clarified.questions.revision,
          responses: [{ questionId: 'puzzle-clarification', answer: {
            kind: 'option', optionId: 'no-puzzles', note: '' } }],
        }),
      }), url, storyIds[4]!, conflictId, async state => proposalFor(state))
    assert.equal(resolvedConflict.status, 200)
    const resolvedProposal = (await resolvedConflict.json() as any).session
    assert.equal(resolvedProposal.phase, 'proposed')
    assert.equal(resolvedProposal.proposal.foundation.planning.puzzle_emphasis, 'none')
    assert.equal(resolvedProposal.proposal.interpretations.find((i: any) =>
      i.path === 'puzzle_emphasis').source.questionId, 'puzzle-clarification')
    assert.match(resolvedProposal.proposal.foundation.body, /Planning interpretations/)
    assert.deepEqual(await store.testing.foreignKeyViolations(), [])
  } finally {
    store.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', previous.key],
      ['NT_STUDIO_SKILLS_SOURCE', previous.source], ['NT_SKILL_CACHE_DIR', previous.cache]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
