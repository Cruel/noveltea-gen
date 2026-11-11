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

const url = 'http://localhost:3000'
const config = {
  baseURL: url, secret: 'chat-discovery-test-secret-0123456789abcdefghijklmnop',
  github: { clientId: 'test', clientSecret: 'test-secret' },
  gitlab: { clientId: 'test', clientSecret: 'test-secret' },
}
const proposal = JSON.stringify({ phase: 'proposal', task: 'Model-suggested objective (must be ignored)',
  foundation: { id: 'foundation', title: 'The Last Bell', premise: 'A bell vanishes',
    central_conflict: 'The community conceals the culprit', genre: 'Mystery', tone: 'Somber',
    player_experience: 'Investigate clues and choose who to trust', scope: 'A coastal town',
    body: 'A disappearance brings the inhabitants of a coastal town together. The investigator must navigate competing testimony and decide which loyalties are worth keeping.',
    decisions: [{statement: 'A branching resolution', authority: 'delegated'}] } })

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
    const storyIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
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
      return JSON.stringify({ phase: 'questions',
        questions: '1. Where is the mystery set? Recommendation: a small coastal town.\n' +
          '2. How should it end? Recommendation: meaningful branches.' })
    }
    const first = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[0]!, jobId: firstId, prompt: initial, creativeMode: 'autonomous',
    }, infer)
    assert.equal(first.state, 'discovery')
    assert.equal(first.threadId, 'root:' + firstId)
    assert.equal(calls, 1)
    const questions = await req(storyIds[0]!, firstId, 'GET')
    assert.equal(questions.body.session.phase, 'questions')
    assert.match(questions.body.session.questions, /Recommendation/)
    assert.equal(questions.body.session.chat.originalObjective, initial)
    assert.equal(questions.body.session.chat.sourceSha, sourceSha)
    assert.equal(questions.body.session.model.provider, model.provider)
    assert.ok(questions.body.session.skillId)
    const replay = await submitFirstStoryTurn(auth, store, headers, url, {
      storyId: storyIds[0]!, jobId: firstId, prompt: initial, creativeMode: 'autonomous',
    }, async () => { throw new Error('Never call the model again on transport retry') })
    assert.equal(replay.state, 'discovery')
    assert.equal(calls, 1)
    const interrupted = await storyChatDiscoveryRequest(auth, store,
      new Request(url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'answer', revision: questions.body.session.revision,
          text: 'Set it in a coastal town. Please choose the ending for me.' }),
      }), url, storyIds[0]!, firstId, async () => { throw new Error('synthetic provider interruption') })
    const partial = { status: interrupted.status, body: await interrupted.json() as any }
    assert.equal(partial.status, 503)
    assert.equal((await req(storyIds[0]!, firstId, 'GET')).body.session.phase, 'blocked')
    assert.equal((await req(storyIds[0]!, firstId, 'POST', {
      action: 'answer', revision: questions.body.session.revision, text: 'Stale',
    })).status, 409)
    const recovery = await storyChatDiscoveryRequest(auth, store, new Request(
      url + '/api/story-chat-discovery', { method: 'POST',
        headers: { cookie: aliceCookie, origin: url },
        body: JSON.stringify({ action: 'retry', revision: partial.body.session?.revision ??
          (await req(storyIds[0]!, firstId, 'GET')).body.session.revision }),
      }), url, storyIds[0]!, firstId, async () => proposal)
    assert.equal(recovery.status, 200)
    const proposed = (await recovery.json() as any).session
    assert.equal(proposed.phase, 'proposed')
    assert.equal(proposed.proposal.task, initial, 'model task cannot replace the original objective')
    assert.deepEqual(proposed.proposal.foundation.decisions.map((d: any) => d.origin),
      ['user', 'user', 'agent'])
    assert.equal(proposed.proposal.foundation.decisions[0].authority, 'user-protected')
    assert.equal(proposed.proposal.foundation.decisions[2].authority, 'delegated')
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
    assert.equal(approve.body.session.proposal.foundation.decisions.length, 3)
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
    }, async () => proposal)
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
      return JSON.stringify({ phase: 'questions', questions:
        '1. What should the player investigate? Recommendation: a missing person. ' +
        '2. Which emotional tone? Recommendation: uneasy but hopeful.' })
    })
    assert.equal(collaborative.state, 'discovery')
    assert.equal((await req(storyIds[2]!, collaborativeId, 'GET')).body.session.phase, 'questions')
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
      if (prematureCalls === 1) return proposal
      assert.match(instructions, /required first baseline discovery questions/)
      return JSON.stringify({ phase: 'questions', questions:
        '1. What mystery matters to the protagonist? Recommendation: a family disappearance.' })
    })
    assert.equal(corrected.state, 'discovery')
    assert.equal(prematureCalls, 2)
    assert.equal((await req(storyIds[3]!, prematureId, 'GET')).body.session.phase, 'questions')
    assert.equal((await listStoryThreads(store, alice, storyIds[3]!)).threads.length, 1)
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
