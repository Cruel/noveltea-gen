import assert from 'node:assert/strict'
import test from 'node:test'
import { certificationFailureSummary, formatCertificationProgress } from './support/full-story-case'

test('live certification identifies the actual terminal assignment and verified successor checkpoint', () => {
  const checkpoint = { eligible: true, semanticReview: 'passed', commitSha: 'a'.repeat(40),
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
    recoveryCheckpoints: [checkpoint, { ...checkpoint, eligible: false, commitSha: 'b'.repeat(40) }, { ...checkpoint, semanticReview: 'failed', commitSha: 'c'.repeat(40) }],
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

test('certification progress distinguishes correction, verdict and verified commit', () => {
  const base = { id: 101, kind: 'working' as const, stage: 'review' as const, milestone: 'milestone.accounts',
    files: [], status: null, createdAt: 'now' }
  assert.match(formatCertificationProgress({ ...base, detail: { source: 'controller', reviewPhase: 'correcting',
    reviewActivity: { activity: 'protocol-correction', round: 1, role: 'reviewer', reason: 'prior[0].round must be 0' } } })!,
    /milestone.accounts.*protocol-correction.*round 1.*prior\[0\]/)
  assert.match(formatCertificationProgress({ ...base, detail: { source: 'controller', reviewPhase: 'reviewed',
    reviewActivity: { activity: 'blueprint-review', verdict: 'revise', round: 0, findings: 2 } } })!,
    /blueprint-review.*round 0: revise.*2 findings/)
  assert.match(formatCertificationProgress({ ...base, kind: 'verified', detail: { source: 'controller', headSha: 'a'.repeat(40) } })!,
    /verified review.*aaaaaaaa/)
  assert.equal(formatCertificationProgress({ ...base, detail: { source: 'pi', summary: 'fake progress' } }), null)
})
