import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from './support/studio-database'
import { studioSeed } from './support/studio-seed'
import { migrateStudio, assertStudioSchemaCurrent } from './support/studio-database'
import { readThreadChat, enqueueThreadMessage } from '../src/lib/thread-chat.server'
import { setThreadCreativeMode } from '../src/lib/threads.server'
import { planRevision, planWholeStory, verifyTurnPlan } from '../src/lib/turn-plan'
import { creativePolicy, DEFAULT_CREATIVE_POLICY, hasExplicitCreativeAlternatives,
  parseCreativePolicy, routeCreativeChoice, creativePolicyInstruction } from '../../src/creative-policy'
import type { CompletionContract } from '../../src/architecture'

const config = {
  baseURL: 'http://localhost:3000', secret: 'creative-mode-test-secret-01234567890123456789',
  github: { clientId: 'test', clientSecret: 'test' },
  gitlab: { clientId: 'test', clientSecret: 'test' },
}

test('Thread creative mode default, independent per-Turn snapshots, retries, isolation and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'noveltea-creative-mode-'))
  const filename = join(directory, 'studio.sqlite')
  const db = openStudioDatabase(filename)
  const owner = randomUUID(), other = randomUUID(), threadId = randomUUID()
  const storyId = randomUUID(), repoId = randomUUID(), jobId = randomUUID()
  const at = '2026-11-08T18:00:00.000Z'
  const seed = studioSeed(db)
  try {
    await migrateStudio(db, config)
    await seed.user(owner)
    await seed.user(other)
    await seed.repository({ id: repoId, ownerUserId: owner, provider: 'github',
      providerRepositoryId: '155', name: 'Story repo', createdAt: at })
    await seed.story({ id: storyId, ownerUserId: owner, repositoryId: repoId,
      directory: 'story', title: 'Story', createdAt: at })
    await seed.thread({ id: threadId, ownerUserId: owner, storyId,
      title: 'Thread', activityAt: at, createdAt: at })
    await seed.job({ id: jobId, ownerUserId: owner, storyId, title: 'First run',
      sourceCommitSha: 'a'.repeat(40), status: 'completed', createdAt: at,
      updatedAt: at, generationRequestJson: JSON.stringify({
        task: 'Original story request', fixture: true,
      }) })
    await seed.threadRun({ jobId, ownerUserId: owner, threadId, runOrder: 0 })
    await seed.queue({ jobId, ownerUserId: owner, intent: 'start', phase: 'finished',
      createdAt: at, updatedAt: at })
    assert.equal((await readThreadChat(db, owner, threadId)).creativePolicy.mode, 'autonomous')
    await assert.rejects(() => setThreadCreativeMode(db, other, threadId, 'collaborative'),
      /Thread not found/)
    await assert.rejects(() => setThreadCreativeMode(db, owner, threadId, 'inventive' as never),
      /Unknown creative mode/)
    await setThreadCreativeMode(db, owner, threadId, 'collaborative')

    const first = randomUUID(), second = randomUUID(), third = randomUUID()
    const instruction1 = 'Make character.nia either distrustful or trusting'
    const instruction2 = 'Make event.confession more personal'
    const instruction3 = 'Revise authored-content.confession with two possible voices'
    await enqueueThreadMessage(db, owner, threadId, first, instruction1)
    await setThreadCreativeMode(db, owner, threadId, 'autonomous')
    await enqueueThreadMessage(db, owner, threadId, second, instruction2)
    await enqueueThreadMessage(db, owner, threadId, third, instruction3, undefined, 'collaborative')
    assert.equal((await readThreadChat(db, owner, threadId)).creativePolicy.mode, 'autonomous')
    const firstRead = await readThreadChat(db, owner, threadId)
    const policyFor = (id: string) => firstRead.turnReceipts.find(turn => turn.id === id)?.creativePolicy.mode
    assert.equal(policyFor(first), 'collaborative')
    assert.equal(policyFor(second), 'autonomous')
    assert.equal(policyFor(third), 'collaborative')
    assert.equal(firstRead.messages.find(m => m.id === first)?.creativeModeOverride, null)
    assert.equal(firstRead.messages.find(m => m.id === third)?.creativeModeOverride, 'collaborative')
    const retry = await enqueueThreadMessage(db, owner, threadId, first, instruction1)
    assert.equal(retry.id, first)
    assert.equal(retry.creativePolicyJson, firstRead.messages.find(message => message.id === first)?.creativePolicyJson)
    await assert.rejects(
      () => enqueueThreadMessage(db, owner, threadId, third, instruction3, undefined, 'autonomous'),
      /already in use/)
    await assert.rejects(
      () => enqueueThreadMessage(db, other, threadId, randomUUID(), 'Unauthorized', undefined, 'collaborative'),
      /not found/)
    await assert.rejects(() => db.testing.records.update('story_turns', { id: first },
      { creativePolicyJson: JSON.stringify(creativePolicy('autonomous')) }),
    /immutable/)
    assert.deepEqual(await db.testing.foreignKeyViolations(), [])
  } finally { db.close() }
  try {
    const restarted = openStudioDatabase(filename)
    try {
      await assertStudioSchemaCurrent(restarted)
      const chat = await readThreadChat(restarted, owner, threadId)
      assert.equal(chat.creativePolicy.mode, 'autonomous')
      assert.deepEqual(chat.turnReceipts.filter(turn => turn.id !== 'initial:' + jobId)
        .map(turn => turn.creativePolicy.mode),
      ['collaborative', 'autonomous', 'collaborative'])
      assert.deepEqual(await restarted.testing.foreignKeyViolations(), [])
    } finally { restarted.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('creative policy routes ordinary ambiguity without changing safety gates', () => {
  const autonomous = DEFAULT_CREATIVE_POLICY
  const collaborative = creativePolicy('collaborative')
  assert.deepEqual(parseCreativePolicy(JSON.stringify(collaborative)), collaborative)
  assert.equal(hasExplicitCreativeAlternatives('Make character.nia either brave or reserved'), true)
  assert.equal(hasExplicitCreativeAlternatives('Choose between a quiet or dramatic ending'), true)
  assert.equal(hasExplicitCreativeAlternatives('Fix broken YAML and duplicate identifiers'), false)
  assert.equal(routeCreativeChoice(autonomous, 'creative-ambiguity'), 'proceed')
  assert.equal(routeCreativeChoice(collaborative, 'creative-ambiguity'), 'ask-author')
  assert.equal(routeCreativeChoice(autonomous, 'routine'), 'proceed')
  assert.equal(routeCreativeChoice(collaborative, 'routine'), 'proceed')
  for (const policy of [autonomous, collaborative]) {
    assert.equal(routeCreativeChoice(policy, 'blocked'), 'ask-author')
    assert.equal(routeCreativeChoice(policy, 'consequential'), 'ask-author')
    assert.equal(routeCreativeChoice(policy, 'protected-canon'), 'deny')
    assert.equal(routeCreativeChoice(policy, 'invalid-change'), 'deny')
  }
  assert.match(creativePolicyInstruction(collaborative), /Ask the author/)
  assert.match(creativePolicyInstruction(autonomous), /Resolve ordinary/)
  for (const value of [null, {}, { version: 2, mode: 'autonomous' },
    { version: 1, mode: 'hybrid' }, { version: 1, mode: 'autonomous', grant: 'write' }]) {
    assert.throws(() => parseCreativePolicy(value))
  }
})

test('creative policy is included in immutable, integrity-checked whole-Story and revision plans', () => {
  const base = 'a'.repeat(40)
  const contract = { scope: { kind: 'full-story' as const, depth: 'composition' as const,
    targets: [] as string[], branches: [] as string[] },
  constraints: [] as string[], envelope: { presentation: 'Dialogue-led visual novel',
    hardLimits: [] as string[], preferences: [] as string[] } } satisfies CompletionContract
  const full = planWholeStory('A story with branching dialogue', contract, base)
  assert.deepEqual(full.creativePolicy, DEFAULT_CREATIVE_POLICY)
  verifyTurnPlan(full)

  const focused = { ...contract, scope: { kind: 'partial' as const, depth: 'architecture' as const,
    targets: ['character.nia'], branches: [] as string[] } }
  const catalog = [{ path: 'characters/nia.md', metadata: { id: 'character.nia',
    status: 'draft', type: 'character' } }] as Parameters<typeof planRevision>[4]
  const result = (mode: 'autonomous' | 'collaborative') => planRevision(
    'Make character.nia either brave or reserved', focused,
    base, 'source-job', catalog, ['character.nia'], ['characters/nia.md'], null, creativePolicy(mode))
  const auto = result('autonomous')
  const collab = result('collaborative')
  assert.notEqual(auto.digest, collab.digest)
  verifyTurnPlan(auto)
  verifyTurnPlan(collab)
  assert.deepEqual(collab.creativePolicy, creativePolicy('collaborative'))
  assert.throws(() => verifyTurnPlan({ ...collab, creativePolicy: creativePolicy('autonomous') }), /integrity/)
  assert.throws(() => verifyTurnPlan({ ...collab, creativePolicy: { version: 2 } as never }), /Invalid/)
})
