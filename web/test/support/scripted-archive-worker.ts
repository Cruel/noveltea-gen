import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { JobStartResult } from '../../../src/job'
import { readTurnEvidence, type TurnEvidence } from '../../../src/turn-plan-evidence'
import { fixtureSandboxClient } from '../../../test/c03-scripted-story-helpers'
import { SandboxClient } from '../../../src/sandbox-client'
import { installScriptedArchiveProvider } from './scripted-archive-provider'

const input = JSON.parse(readFileSync(process.env.NT_TEST_ARCHIVE_WORKER_INPUT!, 'utf8')) as {
  job: JobStartResult; turn: TurnEvidence
}
const turn = await readTurnEvidence(input.job, input.turn.contract, input.turn.originalRequest, input.turn.digest)
assert.ok(turn)
await installScriptedArchiveProvider(input.job, turn)
fixtureSandboxClient(input.job.jobId, input.job.worktreeStoryRoot)
SandboxClient.prototype.dispose = async id => {
  assert.equal(id, input.job.jobId)
  return { jobId: id, status: 'disposed' }
}
await import('../../src/agent-worker')
