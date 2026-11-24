import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createDiscoveryEvidence, reopenDiscoveryPiReference, sealDiscoveryPiReference } from '../src/lib/discovery-evidence.server'

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
