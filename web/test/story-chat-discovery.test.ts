import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { startStoryJob } from '../../src/job'
import { readDiscoveryHandoff } from '../../src/discovery-generation-handoff'
import { inspectPiPolicy } from '../../src/job-pi-policy'
import { requireGenerationTurn } from '../../src/generation'
import { readHandoffEffect } from '../src/lib/discovery-handoff-effects.server'
import { initialStoryDocument } from '../src/lib/git-cache.server'
import { openStoryThread } from '../src/lib/story-threads.server'
import { removeTestTree } from '../../test/helpers'
import { createStudioAuth } from '../src/lib/auth'
import { submitFirstStoryTurn } from '../src/lib/story-first-chat.server'
import { storyChatDiscoveryRequest } from '../src/lib/story-chat-discovery.server'
import { openStudioBusinessFixture } from './support/studio-database'
import { openSharedStudioStore } from '../src/db/shared-studio-store'
import { userPiCredentials, availableUserPiModels } from '../src/lib/pi-credentials.server'
import { listStoryThreads } from '../src/lib/story-threads.server'
import { DiscoveryInvocationNotStarted, type DiscoveryInference } from '../src/lib/onboarding-pi.server'
import { planningDimensions, planningDimensionPaths } from '../../src/planning-interpretation'
import { withFixtureSemanticReview } from './support/discovery-semantic-fixture'

const url = 'http://localhost:3000'
if (process.env.NT_REQUIRE_KYSELY_PROOF === '1' && !process.env.NT_TEST_PG_URL)
  throw new Error('Discovery conformance requires NT_TEST_PG_URL')
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
    const fromBranching = path.startsWith('planning.branching.') && branching
    const fromClarification = path === 'planning.puzzle_emphasis' && puzzleClarification
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

