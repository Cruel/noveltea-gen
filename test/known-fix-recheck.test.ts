import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { recheckExhaustedProtocolResponse } from '../src/response-contract-recovery'

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
