import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { startStoryJob, type JobStartResult } from '../../src/job'
import { validateStoryJob } from '../../src/validator'
import { approveValidatorUpgrade, inspectValidatorUpgrade } from '../../src/validator-upgrade'
import { recordFoundationConflict, decideFoundationConflict } from '../../src/foundation-conflict'
import { removeTestTree } from '../../test/helpers'

const cli = resolve(process.env.NT_NATIVE_CLI ?? '/home/thomas/dev/nt/build/cli/linux/noveltea')
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function fixtureState(job: JobStartResult) {
  const sessionId = randomUUID()
  const session = join(job.stateDir, 'foundation-sessions', 'first.jsonl')
  mkdirSync(join(job.stateDir, 'foundation-sessions'), { recursive: true })
  writeFileSync(session, [
    JSON.stringify({ type: 'session', id: sessionId }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'This Story has a user-protected discovery-only decision. Please authorize full composition. No changes were made.' }] } }),
  ].join('\n') + '\n')
  writeFileSync(join(job.stateDir, 'foundation.json'), JSON.stringify({
    version: 1, jobId: job.jobId, baseSha: job.baseSha, stage: 'writing',
    writerStarted: true, target: 'creative-direction/foundation.md',
    piSessionId: sessionId, piSessionFile: session,
  }))
  writeFileSync(join(job.stateDir, 'active-specialist.json'), JSON.stringify({
    version: 1, jobId: job.jobId, phase: 'completed', workItem: 'foundation',
    expectedHead: job.baseSha, actualHead: job.baseSha, dirtyFiles: [],
    piStopReason: 'stop', piSessionId: sessionId, piSessionFile: session,
  }))
  writeFileSync(join(job.stateDir, 'generation-server-owner.json'), JSON.stringify({
    jobId: job.jobId, requestSha256: 'a'.repeat(64),
  }))
}
test('validator upgrade requires exact author review, records history and handles partial migration', {
  skip: !existsSync(cli), timeout: 80_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-validator-upgrade-'))
  const envKeys = ['NT_STATE_DIR', 'NT_GIT_CACHE_DIR', 'NT_NATIVE_CLI', 'NT_VALIDATOR_TEST_LEGACY'] as const
  const before = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
  try {
    process.env.NT_STATE_DIR = join(root, 'state')
    delete process.env.NT_GIT_CACHE_DIR
    delete process.env.NT_VALIDATOR_TEST_LEGACY
    const old = join(root, 'old-validator'), next = join(root, 'next-validator')
    for (const [name, path] of [['old', old], ['next', next]] as const) {
      writeFileSync(path, '#!/bin/sh\n# validator-' + name +
        '\nexec "' + cli + '" "$@"\n')
      chmodSync(path, 0o755)
    }
    const story = join(root, 'repo', 'story')
    mkdirSync(join(story, 'creative-direction'), { recursive: true })
    writeFileSync(join(story, 'creative-direction', 'foundation.md'), [
      '---', "schema: '0.1'", 'type: creative-direction', 'id: creative-direction.foundation',
      'title: "Archive mystery"', 'status: draft', 'decisions:',
      '  - id: test-discovery',
      '    statement: "Use this sample only for Story discovery and preflight"',
      '    origin: user', '    authority: user-protected',
      'premise: "A missing page"', 'central_conflict: "Locate the page before closing"',
      'genre: Mystery', 'tone: Curious', 'player_experience: "Choose paths"',
      'scope: "One archive, one protagonist"', '---', '', '# Archive mystery', '',
    ].join('\n'))
    const repo = join(root, 'repo')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Protected baseline')
    const baseline = git(repo, 'rev-parse', 'HEAD')
    const makeJob = async () => {
      process.env.NT_NATIVE_CLI = old
      let job = await startStoryJob({ story, job: randomUUID() })
      assert.equal((await validateStoryJob(job)).status, 'passed')
      job = await startStoryJob({ story, job: job.jobId }, false)
      fixtureState(job)
      const preview = await recordFoundationConflict(job)
      assert.ok(preview)
      await decideFoundationConflict(job, 'approve', preview!.digest,
        'I permit composition for the exact pinned Story without changing its protected decisions.',
        'user:author')
      process.env.NT_NATIVE_CLI = next
      return job
    }
    const job = await makeJob()
    const preview = await inspectValidatorUpgrade(job)
    assert.equal(preview.phase, 'review-required')
    const p = preview.proposal!
    assert.ok(p)
    assert.notEqual(p.previous.sha256, p.replacement.sha256)
    assert.equal(p.headSha, baseline)
    assert.equal(p.diagnostics, 0)
    assert.equal((await inspectValidatorUpgrade(job)).proposal?.proposalSha256, p.proposalSha256)
    await assert.rejects(() => approveValidatorUpgrade(job, 'f'.repeat(64),
      'I approve this specific replacement', 'user:author'), /changed|safe/)
    assert.equal(existsSync(join(job.stateDir, 'validator-upgrade.json')), false)
    const actual = await approveValidatorUpgrade(job, p.proposalSha256,
      'I reviewed and authorize the replacement for this test job.', 'user:author')
    assert.equal(actual.phase, 'committed')
    assert.equal(actual.previous.sha256, p.previous.sha256)
    assert.equal(actual.replacement.sha256, p.replacement.sha256)
    assert.equal(git(job.worktreeRoot, 'rev-parse', 'HEAD'), baseline)
    assert.equal(git(job.worktreeRoot, 'status', '--porcelain'), '')
    const repinned = await startStoryJob({ story, job: job.jobId }, false)
    assert.equal(repinned.validatorSha256, p.replacement.sha256)
    assert.equal((await validateStoryJob(repinned)).status, 'passed')
    assert.equal((await inspectValidatorUpgrade(repinned)).phase, 'committed')
    await assert.rejects(() => approveValidatorUpgrade(repinned, p.proposalSha256,
      'I reviewed and authorize the replacement for this test job.', 'user:author'),
    /already authorized or completed/)

    // A swapped candidate after preview must never be accepted.
    const drift = await makeJob()
    const fresh = (await inspectValidatorUpgrade(drift)).proposal!
    writeFileSync(next, readFileSync(next, 'utf8') + '# changed after review\n')
    await assert.rejects(() => approveValidatorUpgrade(drift, fresh.proposalSha256,
      'I reviewed and authorize the replacement for this test job.', 'user:author'), /changed/)
    assert.equal(existsSync(join(drift.stateDir, 'validator-upgrade.json')), false)

    // Repair only the same already-authorized journal, without a second
    // controller decision or a new generation attempt.
    writeFileSync(next, readFileSync(next, 'utf8').replace('# changed after review\n', ''))
    const partial = await makeJob()
    const proposal = (await inspectValidatorUpgrade(partial)).proposal!
    const rationale = 'I reviewed and authorize the replacement for this test job.'
    writeFileSync(join(partial.stateDir, 'validator-upgrade.json'), JSON.stringify({
      ...proposal, phase: 'approved', principal: 'user:author',
      rationale, authorizedAt: new Date().toISOString(),
    }))
    writeFileSync(join(partial.stateDir, 'validator.json'), JSON.stringify(proposal.replacement))
    const complete = await approveValidatorUpgrade(partial, proposal.proposalSha256,
      rationale, 'user:author')
    assert.equal(complete.phase, 'committed')
    assert.equal((await startStoryJob({ story, job: partial.jobId }, false)).validatorSha256,
      proposal.replacement.sha256)
  } finally {
    for (const k of envKeys) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
    removeTestTree(root)
  }
})