for (const backend of ['sqlite', 'postgres'] as const) test(`${backend}: ordinary Story Chat discovery uses one pinned first Turn, preserves partial and delegated answers and requires native-validated exact approval`, {
  timeout: 180_000,
  skip: backend === 'postgres' && !process.env.NT_TEST_PG_URL && 'Set NT_TEST_PG_URL for PostgreSQL certification',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-chat-discovery-'))
  const previous = { key: process.env.NT_PI_CREDENTIAL_KEY, source: process.env.NT_STUDIO_SKILLS_SOURCE,
    cache: process.env.NT_SKILL_CACHE_DIR, evidence: process.env.NT_DISCOVERY_EVIDENCE_DIR }
  process.env.NT_DISCOVERY_EVIDENCE_DIR = join(root, 'discovery-evidence')
  process.env.NT_PI_CREDENTIAL_KEY = randomBytes(32).toString('base64')
  process.env.NT_STUDIO_SKILLS_SOURCE = skills(root)
  process.env.NT_SKILL_CACHE_DIR = join(root, 'snapshots')
  const fixture = await openStudioBusinessFixture(backend)
  let store = fixture.store
  let reopened: typeof store | undefined
  try {
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
    const storyIds = Array.from({ length: 7 }, () => randomUUID())
    const sourceSha = 'b'.repeat(40)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const cache = join(root, 'git-cache', hash(alice), hash('github:34'))
    const repository = join(cache, 'base')
    const correctedStory = join(repository, 'stories/4')
    mkdirSync(join(correctedStory, 'creative-direction'), { recursive: true })
    writeFileSync(join(correctedStory, 'creative-direction/foundation.md'), initialStoryDocument('The Last Bell'))
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    git('init', '-q', '--initial-branch=main')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Unapproved Story')
    const correctedSource = git('rev-parse', 'HEAD')
    for (const [i, storyId] of storyIds.entries()) {
      await store.persistence.onboarding.importStory({
        id: storyId, owner: alice, repositoryId, directory: 'stories/' + i,
        title: 'Unapproved Story', createdAt: 'now', commitSha: i === 4 ? correctedSource : sourceSha,
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
      assert.equal(session.graphOperation?.status, 'claimed')
      assert.ok(await store.persistence.onboarding.conversation(alice, repositoryId,
        'story-discovery-graph,' + session.graphEpoch), 'checkpoint must precede inference')
      assert.equal(await store.persistence.generation.jobs.identity(firstId), null)
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
    const execution = await store.persistence.onboarding.conversation(alice, repositoryId,
      'story-chat,' + storyIds[0] + ',' + firstId)
    const graphEpoch = JSON.parse(execution!.state).graphEpoch
    assert.ok(graphEpoch, 'first Turn has an independent current-format graph identity')
    const checkpoint = await store.persistence.onboarding.conversation(alice, repositoryId,
      'story-discovery-graph,' + graphEpoch)
    assert.ok(checkpoint, 'LangGraph interrupt is persisted before returning questions')
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
    assert.deepEqual(await store.persistence.onboarding.conversation(alice, repositoryId,
      'story-discovery-graph,' + graphEpoch), checkpoint, 'drafts cannot resume the graph')
    reopened = openSharedStudioStore(fixture.databaseOptions)
    store = reopened
    auth = createStudioAuth(store, config)
    assert.deepEqual((await req(storyIds[0]!, firstId, 'GET')).body.session.drafts, drafts)
    const interrupted = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: savedDraft.body.session.revision,
          setId: set.id, setRevision: set.revision, responses: answers }),
      }), url, storyIds[0]!, firstId, async () => { throw new DiscoveryInvocationNotStarted('synthetic model admission failure') })
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
      }), url, storyIds[0]!, firstId, withFixtureSemanticReview(async state => proposalFor(state)))
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
      i.path === 'planning.branching.depth').value, '"shallow"')
    assert.equal(proposed.proposal.interpretations.find((i: any) =>
      i.path === 'planning.branching.depth').basis, 'inferred')
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
    // Crash at each of the three durable approval boundaries. Both real
    // persistence backends must recover the exact proposal without Pi.
    const recoverApproval = async (storyId: string, turnId: string, proposal: any,
      interruptedAt: 'reserved' | 'claimed' | 'settled') => {
      const workspace = 'story-chat,' + storyId + ',' + turnId
      const persistence = store.persistence.onboarding
      const save = persistence.saveConversation.bind(persistence)
      let interrupted = false
      persistence.saveConversation = async (...args: Parameters<typeof save>) => {
        const state = args[2] === workspace ? JSON.parse(args[4]) : null
        const failAt = interruptedAt === 'reserved' ? 'claimed' :
          interruptedAt === 'claimed' ? 'settled' : null
        if (!interrupted && state?.graphOperation?.kind === 'approve' &&
            state.graphOperation.status === failAt) {
          interrupted = true
          throw Error('synthetic approval process interruption')
        }
        const result = await save(...args)
        if (!interrupted && interruptedAt === 'settled' && state?.graphOperation?.kind === 'approve' &&
            state.graphOperation.status === 'settled') {
          interrupted = true
          throw Error('synthetic interruption after approval receipt')
        }
        return result
      }
      try {
        const response = await req(storyId, turnId, 'POST', {
          action: 'approve', revision: proposal.revision, digest: proposal.digest,
        })
        assert.notEqual(response.status, 200)
        assert.equal(interrupted, true)
      } finally { persistence.saveConversation = save }
      const row = (await persistence.conversation(alice, repositoryId, workspace))!
      const state = JSON.parse(row.state)
      assert.equal(state.graphOperation.status, interruptedAt)
      assert.equal(await store.persistence.generation.jobs.identity(turnId), null)
      // Reload through another connection; the saved operation, not a
      // browser replay or new model answer, is authoritative.
      const interruptedStore = store
      const recoveryStore = openSharedStudioStore(fixture.databaseOptions)
      store = recoveryStore
      auth = createStudioAuth(store, config)
      try {
      if (interruptedAt !== 'settled') {
        state.startedAt = Date.now() - 11 * 60_000
        assert.equal(await save(alice, repositoryId, workspace, row.revision + 1,
          JSON.stringify({ ...state, revision: row.revision + 1 }), row.revision, 'now'), true)
        const recovered = await req(storyId, turnId, 'POST', {
          action: 'reconcile', revision: row.revision + 1,
        })
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
      }
      const recovered = await req(storyId, turnId, 'GET')
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
      assert.equal(recovered.body.session.phase, 'approved')
      assert.deepEqual(recovered.body.session.proposal.foundation.planning,
        proposal.proposal.foundation.planning)
      assert.equal(await store.persistence.generation.jobs.identity(turnId), null)
      return recovered
      } finally {
        await recoveryStore.close()
        store = interruptedStore
        auth = createStudioAuth(store, config)
      }
    }
    const approve = await recoverApproval(storyIds[0]!, firstId, proposed, 'reserved')
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
    })).status, 200, 'identical approval submission is idempotent')
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
    await reopened.close()
    reopened = openSharedStudioStore(fixture.databaseOptions)
    store = reopened
    auth = createStudioAuth(store, config)
    assert.equal((await req(storyIds[0]!, firstId, 'GET')).body.session.phase, 'approved')
    assert.deepEqual((await req(storyIds[0]!, firstId, 'GET')).body.session.proposal.foundation.planning,
      proposed.proposal.foundation.planning)
    await fixture.records.update('stories', { id: storyIds[0]! },
      { sourceCommitSha: 'c'.repeat(40) })
    assert.equal((await req(storyIds[0]!, firstId, 'GET')).status, 409,
      'moving the Story source invalidates the bound discovery')
    // Explicit comprehensive delegation skips questions, not the exact review.
    const delegatedId = randomUUID()
    const delegatedPrompt = 'Make me a mystery game. Decide everything; do not ask me questions.'
    const delegated = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[1]!, jobId: delegatedId, prompt: delegatedPrompt,
      creativeMode: 'collaborative',
    }, withFixtureSemanticReview(async state => proposalFor(state)))
    assert.equal(delegated.state, 'discovery')
    const delegatedSession = (await req(storyIds[1]!, delegatedId, 'GET')).body.session
    assert.equal(delegatedSession.phase, 'proposed')
    assert.equal(delegatedSession.proposal.task, delegatedPrompt)
    await recoverApproval(storyIds[1]!, delegatedId, delegatedSession, 'claimed')
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
    assert.equal((await req(storyIds[2]!, collaborativeId, 'POST', {
      action: 'answer', revision: roundOne.revision, setId: set.id,
      setRevision: roundOne.questions.revision, responses: answers,
    })).status, 409, 'a Question Set from another Thread cannot resume this interrupt')
    assert.equal(await store.persistence.generation.jobs.identity(collaborativeId), null)
    const followup = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('./support/discovery-restart-worker.ts', import.meta.url))], {
      encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ options: fixture.databaseOptions, config, url,
        cookie: aliceCookie, storyId: storyIds[2]!, turnId: collaborativeId,
        submission: { action: 'answer', revision: roundOne.revision,
          setId: roundOne.questions.id, setRevision: roundOne.questions.revision,
          responses: [{ questionId: 'mystery', answer: { kind: 'custom',
            text: 'Investigate a missing person', note: '' } }] },
        questions: [{ id: 'ending', kind: 'yes-no',
          question: 'Should the missing person return by the ending?', allowStudioDecision: true },
          { id: 'baseline', kind: 'free-text',
            question: 'May Studio decide all remaining Story baseline creative requirements?',
            allowStudioDecision: true }],
      }),
    }))
    assert.equal(followup.status, 200)
    const roundTwo = followup.body.session
    assert.equal((await req(storyIds[2]!, collaborativeId, 'GET')).body.session.revision, roundTwo.revision)
    assert.equal(roundTwo.phase, 'questions')
    assert.notEqual(roundTwo.questions.id, roundOne.questions.id)
    assert.equal(roundTwo.accepted.length, 1)
    let resolvingCalls = 0
    const resolveRound = (connection: typeof store) => storyChatDiscoveryRequest(createStudioAuth(connection, config), connection,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: roundTwo.revision,
          setId: roundTwo.questions.id, setRevision: roundTwo.questions.revision,
          responses: [{ questionId: 'ending', answer: { kind: 'delegate', note: '' } },
            { questionId: 'baseline', answer: { kind: 'delegate', note: '' } }],
        }),
      }), url, storyIds[2]!, collaborativeId, withFixtureSemanticReview(async state => {
        resolvingCalls++
        return proposalFor(state)
      }))
    const results = await Promise.all([resolveRound(store), resolveRound(fixture.store)])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    assert.equal(resolvingCalls, 1, 'concurrent resume cannot invoke the writer twice')
    const resolved = results.find(r => r.status === 200)!
    const resolvedSession = (await resolved.json() as any).session
    assert.equal(resolvedSession.phase, 'proposed')
    assert.equal(resolvedSession.accepted.length, 2)
    assert.match(resolvedSession.proposal.foundation.decisions[1].statement, /Investigate a missing person/)
    assert.equal(resolvedSession.proposal.task, 'Help me make a mystery game')
    assert.equal((await resolveRound(store)).status, 409, 'settled resume cannot be repeated')
    assert.equal(resolvingCalls, 1)
    assert.equal((await listStoryThreads(store, alice, storyIds[2]!)).threads.length, 1)
    await recoverApproval(storyIds[2]!, collaborativeId, resolvedSession, 'settled')
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
    // A pre-cutover questionnaire is explicitly restarted, never adapted
    // or replayed through a hidden compatibility reader/model call.
    const legacyKey = 'story-chat,' + storyIds[3] + ',' + prematureId
    const beforeLegacy = (await store.persistence.onboarding.conversation(alice,
      repositoryId, legacyKey))!
    const existingLegacy = JSON.parse(beforeLegacy.state)
    const oldSession = { ...existingLegacy, revision: beforeLegacy.revision + 1,
      graphEpoch: undefined, graphStartRevision: undefined, graphOperation: undefined }
    // Even structured beta sessions cannot execute without a graph checkpoint.
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
    // A pre-cutover session that already reached a proposal cannot quietly use
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
    const resetRow = (await store.persistence.onboarding.conversation(alice, repositoryId, legacyKey))!
    assert.notEqual(JSON.parse(resetRow.state).graphEpoch, existingLegacy.graphEpoch)
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
          allowStudioDecision: true,
          options: [{ id: 'no-puzzles', title: 'No Puzzles' },
            { id: 'custom', title: 'Include custom Puzzles' }] }])
      })
    assert.equal(conflicted.status, 200)
    const clarified = (await conflicted.json() as any).session
    assert.equal(correctionCalls, 2)
    assert.equal(clarified.phase, 'questions')
    assert.equal(clarified.accepted.length, 1)
    assert.equal(clarified.questions.questions[0].delegationAllowed, undefined,
      'a trusted mandatory clarification must refuse model-requested delegation')
    const rejectedDelegation = await req(storyIds[4]!, conflictId, 'POST', {
      action: 'answer', revision: clarified.revision,
      setId: clarified.questions.id, setRevision: clarified.questions.revision,
      responses: [{ questionId: 'puzzle-clarification', answer: { kind: 'delegate', note: '' } }],
    })
    assert.equal(rejectedDelegation.status, 422)
    let provenanceAttempts = 0
    const lunaTransport = withFixtureSemanticReview(async (state, instructions) => {
      provenanceAttempts++
      const value = JSON.parse(proposalFor(state))
      if (provenanceAttempts === 1) {
        value.interpretations.find((i: any) => i.path === 'planning.puzzle_emphasis').source = {
          kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'puzzle-guidance',
        }
      } else if (provenanceAttempts === 2) {
        assert.match(instructions, /later author clarification/i)
        value.foundation.decisions.push({ statement: 'The bell is made of silver',
          authority: 'user-protected', source: { kind: 'turn', index: 0 } })
      } else {
        assert.equal(provenanceAttempts, 3)
        assert.match(instructions, /un-delegated Studio suggestion/i)
      }
      return JSON.stringify(value)
    })
    const lunaRequest = (value: unknown) => storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url }, body: JSON.stringify(value),
      }), url, storyIds[4]!, conflictId, lunaTransport)
    const lunaWorkspace = 'story-chat,' + storyIds[4] + ',' + conflictId
    const persistence = store.persistence.onboarding
    const originalSave = persistence.saveConversation.bind(persistence)
    let lunaInterrupted = false
    // Kill the worker after the first rejected response has been sealed, but
    // before the corrective model turn can acquire its own durable claim.
    persistence.saveConversation = async (...args: Parameters<typeof originalSave>) => {
      const state = args[2] === lunaWorkspace ? JSON.parse(args[4]) : null
      if (state?.graphOperation?.status === 'claimed' && state.activeAttempts?.length === 2)
        lunaInterrupted = true
      if (lunaInterrupted && state) throw Error('synthetic worker exit after settled writer response')
      return originalSave(...args)
    }
    try {
      const crashed = await lunaRequest({ action: 'answer', revision: clarified.revision,
        setId: clarified.questions.id, setRevision: clarified.questions.revision,
        responses: [{ questionId: 'puzzle-clarification', answer: {
          kind: 'option', optionId: 'no-puzzles', note: '' } }],
      })
      assert.equal(crashed.status, 503)
      assert.equal(lunaInterrupted, true)
      assert.equal(provenanceAttempts, 1)
    } finally { persistence.saveConversation = originalSave }
    const row = (await persistence.conversation(alice, repositoryId, lunaWorkspace))!
    const interruptedState = JSON.parse(row.state)
    assert.equal(interruptedState.graphOperation.status, 'claimed')
    assert.equal(interruptedState.activeAttempts.length, 1)
    assert.ok(interruptedState.activeAttempts[0].responseDigest)
    const originalOperation = interruptedState.graphOperation.id
    const originalStart = Date.now() - 11 * 60_000
    assert.equal(await originalSave(alice, repositoryId, lunaWorkspace, row.revision + 1,
      JSON.stringify({ ...interruptedState, revision: row.revision + 1, startedAt: originalStart }),
      row.revision, 'now'), true)
    const priorStore = store
    const recoveryStore = openSharedStudioStore(fixture.databaseOptions)
    store = recoveryStore
    auth = createStudioAuth(store, config)
    let resolvedConflict: Response
    try {
      const reconciled = await lunaRequest({ action: 'reconcile', revision: row.revision + 1 })
      assert.equal(reconciled.status, 200, await reconciled.clone().text())
      const blocked = (await reconciled.json() as any).session
      assert.equal(provenanceAttempts, 1, 'reconciliation must not call Pi')
      const reconciledState = JSON.parse((await store.persistence.onboarding.conversation(
        alice, repositoryId, lunaWorkspace))!.state)
      assert.equal(reconciledState.recovery.operationId, originalOperation)
      assert.equal(reconciledState.startedAt, originalStart)
      resolvedConflict = await lunaRequest({ action: 'retry', revision: blocked.revision })
      assert.equal(resolvedConflict.status, 200, await resolvedConflict.clone().text())
      assert.equal((await resolvedConflict.clone().json() as any).session.startedAt, originalStart,
        'retry cannot mint a fresh resource allowance')
    } finally {
      await recoveryStore.close()
      store = priorStore
      auth = createStudioAuth(store, config)
    }
    assert.equal(resolvedConflict.status, 200)
    assert.equal(provenanceAttempts, 3, 'both distinct source defects must be corrected before Review')
    const resolvedProposal = (await resolvedConflict.json() as any).session
    assert.equal(resolvedProposal.phase, 'proposed')
    assert.equal(resolvedProposal.proposal.foundation.planning.puzzle_emphasis, 'none')
    assert.equal(resolvedProposal.proposal.interpretations.find((i: any) =>
      i.path === 'planning.puzzle_emphasis').source.questionId, 'puzzle-clarification')
    assert.match(resolvedProposal.proposal.foundation.body, /Planning interpretations/)
    const executionEnv = Object.fromEntries(['NT_STATE_DIR', 'NT_GIT_CACHE_DIR',
      'NT_REQUIRE_USER_PI_RUNTIME', 'NT_AGENT_RPC_URL', 'NT_AGENT_RPC_TOKEN', 'NT_CONFIG_FILE']
      .map(name => [name, process.env[name]]))
    try {
      process.env.NT_STATE_DIR = join(root, 'generation-state')
      process.env.NT_GIT_CACHE_DIR = join(root, 'git-cache')
      process.env.NT_REQUIRE_USER_PI_RUNTIME = '1'
      process.env.NT_AGENT_RPC_URL = 'http://127.0.0.1:9999'
      process.env.NT_AGENT_RPC_TOKEN = 'disposable-controller-fixture'
      const configPath = join(root, 'skills-config.json')
      writeFileSync(configPath, JSON.stringify({
        novelteaSkills: process.env.NT_STUDIO_SKILLS_SOURCE, skillDiscovery: 'explicit-only',
      }))
      process.env.NT_CONFIG_FILE = configPath
      let gatewayCalls = 0
      const gateway = async (_auth: unknown, _store: unknown, request: Request,
        _url: string, effect?: import('../src/lib/discovery-handoff-effects.server').ProviderHandoffEffect) => {
        gatewayCalls++
        if (gatewayCalls === 1) return Response.json({ error: 'Provider temporarily unavailable' }, { status: 503 })
        const input = await request.json() as { storyId: string; jobId: string; commit: string }
        assert.deepEqual(input, { storyId: storyIds[4], jobId: conflictId, commit: correctedSource })
        await effect?.('provider-verified')
        await effect?.('worktree-started')
        await startStoryJob({ story: correctedStory, job: conflictId, worktreeCacheRoot: cache })
        await store.persistence.generation.jobs.register(alice, conflictId, storyIds[4]!,
          'The Last Bell', correctedSource, new Date().toISOString())
        await store.persistence.conversations.reconcileRoots(alice, storyIds[4]!)
        // Lose the response after the registration, before recording settlement.
        return Response.json({ error: 'Lost acquisition response' }, { status: 503 })
      }
      const continueRequest = (action: 'approve' | 'continue', revision: number, digest: string) =>
        storyChatDiscoveryRequest(auth, store,
          new Request(url + '/api/story-chat-discovery', { method: 'POST',
            headers: { cookie: aliceCookie, origin: url },
            body: JSON.stringify({ action, revision, digest }),
          }), url, storyIds[4]!, conflictId,
          async () => { throw Error('Approval must not dispatch another Discovery writer') }, { github: gateway })
      const approved = await continueRequest('approve', resolvedProposal.revision, resolvedProposal.digest)
      const approval = await approved.json() as any
      assert.equal(approved.status, 200, JSON.stringify(approval))
      assert.equal(approval.continuation.state, 'blocked')
      const lost = await continueRequest('continue', approval.session.revision, approval.session.digest)
      assert.equal((await lost.json() as any).continuation.state, 'blocked')
      const recovered = await continueRequest('continue', approval.session.revision, approval.session.digest)
      const continued = await recovered.json() as any
      assert.equal(continued.continuation.state, 'queued', JSON.stringify(continued.continuation))
      const job = await startStoryJob({ story: correctedStory, job: conflictId, worktreeCacheRoot: cache }, false)
      const handoff = await readDiscoveryHandoff(job)
      assert.ok(handoff && handoff.usage.modelCalls > 1, 'prior Discovery rounds contribute to the shared meter')
      assert.deepEqual((await inspectPiPolicy(job)).budget, handoff.usage)
      assert.equal((await readHandoffEffect(store, alice, repositoryId, storyIds[4]!, conflictId))?.stage, 'queue-settled')
      const request = JSON.parse((await store.persistence.generation.jobs.state(alice, conflictId))!.requestJson!)
      await requireGenerationTurn(job, request)
      await assert.rejects(requireGenerationTurn(job, { ...request, discoveryHandoffDigest: '0'.repeat(64) }), /handoff/)
      assert.equal((await store.persistence.generation.queue.record(conflictId))?.phase, 'queued')
      const thread = await openStoryThread(store, alice, storyIds[4]!, 'root:' + conflictId)
      assert.deepEqual(thread.state.turns, [{ id: conflictId, executionIds: [conflictId] }])
      assert.equal(thread.state.messages[0]?.content, initial)
      assert.equal(thread.state.messages[0]?.phase, 'running')
      assert.equal(gatewayCalls, 2)
      const duplicate = await continueRequest('continue', approval.session.revision, approval.session.digest)
      assert.equal((await duplicate.json() as any).continuation.state, 'queued')
      assert.equal(gatewayCalls, 2)
      assert.deepEqual((await inspectPiPolicy(job)).budget, handoff.usage)
      assert.equal(git('rev-parse', 'HEAD'), correctedSource)
    } finally {
      for (const [name, value] of Object.entries(executionEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }

    // Reproduce Luna's failure at the production discovery boundary: an
    // otherwise valid Creative Direction carries unqualified interpretation
    // paths, so the controller must give exact bounded feedback and accept the
    // corrected canonical paths on its one allowed response correction.
    const pathTurnId = randomUUID()
    const pathStarted = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[5]!, jobId: pathTurnId, prompt: initial, creativeMode: 'autonomous',
    }, async (_state, instructions) => {
      assert.match(instructions, /interpretations\[\]\.path MUST use the fully qualified canonical Story planning path/)
      for (const path of planningDimensionPaths) assert.ok(instructions.includes(path),
        'Model instructions must publish the validator path ' + path)
      assert.doesNotMatch(instructions, /"path":"branching\.depth"/)
      return questionsReply([{ id: 'baseline', kind: 'free-text',
        question: 'May Studio decide the complete planning baseline?',
        allowStudioDecision: true }])
    })
    assert.equal(pathStarted.state, 'discovery')
    const pathQuestions = (await req(storyIds[5]!, pathTurnId, 'GET')).body.session
    let pathResponses = 0
    const pathTransport = withFixtureSemanticReview(async (state, instructions) => {
        pathResponses++
        const next = JSON.parse(proposalFor(state))
        if (pathResponses === 1) {
          next.interpretations = next.interpretations.map((item: { path: string }) =>
            ({ ...item, path: item.path.slice('planning.'.length) }))
        } else if (pathResponses === 2) {
          assert.match(instructions, /Invalid planning interpretation path "choice_frequency"/)
          assert.match(instructions, /Expected exactly: planning.choice_frequency, planning.choice_impact/)
          assert.match(instructions, /planning.production.illustrated_backgrounds/)
        }
        // Four distinct source defects are repaired one at a time. Every
        // previously corrected planning claim retains its exact value.
        if (pathResponses >= 2 && pathResponses <= 5) {
          for (const item of next.interpretations.slice(pathResponses - 2, 4))
            item.source = { kind: 'answer', setId: state.accepted![0]!.setId, questionId: 'not-submitted' }
        }
        return JSON.stringify(next)
      })
    const pathRequest = (body: unknown) => storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url }, body: JSON.stringify(body),
      }), url, storyIds[5]!, pathTurnId, pathTransport)
    const pathWorkspace = 'story-chat,' + storyIds[5] + ',' + pathTurnId
    // Cut the actual SQLite checkpoint save after the first writer and
    // first corrective response have settled. The next graph task must
    // recover the original response rather than prompt a second time.
    const interruptAfterSettlement = async (count: number, body: unknown) => {
      let armed = false, checkpointLost = false
      persistence.saveConversation = async (...args: Parameters<typeof originalSave>) => {
        const state = args[2] === pathWorkspace ? JSON.parse(args[4]) : null
        if (armed && (state || args[2].startsWith('story-discovery-graph,'))) {
          if (!state) checkpointLost = true
          throw Error('synthetic checkpoint loss after settled writer ' + count)
        }
        const written = await originalSave(...args)
        if (written && state?.graphOperation?.status === 'claimed' &&
            state.activeAttempts?.length === count && state.activeAttempts.at(-1)?.responseDigest)
          armed = true
        return written
      }
      try {
        const interrupted = await pathRequest(body)
        assert.equal(interrupted.status, 503)
        assert.ok(armed && checkpointLost, 'a real graph checkpoint must be lost after settlement')
        assert.equal(pathResponses, count)
      } finally { persistence.saveConversation = originalSave }
      const row = (await persistence.conversation(alice, repositoryId, pathWorkspace))!
      const state = JSON.parse(row.state)
      assert.equal(state.graphOperation.status, 'claimed')
      assert.equal(state.activeAttempts.length, count)
      assert.ok(state.activeAttempts.every((attempt: any) => attempt.responseDigest))
      assert.equal(await originalSave(alice, repositoryId, pathWorkspace, row.revision + 1,
        JSON.stringify({ ...state, revision: row.revision + 1, startedAt: Date.now() - 11 * 60_000 }),
        row.revision, 'now'), true)
      const reconciled = await pathRequest({ action: 'reconcile', revision: row.revision + 1 })
      assert.equal(reconciled.status, 200, await reconciled.clone().text())
      assert.equal(pathResponses, count, 'reconciliation never dispatches Pi')
      return (await reconciled.json() as any).session
    }
    const firstLoss = await interruptAfterSettlement(1, { action: 'answer', revision: pathQuestions.revision,
      setId: pathQuestions.questions.id, setRevision: pathQuestions.questions.revision,
      responses: [{ questionId: 'baseline', answer: { kind: 'delegate', note: '' } }],
    })
    const correctionLoss = await interruptAfterSettlement(2, { action: 'retry', revision: firstLoss.revision })
    let childEnded = false
    // Lose the parent CAS after the corrected child and independent Review
    // have completed. Recovery must use the sealed responses, not call Pi.
    persistence.saveConversation = async (...args: Parameters<typeof originalSave>) => {
      const state = args[2] === pathWorkspace ? JSON.parse(args[4]) : null
      if (state?.graphOperation?.status === 'settled' && state.phase === 'proposed')
        childEnded = true
      if (childEnded && state) throw Error('synthetic worker exit after Discovery child END')
      return originalSave(...args)
    }
    try {
      const interrupted = await pathRequest({ action: 'retry', revision: correctionLoss.revision })
      assert.equal(interrupted.status, 503)
      assert.ok(childEnded)
      assert.equal(pathResponses, 6)
    } finally { persistence.saveConversation = originalSave }
    const pathRow = (await persistence.conversation(alice, repositoryId, pathWorkspace))!
    const pathState = JSON.parse(pathRow.state)
    assert.equal(pathState.graphOperation.status, 'claimed')
    assert.equal(pathState.activeAttempts.length, 7, 'one format repair and four source corrections need no diagnosis')
    assert.ok(pathState.activeAttempts.every((attempt: any) => attempt.responseDigest))
    assert.equal(await originalSave(alice, repositoryId, pathWorkspace, pathRow.revision + 1,
      JSON.stringify({ ...pathState, revision: pathRow.revision + 1, startedAt: Date.now() - 11 * 60_000 }),
      pathRow.revision, 'now'), true)
    const pathReconciled = await pathRequest({ action: 'reconcile', revision: pathRow.revision + 1 })
    assert.equal(pathReconciled.status, 200, await pathReconciled.clone().text())
    const pathBlocked = (await pathReconciled.json() as any).session
    const repaired = await pathRequest({ action: 'retry', revision: pathBlocked.revision })
    assert.equal(repaired.status, 200, await repaired.clone().text())
    assert.equal(pathResponses, 6, 'post-END recovery must not repeat any writer response')
    const repairedSession = (await repaired.json() as any).session
    assert.equal(repairedSession.phase, 'proposed')
    assert.ok(repairedSession.proposal.interpretations.every((item: { path: string }) =>
      item.path.startsWith('planning.')))
    assert.equal(await store.persistence.naturalStory.previousJob(alice, pathTurnId), null)
    // Exercise resource admission, known provider refusal and independent
    // replacement at the actual authenticated Story Chat entry.
    const controlStory = storyIds[6]!, controlTurn = randomUUID()
    await store.persistence.naturalStory.beginFirstTurn(alice, controlStory, controlTurn,
      initial, new Date().toISOString(), 'autonomous')
    let controlWriterCalls = 0, providerRefused = false
    const controlReviewRoles: string[] = []
    const controlTransport = withFixtureSemanticReview(async state => {
      if (state.turns.length === 1) return questionsReply([{ id: 'baseline', kind: 'free-text',
        question: 'May Studio decide the complete planning baseline?', allowStudioDecision: true }])
      if (!providerRefused) {
        providerRefused = true
        throw new DiscoveryInvocationNotStarted('scripted provider refusal before dispatch')
      }
      controlWriterCalls++
      return proposalFor(state)
    }, (packet, role) => {
      controlReviewRoles.push(role!)
      return packet.claims.map((claim, index) => ({ claimId: claim.id,
        verdict: controlReviewRoles.length === 1 && index === 0 ? 'unsupported' : 'supported',
        reason: 'Assess the actual delegated planning baseline.' }))
    }, packet => [{ claimId: packet.claims[0]!.id, claimQuote: packet.claims[0]!.statement,
      sourceQuote: packet.claims[0]!.question }])
    const controlRequest = (body: unknown, story = controlStory) =>
      storyChatDiscoveryRequest(auth, store, new Request(url + '/api/story-chat-discovery', {
        method: 'POST', headers: { cookie: aliceCookie, origin: url }, body: JSON.stringify(body),
      }), url, story, controlTurn, controlTransport)
    const controlStart = await controlRequest({ action: 'start', model, text: initial, limits: { modelCalls: 1 } })
    assert.equal(controlStart.status, 200, await controlStart.clone().text())
    const controlQuestions = (await controlStart.json() as any).session
    const budgetPause = await controlRequest({ action: 'answer', revision: controlQuestions.revision,
      setId: controlQuestions.questions.id, setRevision: controlQuestions.questions.revision,
      responses: [{ questionId: 'baseline', answer: { kind: 'delegate', note: '' } }] })
    assert.equal(budgetPause.status, 503)
    const budgetState = (await req(controlStory, controlTurn, 'GET')).body.session
    assert.equal(budgetState.recoveryReason, 'budget')
    assert.equal(providerRefused, false, 'exhaustion must precede provider admission')
    const providerPause = await controlRequest({ action: 'retry', revision: budgetState.revision,
      limits: { modelCalls: 8 } })
    assert.equal(providerPause.status, 503)
    const providerState = (await req(controlStory, controlTurn, 'GET')).body.session
    assert.equal(providerState.recoveryReason, 'not-started')
    assert.equal(providerRefused, true)
    const controlDone = await controlRequest({ action: 'retry', revision: providerState.revision })
    assert.equal(controlDone.status, 200, await controlDone.clone().text())
    const controlProposal = (await controlDone.json() as any).session
    assert.equal(controlProposal.phase, 'proposed')
    assert.equal(controlWriterCalls, 2)
    assert.deepEqual(controlReviewRoles, ['semantic-review', 'semantic-review', 'semantic-diagnostic', 'semantic-replacement'])
    const controlPrivate = JSON.parse((await store.persistence.onboarding.conversation(alice, repositoryId,
      'story-chat,' + controlStory + ',' + controlTurn))!.state)
    assert.equal(controlPrivate.settledAttempts.filter((attempt: any) => attempt.responseDigest).length, 7)
    assert.equal(controlPrivate.settledAttempts.filter((attempt: any) => attempt.status === 'not-started').length, 1)
    assert.equal((await controlRequest({ action: 'approve', revision: controlProposal.revision,
      digest: controlProposal.digest }, storyIds[5]!)).status, 404)
    assert.equal(await store.persistence.conversations.archiveThread(alice, 'root:' + controlTurn, true,
      new Date().toISOString()), true)
    assert.equal((await controlRequest({ action: 'approve', revision: controlProposal.revision,
      digest: controlProposal.digest })).status, 409, 'archived author Thread cannot grant approval or queue work')
    assert.equal(controlWriterCalls, 2)
    assert.equal(await store.persistence.generation.jobs.identity(controlTurn), null)
  } finally {
    await reopened?.close()
    await fixture.close()
    for (const [key, value] of [['NT_PI_CREDENTIAL_KEY', previous.key],
      ['NT_STUDIO_SKILLS_SOURCE', previous.source], ['NT_SKILL_CACHE_DIR', previous.cache],
      ['NT_DISCOVERY_EVIDENCE_DIR', previous.evidence]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeTestTree(root)
  }
})
