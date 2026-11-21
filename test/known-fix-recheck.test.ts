import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recheckExhaustedProtocolResponse } from '../src/response-contract-recovery'
import { recheckAdaptiveResponse, type AdaptiveRecovery } from '../src/adaptive-protocol'
import type { JobStartResult } from '../src/job'

const sha = (input: string) => createHash('sha256').update(input).digest('hex')
const contract = 'adaptive-plan.v1'
const sourceDigest = 'f'.repeat(64)
const answer = '{"sourceSha":"0123","actions":[],"order":[]}'
const assistant = (text: string) => ({ type: 'message', message: {
  role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }],
} })
const user = () => ({ type: 'message', message: { role: 'user', content: [
  { type: 'text', text: 'Correct the invalid original format' },
] } })

test('#223 known fix rechecks one sealed response, with no model or writer, and refuses forged evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-known-verifier-fix-'))
  try {
    const sessions = join(root, 'sessions'), receipts = join(root, 'receipts')
    mkdirSync(sessions); mkdirSync(receipts)
    const id = 'fixed-original-session', file = join(sessions, 'session.jsonl')
    const head = [JSON.stringify({ type: 'session', id }), JSON.stringify(assistant('unreadable original'))]
      .join('\n') + '\n'
    const messages = [
      JSON.stringify(user()), JSON.stringify(assistant('still invalid')),
      JSON.stringify(user()), JSON.stringify(assistant(answer)),
    ]
    const originalBytes = head + messages.join('\n') + '\n'
    writeFileSync(file, originalBytes)
    const invocationId = sha(contract + '\0' + id + '\0' + file)
    writeFileSync(join(receipts, 'original.started.json'), JSON.stringify({
      version: 1, contract, sourceDigest, invocationId, sessionId: id, sessionFile: file,
      transcriptBytesBeforePrompt: Buffer.byteLength(head),
      transcriptSha256BeforePrompt: sha(head),
      freshInvocationAllowance: 1,
    }))
    writeFileSync(join(receipts, 'original.initial.json'), JSON.stringify({
      version: 1, contract, sourceDigest, invocationId, sessionId: id, sessionFile: file,
      status: 'protocol-exhausted', attempts: 3, responseOrdinal: 3,
      responseHash: sha(answer), failedPaths: ['$.sourceSha'],
    }))
    const request = {
      receiptFile: join(receipts, 'original'), sourceDigest, contract,
      sessionRoots: [sessions], expectedSession: { id, file },
      validate: (text: string) => {
        try {
          const proposal = JSON.parse(text) as { actions?: unknown[] }
          return Array.isArray(proposal.actions) ? [] : [{ path: '$.actions', expected: 'array' }]
        } catch { return [{ path: '$', expected: 'JSON' }] }
      },
      parse: (text: string) => JSON.parse(text) as { actions: unknown[] },
    }
    assert.deepEqual(await recheckExhaustedProtocolResponse(request), {
      sourceSha: '0123', actions: [], order: [],
    })
    await assert.rejects(recheckExhaustedProtocolResponse({
      ...request, sourceDigest: 'e'.repeat(64),
    }), /source|receipt|differs/i)
    await assert.rejects(recheckExhaustedProtocolResponse({
      ...request, validate: () => [{ path: '$', expected: 'still invalid' }],
    }), /still fails/i)
    await assert.rejects(recheckExhaustedProtocolResponse({
      ...request, expectedSession: { id: 'foreign', file },
    }), /exact exhausted/i)
    writeFileSync(file, originalBytes.replace(JSON.stringify(assistant(answer)),
      JSON.stringify(assistant('{"forged":true}'))))
    await assert.rejects(recheckExhaustedProtocolResponse(request), /changed|differs/i)
    writeFileSync(file, originalBytes)
    writeFileSync(join(receipts, 'original.fresh-allowance.json'), JSON.stringify({ version: 1 }))
    await assert.rejects(recheckExhaustedProtocolResponse(request), /exhausted original/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('#223 rechecks actual adaptive receipts with canonical pinned skill paths and no new Pi session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-adaptive-fix-'))
  try {
    const sessions = join(root, 'adaptive-planning-sessions')
    const receipts = join(root, 'adaptive-protocol')
    const story = join(root, 'story'), snapshot = join(root, 'pinned-snapshot')
    for (const dir of [sessions, receipts, story, snapshot]) mkdirSync(dir)
    const id = 'original-pi-session'
    const file = join(sessions, 'original.jsonl')
    const turnDigest = 'b'.repeat(64), sourceSha = 'a'.repeat(40)
    const signature = 'f'.repeat(64)
    const valid = JSON.stringify({ sourceSha, turnDigest, beforeVersion: 1,
      reason: 'Use original verified plan', actions: [], order: [] })
    const readCall = JSON.stringify({ type: 'message', message: {
      role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall',
        name: 'read', id: 'read-1',
        arguments: { path: 'skill://nt-story-orchestrate/SKILL.md' } }],
    } })
    const readResult = JSON.stringify({ type: 'message', message: {
      role: 'toolResult', toolCallId: 'read-1', isError: false,
      content: [{ type: 'text', text: 'Original pinned skill evidence' }],
    } })
    const original = [JSON.stringify({ type: 'session', id }), readCall,
      readResult, JSON.stringify(assistant('invalid proposal'))].join('\n') + '\n'
    const bytes = original + [
      JSON.stringify(user()), JSON.stringify(assistant('still invalid')),
      JSON.stringify(user()), JSON.stringify(assistant(valid)),
    ].join('\n') + '\n'
    writeFileSync(file, bytes)
    const receipt = join(receipts, signature)
    const invocationId = sha(contract + '\0' + id + '\0' + file)
    writeFileSync(receipt + '.started.json', JSON.stringify({
      version: 1, contract, sourceDigest: signature, invocationId,
      sessionId: id, sessionFile: file, freshInvocationAllowance: 1,
      transcriptBytesBeforePrompt: Buffer.byteLength(original),
      transcriptSha256BeforePrompt: sha(original),
    }))
    writeFileSync(receipt + '.initial.json', JSON.stringify({
      version: 1, contract, sourceDigest: signature, invocationId,
      sessionId: id, sessionFile: file, status: 'protocol-exhausted',
      attempts: 3, responseOrdinal: 3, responseHash: sha(valid),
      failedPaths: ['$.legacyVerifier'],
    }))
    const job = { stateDir: root, worktreeStoryRoot: story,
      jobId: 'job-1', threadId: 'job-1:thread' } as JobStartResult
    const decision: AdaptiveRecovery = {
      operation: 'adaptive-planner', failedPhase: 'completed-response',
      check: 'adaptive-plan.v1', checkVersion: 1,
      action: 'correct-original-response', phase: 'protocol-exhausted',
      jobId: job.jobId, threadId: job.threadId, signature,
      planVersion: 1, sourceSha, turnDigest,
      proof: { file, id, bytes: Buffer.byteLength(original), sha256: sha(original) },
    }
    const restored = await recheckAdaptiveResponse(job, decision, snapshot)
    assert.deepEqual(restored.proposal, JSON.parse(valid))
    assert.equal(restored.sessionFile, file)
    assert.deepEqual(restored.skillReads,
      [join(snapshot, 'skills', 'nt-story-orchestrate', 'SKILL.md')])
    // The successful check creates no fresh session or accepted receipt.
    assert.equal(readdirSync(sessions).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
