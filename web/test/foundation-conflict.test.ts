import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { startStoryJob, type JobStartResult } from '../../src/job'
import { trustedHead } from '../../src/revision'
import { inspectAuthorDecisions, decideAuthorDecision } from '../../src/author-decisions'
import { inspectFoundationConflict, recordFoundationConflict, decideFoundationConflict,
  authorizedFoundationException, consumeFoundationRetry, foundationExceptionContext } from '../../src/foundation-conflict'
import { removeTestTree } from '../../test/helpers'

const sh = (value: string) => createHash('sha256').update(value).digest('hex')
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixtureState(job: JobStartResult, options: { tool?: string; committed?: boolean } = {}) {
  const id = randomUUID()
  const session = join(job.stateDir, 'foundation-sessions', 'test.jsonl')
  mkdirSync(join(job.stateDir, 'foundation-sessions'), { recursive: true })
  writeFileSync(session, [
    JSON.stringify({ type: 'session', id }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
      content: [
        ...(options.tool ? [{ type: 'toolCall', name: options.tool, id: 'test', arguments: {} }] : []),
        { type: 'text', text: 'I found a protected decision that restricts generation to discovery and preflight. Please authorize an exception; I did not edit the file.' },
      ] } }),
  ].join('\n') + '\n')
  writeFileSync(join(job.stateDir, 'foundation.json'), JSON.stringify({
    version: 1, jobId: job.jobId, baseSha: job.baseSha, workHead: job.baseSha,
    stage: options.committed ? 'committed' : 'writing', writerStarted: true,
    target: 'creative-direction/foundation.md', piSessionId: id, piSessionFile: session,
  }))
  writeFileSync(join(job.stateDir, 'active-specialist.json'), JSON.stringify({
    version: 1, jobId: job.jobId, phase: 'completed', workItem: 'foundation',
    expectedHead: job.baseSha, actualHead: job.baseSha, dirtyFiles: [],
    piStopReason: 'stop', piSessionId: id, piSessionFile: session,
  }))
  writeFileSync(join(job.stateDir, 'generation-server-owner.json'), JSON.stringify({
    jobId: job.jobId, requestSha256: sh('pinned generation request'),
  }))
}

