import assert from 'node:assert/strict'
import test from 'node:test'
import { certificationFailureSummary } from './support/full-story-case'

test('live certification identifies the actual terminal assignment and verified successor checkpoint', () => {
  const checkpoint = { eligible: true, commitSha: 'a'.repeat(40),
    workItem: 'event-reconstruction', nextWorkItem: 'event-accounts' }
  const summary = certificationFailureSummary({
    terminal: 'blocked', nativeValidation: 'passed', validationError: null, recoveryError: null,
    checkpointState: { reason: 'No authenticated corrective adapter.',
      active: { id: 'event:milestone.revelation', stage: 'event' },
      failures: { 'event:milestone.accounts': 'Missing skill read' },
      originalFailure: { operation: 'specialist-result', reason: 'Original correction did not converge',
        defects: [{ kind: 'semantic', path: 'milestones/revelation.md', code: 'event-missing-binding', detail: 'Formal binding missing' }] },
      recoveryLifecycle: { active: { origin: { assignmentId: 'event:milestone.revelation' } },
        decision: { action: 'diagnostic-stop', disposition: 'operator-intervention' } } },
    recoveryCheckpoints: [checkpoint, { ...checkpoint, eligible: false, commitSha: 'b'.repeat(40) }],
  }, '/private/observation.json')
  assert.equal(summary.reason, 'No authenticated corrective adapter.')
  assert.equal(summary.assignment, 'event:milestone.revelation')
  assert.equal(summary.stage, 'event')
  assert.equal(summary.recovery?.action, 'diagnostic-stop')
  assert.equal(summary.originalFailure?.defects?.[0]?.code, 'event-missing-binding')
  assert.equal(summary.latestVerifiedCheckpoint?.commitSha, checkpoint.commitSha)
  assert.equal(summary.failedAssignments['event:milestone.accounts'], 'Missing skill read')
  assert.equal(summary.observation, '/private/observation.json')
})
