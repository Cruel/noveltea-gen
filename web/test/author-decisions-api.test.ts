import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStudioDatabase } from '../src/db/connection'
import { migrateStudio } from '../src/db/migrations'
import { createStudioAuth } from '../src/lib/auth'
import { acquireCachedStory } from '../src/lib/git-cache.server'
import { authorInteractionRequest } from '../src/lib/author-interactions.server'
import { recordSpecialistChoice, inspectSpecialistChoice } from '../../src/specialist-choice'
import { removeTestTree } from '../../test/helpers'

const config = {
  baseURL: 'http://localhost:3000', secret: 'shared-author-decision-test-secret-0123456789abc',
  github: { clientId: 'github', clientSecret: 'test-secret' },
  gitlab: { clientId: 'gitlab', clientSecret: 'test-secret' },
}
function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
test('one owner-scoped /author endpoint reviews and approves the exact no-write Foundation without a reason', {
  timeout: 25_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-author-decision-api-'))
  const previous = { state: process.env.NT_STATE_DIR, cache: process.env.NT_GIT_CACHE_DIR }
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  const store = openStudioDatabase(join(root, 'studio.sqlite'))
  try {
    await migrateStudio(store, config)
    const auth = createStudioAuth(store, config), ctx = await auth.$context
    const owners = await Promise.all(['Alice', 'Bob'].map(async name => {
      const user = await ctx.internalAdapter.createUser({
        name, email: name.toLowerCase() + '@author.test', emailVerified: true,
      }, { method: 'test' })
      const s = await ctx.internalAdapter.createSession(user.id)
      const cookie = 'better-auth.session_token=' + s.token + '.' +
        createHmac('sha256', config.secret).update(s.token).digest('base64')
      return { user, cookie }
    }))
    const repo = join(root, 'repository'), story = join(repo, 'story')
    mkdirSync(join(story, 'creative-direction'), { recursive: true })
    writeFileSync(join(story, 'creative-direction', 'foundation.md'), [
      '---', "schema: '0.1'", 'type: creative-direction', 'id: creative-direction.foundation',
      'title: "Archive mystery"', 'status: draft', 'decisions:',
      '  - id: test-discovery', '    statement: "Use only for discovery and preflight"',
      '    origin: user', '    authority: user-protected',
      'premise: "The archive has a missing page"',
      'central_conflict: "Locate the page before closing"',
      'genre: Mystery', 'tone: Curious', 'player_experience: "Choose a path"',
      'scope: "Short visual novel"', '---', '', '# Archive mystery', '',
    ].join('\n'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@invalid.example')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Protected canonical baseline')
    const commit = git(repo, 'rev-parse', 'HEAD')
    const jobId = randomUUID(), storyId = randomUUID(), repositoryId = randomUUID()
    const owner = owners[0]!
    const job = await acquireCachedStory({
      cacheDirectory: process.env.NT_GIT_CACHE_DIR!, ownerId: owner.user.id,
      repositoryId: 'github:123', remoteUrl: 'file://' + repo,
      token: '', directory: 'story', commit, jobId,
    })
    store.sqlite.prepare(`INSERT INTO repositories
      (id,owner_user_id,provider,provider_repository_id,name,created_at)
      VALUES (?,?,'github','123','Fixture/Story','2026-11-03')`).run(repositoryId, owner.user.id)
    store.sqlite.prepare(`INSERT INTO stories
      (id,owner_user_id,repository_id,directory,title,created_at,source_commit_sha)
      VALUES (?,?,?,'story','Story','2026-11-03',?)`).run(storyId, owner.user.id, repositoryId, commit)
    const generation = JSON.stringify({ task: 'Complete the story' })
    store.sqlite.prepare(`INSERT INTO studio_sessions
      (id,owner_user_id,story_id,title,status,source_commit_sha,generation_request_json,
       generation_thread_id,created_at,updated_at)
      VALUES (?,?,?,'Job','blocked',?,?,?,'2026-11-03','2026-11-03')`)
      .run(jobId, owner.user.id, storyId, commit, generation, job.threadId)
    store.sqlite.prepare(`INSERT INTO generation_run_queue
      (job_id,owner_user_id,intent,phase,created_at,updated_at)
      VALUES (?,?,'start','finished','2026-11-03','2026-11-03')`).run(jobId, owner.user.id)

    const sessionId = randomUUID()
    const session = join(job.stateDir, 'foundation-sessions', 'first.jsonl')
    mkdirSync(join(job.stateDir, 'foundation-sessions'), { recursive: true })
    writeFileSync(session, [
      JSON.stringify({ type: 'session', id: sessionId }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text',
          text: 'I found a user-protected decision restricting this Story to discovery. Please authorize a full-generation exception. No edits were made.' }],
      } }),
    ].join('\n') + '\n')
    writeFileSync(join(job.stateDir, 'foundation.json'), JSON.stringify({
      jobId, baseSha: commit, stage: 'writing', writerStarted: true,
      target: 'creative-direction/foundation.md', piSessionId: sessionId, piSessionFile: session,
    }))
    writeFileSync(join(job.stateDir, 'active-specialist.json'), JSON.stringify({
      jobId, phase: 'completed', workItem: 'foundation',
      expectedHead: commit, actualHead: commit, dirtyFiles: [], piStopReason: 'stop',
      piSessionId: sessionId, piSessionFile: session,
    }))
    writeFileSync(join(job.stateDir, 'generation-server-owner.json'), JSON.stringify({
      jobId, requestSha256: createHash('sha256').update(generation).digest('hex'),
    }))
    const api = async (method: 'GET' | 'POST', body?: unknown, sessionCookie = owner.cookie,
      origin = config.baseURL) => {
      const request = new Request(config.baseURL + '/api/jobs/' + jobId + '/author', {
        method, headers: { cookie: sessionCookie, ...(method === 'POST'
          ? { origin, 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })
      const response = await authorInteractionRequest(auth, store, request, jobId, config.baseURL)
      return { status: response.status, data: await response.json() as {
        decisions?: Array<{ id: string; proposalSha256: string; phase: string; decision?: string }>;
        decision?: { phase: string; decision: string };
        choice?: { id: string; phase: string; proposalSha256: string } | null;
        error?: string;
      } }
    }
    assert.equal((await api('GET', undefined, owners[1]!.cookie)).status, 404)
    const view = await api('GET')
    assert.equal(view.status, 200, view.data.error)
    assert.equal(view.data.decisions?.length, 1)
    assert.equal(view.data.decisions?.[0]?.id, 'foundation-conflict')
    const proposalSha256 = view.data.decisions![0]!.proposalSha256
    const decision = { action: 'decision', id: 'foundation-conflict',
      proposalSha256, decision: 'approved' }
    assert.equal((await api('POST', decision, owners[1]!.cookie)).status, 404)
    assert.equal((await api('POST', decision, owner.cookie, 'https://evil.example')).status, 403)
    assert.equal((await api('POST', { ...decision, principal: 'user:forged' })).status, 409)
    assert.equal((await api('POST', { ...decision, proposalSha256: 'f'.repeat(64) })).status, 409)
    const result = await api('POST', decision)
    assert.equal(result.status, 200, result.data.error)
    assert.equal(result.data.decision?.decision, 'approved')
    assert.equal(result.data.decision?.phase, 'recorded')
    assert.equal((await api('POST', decision)).status, 200, 'Same exact action is idempotent')
    const saved = JSON.parse(readFileSync(join(job.stateDir, 'author-decisions', 'foundation-conflict.json'), 'utf8'))
    assert.equal(saved.note, '')
    assert.equal(saved.phase, 'recorded')
    assert.equal(saved.principal, 'user:' + owner.user.id)
    assert.equal((store.sqlite.prepare('SELECT status FROM studio_sessions WHERE id=?').get(jobId) as
      { status: string }).status, 'paused')
    const reread = await api('GET')
    assert.equal(reread.data.decisions?.[0]?.phase, 'recorded')
    assert.equal(reread.data.decisions?.[0]?.decision, 'approved')
    assert.equal(existsSync(join(job.stateDir, 'validator-upgrade.json')), false)

    // A specialist-initiated creative decision uses the same owner-scoped
    // /author endpoint, but never serves as a protected-edit approval.
    const options = [
      { id: 'known-canon', title: 'Follow established characterization',
        approach: 'Expand the existing arc without changing its protagonist.',
        benefits: 'Preserves narrative continuity', tradeoffs: 'Fewer dramatic changes' },
      { id: 'new-conflict', title: 'Propose additional conflict',
        approach: 'Introduce a conflict that needs separate canonical review.',
        benefits: 'Adds dramatic potential', tradeoffs: 'Requires more editorial review' },
    ]
    const question = {
      question: 'Should the character follow established canon or introduce a consequential new conflict?',
      options, recommendedId: 'known-canon',
      recommendationReason: 'The existing Creative Direction strongly favors continuity for this short test Story.',
    }
    const choiceDir = join(job.stateDir, 'character-world-sessions', 'character')
    mkdirSync(choiceDir, { recursive: true })
    const choiceSessionId = randomUUID(), choiceFile = join(choiceDir, 'choice.jsonl')
    writeFileSync(choiceFile, [
      JSON.stringify({ type: 'session', id: choiceSessionId, cwd: job.worktreeStoryRoot }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Ask author.' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text', text: JSON.stringify({ authorDecisionRequest: question,
          modifiedRecords: [] }) }] } }),
    ].join('\n') + '\n')
    let choice = await recordSpecialistChoice(job, 'character-foundations', question,
      choiceSessionId, choiceFile)
    writeFileSync(join(job.stateDir, 'character-world.json'), JSON.stringify({
      jobId, threadId: job.threadId, units: [
        { id: 'world-foundations', phase: 'committed' },
        { id: 'character-foundations', phase: 'awaiting-author', authorChoiceId: choice.id },
      ],
    }))
    const list = await api('GET')
    assert.equal(list.status, 200)
    assert.equal(list.data.choice?.id, choice.id)
    const payload = { action: 'choice', id: choice.id, proposalSha256: choice.proposalSha256,
      kind: 'option', optionId: 'known-canon' }
    assert.equal((await api('POST', payload, owners[1]!.cookie)).status, 404)
    assert.equal((await api('POST', payload, owner.cookie, 'https://evil.example')).status, 403)
    assert.equal((await api('POST', { ...payload, optionId: 'invalid' })).status, 409)
    assert.equal((await api('POST', { ...payload, principal: 'user:forged' })).status, 409)
    assert.equal((await api('POST', { ...payload, proposalSha256: 'f'.repeat(64) })).status, 409)
    const answered = await api('POST', payload)
    assert.equal(answered.status, 200, answered.data.error)
    assert.equal(answered.data.choice?.phase, 'answered')
    assert.equal((await inspectSpecialistChoice(job, choice.id)).answer?.kind, 'option')
    assert.equal((await api('POST', payload)).status, 409, 'A submitted choice cannot be rewritten')
    assert.equal((await api('GET')).data.choice?.phase, 'answered')
    assert.equal((store.sqlite.prepare('SELECT status FROM studio_sessions WHERE id=?').get(jobId) as
      { status: string }).status, 'paused', 'Author answer does not automatically resume Pi')

    choice = await recordSpecialistChoice(job, 'character-foundations', question,
      choiceSessionId, choiceFile)
    writeFileSync(join(job.stateDir, 'character-world.json'), JSON.stringify({
      jobId, threadId: job.threadId, units: [
        { id: 'world-foundations', phase: 'committed' },
        { id: 'character-foundations', phase: 'awaiting-author', authorChoiceId: choice.id },
      ],
    }))
    const custom = await api('POST', { action: 'choice', id: choice.id,
      proposalSha256: choice.proposalSha256, kind: 'custom',
      text: 'Follow existing canon but include a distinct consequence for both investigation paths.' })
    assert.equal(custom.status, 200, custom.data.error)
    assert.equal((await inspectSpecialistChoice(job, choice.id)).answer?.kind, 'custom')
  } finally {
    store.sqlite.close()
    if (previous.state === undefined) delete process.env.NT_STATE_DIR
    else process.env.NT_STATE_DIR = previous.state
    if (previous.cache === undefined) delete process.env.NT_GIT_CACHE_DIR
    else process.env.NT_GIT_CACHE_DIR = previous.cache
    removeTestTree(root)
  }
})