test('completed no-write Foundation blocks safely and requires exact human authorization', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-foundation-conflict-'))
  const keys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_NATIVE_CLI'] as const
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.NT_STATE_DIR = join(root, 'state')
  process.env.NT_GIT_CACHE_DIR = join(root, 'cache')
  process.env.NT_NATIVE_CLI = resolve(process.env.NT_NATIVE_CLI || '/home/thomas/dev/nt/build/cli/linux/noveltea')
  try {
    if (!existsSync(process.env.NT_NATIVE_CLI)) return
    const repo = join(root, 'repo'), story = join(repo, 'story')
    mkdirSync(join(story, 'creative-direction'), { recursive: true })
    writeFileSync(join(story, 'creative-direction/foundation.md'), [
      '---', "schema: '0.1'", 'type: creative-direction', 'id: creative-direction.foundation',
      'title: "Archive mystery"', 'status: draft', 'decisions:',
      '  - id: test-discovery',
      '    statement: "Use only for Story discovery and preflight"',
      '    origin: user', '    authority: user-protected',
      'premise: "A page has gone missing"', 'central_conflict: "Find the page before closing"',
      'genre: "Mystery"', 'tone: "Curious"', 'player_experience: "Choose a path"',
      'scope: "A short archive Story"', '---', '', '# Archive mystery', '',
    ].join('\n'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@test.invalid')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Canonical protected baseline')
    const job = await startStoryJob({ story, job: randomUUID() })
    fixtureState(job)
    await assert.rejects(() => trustedHead(job), /unfinished/)
    const candidate = await inspectFoundationConflict(job)
    assert.equal(candidate?.status, 'awaiting-author')
    assert.match(candidate?.sourceExcerpt ?? '', /test-discovery/)
    assert.match(candidate?.explanation ?? '', /authorize an exception/)
    assert.equal(await recordFoundationConflict(job)?.then(v => v?.digest), candidate?.digest)
    assert.equal((await recordFoundationConflict(job))?.digest, candidate?.digest)
    await assert.rejects(() => decideFoundationConflict(job, 'approve', sh('wrong'), 'Explicitly permit this test', 'user:author'), /Stale/)
    const pending = await inspectAuthorDecisions(job)
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.phase, 'awaiting-author')
    const approved = await decideAuthorDecision(job, {
      id: 'foundation-conflict', proposalSha256: candidate!.digest, decision: 'approved',
      principal: 'user:author',
    })
    assert.equal(approved.phase, 'recorded')
    assert.equal(approved.note, '')
    assert.equal((await inspectFoundationConflict(job))?.status, 'authorized')
    assert.doesNotMatch(await foundationExceptionContext(job), /Additional author direction:/)
    assert.equal((await inspectAuthorDecisions(job))[0]?.decision, 'approved')
    assert.equal((await decideAuthorDecision(job, {
      id: 'foundation-conflict', proposalSha256: candidate!.digest, decision: 'approved',
      principal: 'user:author',
    })).phase, 'recorded')
    await assert.rejects(() => decideAuthorDecision(job, {
      id: 'foundation-conflict', proposalSha256: candidate!.digest,
      decision: 'approved', principal: 'user:different',
    }), /another author/)
    assert.equal(await trustedHead(job), job.baseSha)
    assert.match(await foundationExceptionContext(job), /author expressly permitted full composition/)
    assert.equal((await authorizedFoundationException(job))?.digest, candidate?.digest)
    assert.equal((await consumeFoundationRetry(job))?.retryUsed, true)
    // Replaying only the exact first session can complete a crash window before
    // the Foundation state is replaced; the subsequent writer is never replayed.
    assert.equal((await consumeFoundationRetry(job))?.retryUsed, true)
    const foundation = join(job.stateDir, 'foundation.json')
    const old = JSON.parse(readFileSync(foundation, 'utf8')) as Record<string, unknown>
    writeFileSync(foundation, JSON.stringify({ ...old, writerStarted: false, piSessionId: null, piSessionFile: null }))
    assert.equal(await consumeFoundationRetry(job), null)
    await assert.rejects(() => decideFoundationConflict(job, 'approve', candidate!.digest,
      'Please replay automatically after the first grant', 'user:author'), /Stale|already/)
    writeFileSync(join(job.worktreeStoryRoot, 'creative-direction/foundation.md'),
      readFileSync(join(job.worktreeStoryRoot, 'creative-direction/foundation.md'), 'utf8') + '\nEdit')
    assert.equal(await authorizedFoundationException(job), null)
    await assert.rejects(() => trustedHead(job), /unfinished/)

    const denied = await startStoryJob({ story, job: randomUUID() })
    fixtureState(denied)
    const deniedPreview = await recordFoundationConflict(denied)
    assert.ok(deniedPreview)
    assert.equal((await decideAuthorDecision(denied, {
      id: 'foundation-conflict', proposalSha256: deniedPreview!.digest,
      decision: 'rejected', principal: 'user:author',
    })).decision, 'rejected')
    assert.equal((await inspectFoundationConflict(denied))?.status, 'rejected')
    assert.equal((await inspectAuthorDecisions(denied))[0]?.phase, 'recorded')
    await assert.rejects(() => decideAuthorDecision(denied, {
      id: 'foundation-conflict', proposalSha256: deniedPreview!.digest,
      decision: 'approved', principal: 'user:author',
    }), /another author/)
    await assert.rejects(() => trustedHead(denied), /unfinished/)
    assert.equal(await foundationExceptionContext(denied), '')

    const unsafe = await startStoryJob({ story, job: randomUUID() })
    fixtureState(unsafe, { tool: 'write' })
    assert.equal(await inspectFoundationConflict(unsafe), null)
    assert.equal(await recordFoundationConflict(unsafe), null)
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    removeTestTree(root)
  }
})
