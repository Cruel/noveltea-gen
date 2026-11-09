import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExecutionEvidence } from '../src/components/thread-execution-evidence'
import type { JobOverview } from '../src/lib/jobs.functions'

test('inline execution evidence distinguishes verified checkpoints, unverified drafts and private Pi reports', () => {
  const job: JobOverview = {
    id: 'run-1', storyId: 'story-1', title: 'Test', provider: 'github',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), status: 'interrupted',
    threadId: 'internal-generation-session', storyThreadId: 'thread-1', fixture: false,
    task: null, threadMessages: [], contract: null, reason: null, completedStages: [],
    revisionVerified: false, restartSource: null, forkSource: null,
    savedPiSessions: [{ group: 'foundation:write', sessionId: 'session-12345678',
      model: 'openai/gpt-6-luna', transcriptRetained: true }],
    recovery: { kind: 'operator-reconciliation', stage: 'interrupted',
      workItem: null, files: ['events/draft.md'], candidateDigest: null,
      guidance: 'Inspect before deciding how to continue.' },
    recoveryCheckpoints: [{
      commitSha: 'a'.repeat(40), parentSha: '0'.repeat(40), workItem: 'foundation',
      stage: 'foundation', eligible: true, reason: null, planVersion: 1,
      planDigest: 'digest', proofDigest: 'proof', source: 'checkpoint',
      snapshotId: null, completedWorkItems: ['foundation'],
      remainingWorkItems: ['architecture'], nextWorkItem: 'architecture',
      dependencies: {}, validation: { status: 'passed', validatorVersion: '1.0.0' },
      semanticReview: 'not-required', assurance: null,
    }],
  }
  const html = renderToStaticMarkup(createElement(ExecutionEvidence, {
    job, events: [
      { id: 1, kind: 'working', stage: null, milestone: null, files: [],
        status: null, createdAt: '2026-11-09T00:00:00Z',
        detail: { source: 'pi', summary: 'PRIVATE_PI_TRANSCRIPT' } },
      { id: 2, kind: 'verified', stage: 'foundation', milestone: null,
        files: ['creative-direction/foundation.md'], status: null,
        createdAt: '2026-11-09T00:00:01Z',
        detail: { source: 'controller', validation: 'passed', headSha: 'a'.repeat(40) } },
    ],
  }))
  assert.match(html, /Revision verification: failed \/ unverified/)
  assert.match(html, /Last recorded HEAD \(not necessarily verified\)/)
  assert.match(html, /Native validation: passed/)
  assert.match(html, /Semantic review: not-required/)
  assert.match(html, /Preserved interrupted specialist/)
  assert.match(html, /Saved specialist Pi sessions/)
  assert.match(html, /session-12345678/)
  assert.match(html, /original transcript retained/)
  assert.match(html, /creative-direction\/foundation\.md/)
  assert.doesNotMatch(html, /PRIVATE_PI_TRANSCRIPT/)
})
