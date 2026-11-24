import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { beginProtocolInvocation, recoverResponseContract } from '../../src/response-contract-recovery'
import { createDiscoveryEvidence, readDiscoveryResponse, reopenDiscoveryPiReference, sealDiscoveryPiReference, meterDiscoveryAttempts, type DiscoveryAttempt } from '../src/lib/discovery-evidence.server'

test('reconcile real Pi protocol receipts and retain append-only writer/reviewer identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-discovery-protocol-'))
  try {
    const source = 'a'.repeat(64)
    const evidence = async (stage: 'initial' | 'corrective' | 'semantic-review') =>
      createDiscoveryEvidence({ owner: 'owner', repositoryId: 'repo', workspace: 'first-turn',
        revision: 1, stage, model: { provider: 'openai', id: 'fixture' },
        skillId: 'pinned-skill', instructions: stage }, { NT_DISCOVERY_EVIDENCE_DIR: root })
    let calls = 0
    const run = async (attempt: Awaited<ReturnType<typeof evidence>>, manager: SessionManager,
      requestDigest: string, role: 'writer' | 'reviewer', raw: string, correction?: string) => {
      const contract = role === 'writer' ? 'discovery.writer-response.v1' : 'discovery.review-response.v1'
      const session = { sessionId: manager.getSessionId(), sessionManager: manager,
        get messages() { return manager.buildSessionContext().messages },
        getActiveToolNames: () => [], setActiveToolsByName: (names: string[]) => assert.deepEqual(names, []) }
      const base = join(attempt.dir, 'protocol')
      await beginProtocolInvocation({ receiptFile: base, sourceDigest: requestDigest, contract, session })
      const append = (text: string) => {
        calls++
        manager.appendMessage({ role: 'user', content: 'Original source-bound prompt', timestamp: Date.now() })
        manager.appendMessage({ role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text }],
        } as Parameters<SessionManager['appendMessage']>[0])
      }
      append(raw)
      await recoverResponseContract({ session, contract, sourceDigest: requestDigest,
        receiptFile: base + '.initial.json', validate: text => text === 'invalid'
          ? [{ path: '$', expected: 'JSON' }] : [], parse: text => text,
        prompt: async () => { assert.ok(correction); append(correction) } })
      return { dir: attempt.dir, requestDigest, status: 'started', role } as DiscoveryAttempt
    }
    const originalEvidence = await evidence('initial')
    const writer = SessionManager.create('/', originalEvidence.piDirectory)
    const originalAttempt = await run(originalEvidence, writer, 'b'.repeat(64), 'writer', 'invalid', '{"draft":1}')
    // Simulate a crash after the accepted protocol receipt but before wrapper
    // settlement. Inspection reconstructs the exact response with zero prompts.
    const original = await readDiscoveryResponse(originalAttempt, source, 'writer', true)
    assert.equal(original.text, '{"draft":1}')
    assert.equal(calls, 2)
    const resumed = await reopenDiscoveryPiReference(original.reference!, source, 'writer')
    const correctiveEvidence = await evidence('corrective')
    const correctiveAttempt = await run(correctiveEvidence, resumed, 'c'.repeat(64), 'writer', '{"draft":2}')
    const corrected = await readDiscoveryResponse(correctiveAttempt, source, 'writer', true)
    assert.equal(corrected.reference?.id, original.reference?.id)
    assert.equal(corrected.reference?.file, original.reference?.file)
    assert.equal((await readDiscoveryResponse({ ...originalAttempt, responseDigest: original.responseDigest },
      source, 'writer', true)).text, original.text, 'Earlier protocol receipt remains verifiable after append')
    const reviewEvidence = await evidence('semantic-review')
    const reviewer = SessionManager.create('/', reviewEvidence.piDirectory)
    const reviewAttempt = await run(reviewEvidence, reviewer, 'd'.repeat(64), 'reviewer', '{"verdict":"pass"}')
    const reviewed = await readDiscoveryResponse(reviewAttempt, source, 'reviewer', true)
    assert.notEqual(reviewed.reference?.id, corrected.reference?.id)
    assert.equal(calls, 4)
    await assert.rejects(readDiscoveryResponse(reviewAttempt, source, 'writer', true), /another source or role/)
    const saved = readFileSync(join(correctiveEvidence.dir, 'response.json'), 'utf8')
    writeFileSync(join(correctiveEvidence.dir, 'response.json'), saved + ' ')
    await assert.rejects(readDiscoveryResponse({ ...correctiveAttempt, responseDigest: corrected.responseDigest },
      source, 'writer', true), /Studio settlement/)
    writeFileSync(join(correctiveEvidence.dir, 'response.json'), saved)
    appendFileSync(corrected.reference!.file, '{}\n')
    await assert.rejects(reopenDiscoveryPiReference(corrected.reference!, source, 'writer'), /changed after settlement/)
    assert.equal(calls, 4, 'Inspection and tamper rejection never call a model')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('budget pause reopens the exact invalid Pi response and meters only the original and correction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nt-discovery-budget-'))
  try {
    const source = 'a'.repeat(64), requestDigest = 'b'.repeat(64)
    const evidence = await createDiscoveryEvidence({ owner: 'owner', repositoryId: 'repo', workspace: 'turn',
      revision: 1, stage: 'initial', model: { provider: 'openai', id: 'fixture' },
      skillId: 'pinned-skill', instructions: 'Return JSON' }, { NT_DISCOVERY_EVIDENCE_DIR: root })
    const base = join(evidence.dir, 'protocol')
    const contract = 'discovery.writer-response.v1'
    let manager = SessionManager.create('/', evidence.piDirectory)
    const session = () => ({ sessionId: manager.getSessionId(), sessionManager: manager,
      get messages() { return manager.buildSessionContext().messages },
      getActiveToolNames: () => [], setActiveToolsByName: (names: string[]) => assert.deepEqual(names, []) })
    const append = (value: string) => {
      manager.appendMessage({ role: 'user', content: 'Return JSON', timestamp: Date.now() })
      manager.appendMessage({ role: 'assistant', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.1 } },
        content: [{ type: 'text', text: value }],
      } as Parameters<SessionManager['appendMessage']>[0])
    }
    await beginProtocolInvocation({ receiptFile: base, sourceDigest: requestDigest, contract, session: session() })
    append('invalid')
    const validate = (value: string) => value === 'invalid' ? [{ path: '$', expected: 'JSON' }] : []
    const attempt: DiscoveryAttempt = { dir: evidence.dir, requestDigest, status: 'started', role: 'writer',
      sourceDigest: source, requestReceiptDigest: await evidence.requestReceiptDigest() }
    const reference = await sealDiscoveryPiReference(manager, source, 'writer')
    const meter = await meterDiscoveryAttempts([], { reference, startedAt: Date.now() })
    assert.equal(meter.modelCalls, 1)
    await assert.rejects(recoverResponseContract({ session: session(), contract,
      sourceDigest: requestDigest, receiptFile: base + '.initial.json', validate, parse: x => x,
      prompt: async () => { assert.fail('Budget exhausted') }, sealTranscript: true,
      beforeCorrection: async () => { throw Error('budget pause') } }), /budget pause/)
    manager = await reopenDiscoveryPiReference(reference, source, 'writer')
    let corrections = 0
    const raw = await recoverResponseContract({ session: session(), contract,
      sourceDigest: requestDigest, receiptFile: base + '.initial.json', validate, parse: x => x,
      prompt: async () => { corrections++; append('{"draft":1}') }, sealTranscript: true,
      resumeOriginal: { base, sessionRoots: [root] } })
    assert.equal(corrections, 1)
    const settled = await sealDiscoveryPiReference(manager, source, 'writer')
    assert.equal(settled.id, reference.id)
    const responseDigest = await evidence.response(raw, settled.file, settled)
    const usage = await meterDiscoveryAttempts([{ ...attempt, responseDigest, activeSeconds: 2 }])
    assert.equal(usage.modelCalls, 2)
    assert.equal(usage.steps, 1)
    assert.equal(usage.tokens.total, 30)
    assert.equal(usage.costUsd, 0.2)
    assert.equal(usage.activeSeconds, 2)
    await assert.rejects(reopenDiscoveryPiReference(reference, source, 'writer'), /changed after settlement/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed discovery retains private Pi JSONL, raw reply and exact validation error', async () => {
  const state = mkdtempSync(join(tmpdir(), 'noveltea-discovery-evidence-'))
  try {
    const attempt = await createDiscoveryEvidence({
      owner: 'owner-1', repositoryId: 'repository-1', workspace: 'story-chat,first-turn',
      revision: 4, stage: 'corrective', model: { provider: 'openai-codex', id: 'test-model' },
      skillId: 'pinned-discovery-skill', instructions: 'Private pinned controller instructions',
    }, { NT_DISCOVERY_EVIDENCE_DIR: state })
    const manager = SessionManager.create('/', attempt.piDirectory)
    manager.appendMessage({ role: 'user', content: 'Private discovery input', timestamp: Date.now() })
    const transcript = manager.getSessionFile()!
    assert.ok(transcript.startsWith(attempt.piDirectory + '/'))
    assert.match(readFileSync(transcript, 'utf8'), /Private discovery input/)
    const source = 'a'.repeat(64)
    const original = await sealDiscoveryPiReference(manager, source, 'writer')
    await assert.rejects(reopenDiscoveryPiReference(original, 'b'.repeat(64), 'writer'), /another assignment/)
    await assert.rejects(reopenDiscoveryPiReference(original, source, 'reviewer'), /another assignment/)
    const reopened = await reopenDiscoveryPiReference(original, source, 'writer')
    reopened.appendMessage({ role: 'user', content: 'Correct the original draft', timestamp: Date.now() })
    const corrected = await sealDiscoveryPiReference(reopened, source, 'writer')
    assert.equal(corrected.id, original.id)
    assert.equal(corrected.file, original.file)
    assert.ok(corrected.bytes > original.bytes)
    assert.match(readFileSync(transcript, 'utf8'), /Correct the original draft/)
    await assert.rejects(reopenDiscoveryPiReference(original, source, 'writer'), /changed after settlement/)
    appendFileSync(transcript, '{}\n')
    await assert.rejects(reopenDiscoveryPiReference(corrected, source, 'writer'), /changed after settlement/)
    const raw = '{"phase":"proposal","foundation":{"invalid":"not authorized"}}'
    await attempt.response(raw, transcript)
    await attempt.validation('rejected', new Error('Invalid source-bound interpretation'))
    const receipt = JSON.parse(readFileSync(join(attempt.dir, 'response.json'), 'utf8'))
    const verdict = JSON.parse(readFileSync(join(attempt.dir, 'validation.json'), 'utf8'))
    assert.equal(receipt.raw, raw)
    assert.equal(receipt.piSessionFile, transcript)
    assert.equal(verdict.status, 'rejected')
    assert.equal(verdict.message, 'Invalid source-bound interpretation')
    assert.match(readFileSync(join(attempt.dir, 'request.json'), 'utf8'),
      /Private pinned controller instructions/)
    assert.equal(statSync(attempt.dir).mode & 0o777, 0o700)
    assert.equal(statSync(attempt.piDirectory).mode & 0o777, 0o700)
    assert.equal(statSync(join(attempt.dir, 'response.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(attempt.dir, 'validation.json')).mode & 0o777, 0o600)
    await assert.rejects(attempt.response('another response', transcript), /EEXIST/,
      'Once recorded, a response cannot be silently replaced')
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
