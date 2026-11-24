import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertServerClaimPermitted, claimServerGeneration, sameGenerationRequest,
} from '../../src/generation-owner'
import type { GenerationRequest } from '../../src/generation'
import type { JobStartResult } from '../../src/job'

const pinned: GenerationRequest = {
  story: '/pinned/story', job: '11111111-1111-4111-8111-111111111111',
  task: 'Add dialogue between two characters.',
  contract: {
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: ['Keep existing character motivations.'],
    envelope: { presentation: 'Interactive Story', hardLimits: [], preferences: [] },
  },
  fixture: false,
  turnPlanDigest: 'a'.repeat(64),
  skillsSource: '/pinned/skills',
  provider: 'openai-codex',
  model: 'gpt-6-luna',
}

// Zod's graph input normalizer keeps every value, but places optional fields
// in schema order (turnPlanDigest after the model); nested keys can also shift.
const graphRequest: GenerationRequest = {
  story: pinned.story, job: pinned.job, task: pinned.task,
  contract: {
    envelope: { preferences: [], hardLimits: [], presentation: 'Interactive Story' },
    constraints: ['Keep existing character motivations.'],
    scope: { branches: [], targets: [], depth: 'composition', kind: 'full-story' },
  },
  fixture: false, skillsSource: '/pinned/skills',
  provider: 'openai-codex', model: 'gpt-6-luna',
  turnPlanDigest: 'a'.repeat(64),
}

test('one graph request may reorder JSON keys but never acquire a second writer', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'nt-owner-order-'))
  const job = { stateDir, jobId: pinned.job } as JobStartResult
  const thread = 'pinned:generation:web'
  try {
    assert.notEqual(JSON.stringify(pinned), JSON.stringify(graphRequest))
    assert.equal(sameGenerationRequest(pinned, graphRequest), true)
    await claimServerGeneration(job, thread, pinned)
    const ownerFile = join(stateDir, 'generation-server-owner.json')
    assert.equal(existsSync(ownerFile), true)
    const original = readFileSync(ownerFile, 'utf8')
    await assertServerClaimPermitted(job, thread, graphRequest)
    await claimServerGeneration(job, thread, graphRequest)
    assert.equal(readFileSync(ownerFile, 'utf8'), original, 'idempotent claim never rewrites ownership')
    for (const different of [
      { ...graphRequest, task: 'Write a different story.' },
      { ...graphRequest, provider: 'another-provider' },
      { ...graphRequest, contract: { ...graphRequest.contract, constraints: ['Ignore existing Story.'] } },
      { ...graphRequest, contract: { ...graphRequest.contract,
        scope: { ...graphRequest.contract.scope, branches: ['different-branch'] } } },
    ]) {
      assert.equal(sameGenerationRequest(pinned, different), false)
      await assert.rejects(() => assertServerClaimPermitted(job, thread, different), /conflicts/)
      await assert.rejects(() => claimServerGeneration(job, thread, different), /another thread or pinned request/)
    }
    await assert.rejects(() => claimServerGeneration(job, 'another:generation:web', pinned), /another thread/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('pre-cutover owner receipt cannot adopt a new explicit method policy', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'nt-owner-policy-migration-'))
  const job = { stateDir, jobId: pinned.job } as JobStartResult
  const thread = 'pinned:generation:web'
  try {
    await claimServerGeneration(job, thread, pinned)
    const original = readFileSync(join(stateDir, 'generation-server-owner.json'), 'utf8')
    const explicit: GenerationRequest = { ...pinned, orchestrationPolicy: 'explicit' }
    await assert.rejects(() => assertServerClaimPermitted(job, thread, explicit), /conflicts/)
    await assert.rejects(() => claimServerGeneration(job, thread, explicit), /another thread/)
    assert.equal(readFileSync(join(stateDir, 'generation-server-owner.json'), 'utf8'), original)
    await assert.rejects(() => assertServerClaimPermitted(job, thread, {
      ...explicit, task: 'Different objective',
    }), /conflicts/)
    await assert.rejects(() => assertServerClaimPermitted(job, 'other:thread', explicit), /conflicts/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('new explicit-policy owner receipt rejects a changed orchestration policy', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'nt-owner-policy-locked-'))
  const job = { stateDir, jobId: pinned.job } as JobStartResult
  const thread = 'pinned:generation:web'
  try {
    const explicit: GenerationRequest = { ...pinned, orchestrationPolicy: 'explicit' }
    await claimServerGeneration(job, thread, explicit)
    await assert.rejects(() => assertServerClaimPermitted(job, thread, {
      ...explicit, orchestrationPolicy: 'fixture-test',
    }), /conflicts/)
    await assert.rejects(() => assertServerClaimPermitted(job, thread, pinned), /conflicts/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('historical byte-order owner receipts are preserved but cannot authorize execution', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'nt-owner-legacy-'))
  const job = { stateDir, jobId: pinned.job } as JobStartResult
  const thread = 'pinned:generation:web'
  try {
    const oldDigest = createHash('sha256').update(JSON.stringify(pinned)).digest('hex')
    writeFileSync(join(stateDir, 'generation-server-owner.json'), JSON.stringify({
      schema: 'noveltea-generation-owner/v1', jobId: pinned.job,
      threadId: thread, requestSha256: oldDigest,
    }))
    const original = readFileSync(join(stateDir, 'generation-server-owner.json'), 'utf8')
    await assert.rejects(() => assertServerClaimPermitted(job, thread, pinned), /conflicts/)
    await assert.rejects(() => claimServerGeneration(job, thread, pinned), /another thread/)
    await assert.rejects(() => claimServerGeneration(job, thread, graphRequest), /another thread/)
    assert.equal(readFileSync(join(stateDir, 'generation-server-owner.json'), 'utf8'), original)
    await assert.rejects(() => assertServerClaimPermitted(job, thread,
      { ...pinned, task: 'Changed task' }), /conflicts/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
