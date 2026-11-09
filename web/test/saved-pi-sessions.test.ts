import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from '../../test/helpers'
import { inspectSavedPiSessions } from '../src/lib/saved-pi-sessions.server'

test('read-only specialist index reports only original saved Pi session metadata', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'nt-pi-index-'))
  try {
    const contexts = join(stateDir, 'pi-contexts')
    const sessions = join(stateDir, 'event-sessions')
    mkdirSync(contexts)
    mkdirSync(sessions)
    const group = 'event:arcs/last-bell.md|arcs/next.md'
    const sessionId = randomUUID()
    const path = join(sessions, sessionId + '.jsonl')
    writeFileSync(path, 'PRIVATE_TRANSCRIPT_BODY')
    const receiptPath = join(contexts, createHash('sha256').update(group).digest('hex') + '.json')
    writeFileSync(receiptPath, JSON.stringify({ version: 1, group, sessionId,
      model: 'openai/gpt-6-luna:high', file: path,
      sources: { 'arcs/last-bell.md': 'private-story-data' } }))
    const results = await inspectSavedPiSessions({ stateDir })
    assert.deepEqual(results, [{ group, sessionId,
      model: 'openai/gpt-6-luna:high', transcriptRetained: true }])
    assert.doesNotMatch(JSON.stringify(results), /PRIVATE_TRANSCRIPT_BODY|private-story-data|nt-pi-index/)

    const escapedGroup = 'event:malicious'
    const escapeReceipt = join(contexts, createHash('sha256').update(escapedGroup).digest('hex') + '.json')
    writeFileSync(escapeReceipt, JSON.stringify({ version: 1, group: escapedGroup,
      sessionId: randomUUID(), model: 'x', file: '/etc/passwd' }))
    const after = await inspectSavedPiSessions({ stateDir })
    assert.equal(after.length, 1,
      'external transcript paths are not indexed or treated as retained')

    const symlinkGroup = 'event:symlink'
    symlinkSync(receiptPath, join(contexts,
      createHash('sha256').update(symlinkGroup).digest('hex') + '.json'))
    assert.equal((await inspectSavedPiSessions({ stateDir })).length, 1,
      'symlinked and inconsistent receipts are ignored')
  } finally { removeTestTree(stateDir) }
})
