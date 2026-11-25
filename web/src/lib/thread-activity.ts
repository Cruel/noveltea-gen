import type { ProgressEvent, ProgressDetail } from './generation-progress.server'

export type ActivityStep = {
  id: number
  kind: 'started' | 'stage' | 'report' | 'finished'
  stage: ProgressEvent['stage']
  milestone: string | null
  state: 'started' | 'working' | 'verified' | 'unverified' | 'stopped' | 'finished' | 'paused' | 'proposed'
  files: string[]
  outcome: ProgressEvent['status'] | 'interrupted' | null
  at: string
  detail?: ProgressDetail
}

const names: Record<NonNullable<ProgressEvent['stage']>, string> = {
  foundation: 'creative direction',
  architecture: 'Story architecture',
  foundations: 'world and character foundations',
  event: 'Event',
  interactive: 'interactive design',
  choice: 'Choice design',
  puzzle: 'Puzzle assessment',
  composition: 'composition',
  focus: 'focused revision',
  review: 'Story review',
}

export function activityStageName(stage: ProgressEvent['stage'], milestone: string | null) {
  const label = stage ? names[stage] : 'Story work'
  if (!milestone) return label
  const name = milestone.replace(/^[^.]+\./, '').replace(/[.-]/g, ' ')
  return label + ' · ' + name
}

/** Present only durable controller evidence. A working stage isn't a completed
 * edit, and the file list is emitted only on a verified commit boundary. */
export function projectActivity(events: readonly ProgressEvent[], runStatus?: string): ActivityStep[] {
  const steps: ActivityStep[] = []
  for (const event of events) {
    if (event.kind === 'started') {
      steps.push({ id: event.id, kind: 'started', stage: null, milestone: null,
        state: 'started', files: [], outcome: null, at: event.createdAt,
        detail: event.detail })
    } else if (event.kind === 'working' &&
      event.detail?.source === 'controller' &&
      event.detail.outcome === 'unknown-failure-assessing') {
      steps.push({ id: event.id, kind: 'report', stage: 'review', milestone: event.milestone,
        state: 'proposed', files: [], outcome: null, at: event.createdAt,
        detail: event.detail })
    } else if (event.kind === 'working' && event.detail?.approvalRevision) {
      // Administrative warnings remain queryable in the controller journal;
      // routine successful self-corrections do not create ordinary author Chat.
      continue
    } else if (event.kind === 'working' && event.detail?.reviewPhase) {
      // Controller phase transitions are neither model prose nor a review
      // verdict. Surface them without manufacturing a verified Story stage.
      steps.push({ id: event.id, kind: 'report', stage: 'review', milestone: null,
        state: 'proposed', files: [], outcome: null, at: event.createdAt,
        detail: event.detail })
    } else if (event.kind === 'working' && event.detail?.source === 'pi') {
      steps.push({ id: event.id, kind: 'report', stage: null, milestone: null,
        state: 'proposed', files: [], outcome: null, at: event.createdAt,
        detail: event.detail })
    } else if (event.kind === 'working') {
      for (const step of steps) if (step.state === 'working') step.state = 'unverified'
      steps.push({ id: event.id, kind: 'stage', stage: event.stage,
        milestone: event.milestone, state: 'working', files: [], outcome: null,
        at: event.createdAt, detail: event.detail })
    } else if (event.kind === 'verified') {
      const preceding = [...steps].reverse().find(step =>
        step.kind === 'stage' && step.state === 'working' &&
        step.stage === event.stage && step.milestone === event.milestone)
      if (preceding) {
        preceding.state = 'verified'
        preceding.files = event.files
        preceding.detail = event.detail
        preceding.at = event.createdAt
      } else {
        steps.push({ id: event.id, kind: 'stage', stage: event.stage,
          milestone: event.milestone, state: 'verified', files: event.files,
          outcome: null, at: event.createdAt, detail: event.detail })
      }
    } else if (event.kind === 'finished' || event.kind === 'interrupted') {
      const outcome = event.kind === 'interrupted' ? 'interrupted' : event.status
      for (const step of steps) {
        if (step.state === 'working') step.state =
          outcome === 'blocked' || outcome === 'interrupted' || outcome === 'cancelled'
            ? 'stopped' : outcome === 'paused' ? 'paused' : 'unverified'
      }
      steps.push({ id: event.id, kind: 'finished', stage: null, milestone: null,
        state: 'finished', files: [], outcome, at: event.createdAt,
        detail: event.detail })
    }
  }
  // A legacy or interrupted run can lack a terminal journal event. Never
  // leave its last stage labelled as actively working once the durable Thread
  // status says it stopped. Don't manufacture a finished event or verification.
  if (!steps.some(step => step.kind === 'finished') &&
      runStatus && !['running', 'queued'].includes(runStatus)) {
    for (const step of steps) if (step.state === 'working')
      step.state = runStatus === 'paused' ? 'paused' :
        ['blocked', 'interrupted', 'cancelled'].includes(runStatus) ? 'stopped' : 'unverified'
  }
  return steps
}

export function activityTitle(step: ActivityStep): string {
  if (step.kind === 'started') return 'Started generation'
  if (step.kind === 'report') {
    if (step.detail?.source === 'controller' &&
        step.detail.outcome === 'unknown-failure-assessing')
      return 'Read-only unfamiliar-failure assessment in progress'
    if (step.detail?.reviewPhase === 'planning') return 'Planning Milestone Blueprint'
    if (step.detail?.reviewPhase === 'reviewing') return 'Independent Milestone Blueprint review in progress'
    if (step.detail?.reviewPhase === 'reviewed') return step.detail.reviewActivity?.verdict === 'pass'
      ? 'Milestone Blueprint approved' : 'Milestone Blueprint requires revision'
    if (step.detail?.reviewPhase === 'diagnosing')
      return 'Independent diagnostic review in progress'
    if (step.detail?.reviewPhase === 'correcting')
      return 'Correcting within the saved assignment'
    return 'Model status · ' + (step.detail?.summary ?? 'Working; unverified')
  }
  if (step.kind === 'finished') {
    if (step.detail?.source === 'controller') {
      switch (step.detail.outcome) {
        case 'unknown-failure-operator-intervention':
          return 'Unfamiliar failure requires operator intervention'
        case 'unknown-failure-unsafe-evidence':
          return 'Recovery halted: unsafe evidence'
        case 'unknown-failure-resource-limit':
          return 'Recovery paused by the job resource limit'
        case 'unknown-failure-assessment':
          return 'Recovery assessment remains incomplete'
      }
    }
    switch (step.outcome) {
      case 'completed': return 'Generation finished'
      case 'paused': return 'Generation paused'
      case 'blocked': return 'Generation stopped'
      case 'interrupted': return 'Generation interrupted'
      case 'cancelled': return 'Generation cancelled'
      default: return 'Run ended; inspect its status'
    }
  }
  const unit = activityStageName(step.stage, step.milestone)
  switch (step.state) {
    case 'verified': return 'Verified ' + unit
    case 'working': return 'Working on ' + unit
    case 'stopped': return 'Stopped during ' + unit
    case 'paused': return 'Paused during ' + unit
    case 'unverified': return 'No verified result for ' + unit
    default: return 'Working on ' + unit
  }
}
