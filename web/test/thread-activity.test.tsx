import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { decodeProgressFiles, type ProgressEvent } from '../src/lib/generation-progress.server'
import { activityTitle, projectActivity, activityStageName } from '../src/lib/thread-activity'
import {
  Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription,
  TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent,
} from '../src/components/ui/trace'

const event = (id: number, kind: ProgressEvent['kind'],
  stage: ProgressEvent['stage'] = null,
  files: string[] = [], status: ProgressEvent['status'] = null): ProgressEvent => ({
  id, kind, stage, milestone: null, files, status,
  createdAt: new Date(id * 1000).toISOString(),
})

test('progress history decodes legacy and provenance-bearing rows without granting Pi authority', () => {
  assert.deepEqual(decodeProgressFiles('["events/old.md"]'), { files: ['events/old.md'] })
  const report = { files: [], detail: { source: 'pi',
    summary: 'Working on scenes', proposedPaths: ['events/draft.md'] } }
  assert.deepEqual(decodeProgressFiles(JSON.stringify(report)), report)
  assert.deepEqual(decodeProgressFiles(JSON.stringify({
    files: ['events/new.md'], detail: { source: 'controller',
      headSha: 'a'.repeat(40), validation: 'passed', diagnostics: 0 },
  })).detail?.source, 'controller')
  assert.throws(() => decodeProgressFiles('{"files":"bad"}'), /Invalid persisted progress files/)
})

test('operator approval warnings are durable metadata, not ordinary author Chat activity', () => {
  const revision: ProgressEvent = { ...event(7, 'working', 'review'), detail: {
    source: 'controller', approvalRevision: { id: 'a'.repeat(64),
      milestoneId: 'milestone.disclosure', cause: 'unclassified', severity: 'warning',
      disposition: 'corrected',
    },
  } }
  assert.deepEqual(projectActivity([revision], 'completed'), [])
  assert.deepEqual(decodeProgressFiles(JSON.stringify({ files: [], detail: revision.detail }))
    .detail?.approvalRevision, revision.detail!.approvalRevision)
})

test('Pi status remains distinct from controller working and verified checkpoints', () => {
  const working = event(1, 'working', 'event')
  const pi = { ...event(2, 'working'), detail: {
    source: 'pi' as const, summary: 'Drafting the conversation',
    proposedPaths: ['events/conversation.md'],
  } }
  const verified = { ...event(3, 'verified', 'event', ['events/conversation.md']),
    detail: { source: 'controller' as const, headSha: 'b'.repeat(40), outcome: 'committed' } }
  const before = projectActivity([working, pi], 'running')
  assert.deepEqual(before.map(step => step.state), ['working', 'proposed'])
  assert.deepEqual(before[1]?.files, [])
  assert.equal(before[1]?.detail?.proposedPaths?.[0], 'events/conversation.md')
  assert.match(activityTitle(before[1]!), /Model status/)
  const after = projectActivity([working, pi, verified], 'completed')
  assert.deepEqual(after.map(step => step.state), ['verified', 'proposed'])
  assert.deepEqual(after[0]?.files, ['events/conversation.md'])
  assert.equal(after[0]?.detail?.headSha, 'b'.repeat(40))
  assert.equal(after[1]?.state, 'proposed',
    'previous Pi report must never be promoted to authoritative verification')
})

test('#213 controller-confirmed diagnosing and correction are not Pi status or editorial approval', () => {
  const events: ProgressEvent[] = [
    { ...event(1, 'working', 'review'), detail: {
      source: 'controller', reviewPhase: 'diagnosing',
    } },
    { ...event(2, 'working', 'review'), detail: {
      source: 'controller', reviewPhase: 'correcting',
    } },
    { ...event(3, 'working'), detail: {
      source: 'pi', summary: 'I have approved the Story', proposedPaths: [],
    } },
  ]
  const steps = projectActivity(events, 'running')
  assert.deepEqual(steps.map(s => s.kind), ['report', 'report', 'report'])
  assert.deepEqual(steps.map(s => s.files), [[], [], []])
  assert.deepEqual(steps.map(s => s.state), ['proposed', 'proposed', 'proposed'])
  assert.equal(steps[0]!.detail?.source, 'controller')
  assert.equal(steps[1]!.detail?.source, 'controller')
  assert.equal(steps[2]!.detail?.source, 'pi')
  assert.match(activityTitle(steps[0]!), /Independent diagnostic review/)
  assert.match(activityTitle(steps[1]!), /Correcting within the saved assignment/)
  assert.match(activityTitle(steps[2]!), /Model status/)
  assert.ok(!steps.some(s => s.state === 'verified'))
})

test('unfamiliar failure states remain controller evidence without granting review approval', () => {
  const outcomes = [
    ['unknown-failure-operator-intervention', /operator intervention/i],
    ['unknown-failure-unsafe-evidence', /unsafe evidence/i],
    ['unknown-failure-resource-limit', /resource limit/i],
    ['unknown-failure-assessment', /incomplete/i],
  ] as const
  for (const [outcome, text] of outcomes) {
    const entries: ProgressEvent[] = [
      { ...event(1, 'working', 'review'), detail: {
        source: 'controller', outcome: 'unknown-failure-assessing',
      } },
      { ...event(2, 'finished', null, [], 'blocked'), detail: {
        source: 'controller', outcome,
      } },
    ]
    const steps = projectActivity(entries, 'blocked')
    assert.equal(steps[0]?.kind, 'report')
    assert.equal(steps[0]?.state, 'proposed')
    assert.match(activityTitle(steps[0]!), /read-only unfamiliar-failure assessment/i)
    assert.match(activityTitle(steps[1]!), text)
    assert.equal(steps.some(step => step.state === 'verified'), false)
  }
})

test('the real blocked World foundations timeline renders verified stages and files before the failure', () => {
  const events = [
    event(1, 'started'),
    event(2, 'working', 'foundation'),
    event(3, 'verified', 'foundation', ['creative-direction/foundation.md']),
    event(4, 'working', 'architecture'),
    event(5, 'verified', 'architecture', ['arcs/missing-page.md', 'milestones/colleague-conversation.md']),
    event(6, 'working', 'foundations'),
    event(7, 'finished', null, [], 'blocked'),
  ]
  const result = projectActivity(events, 'blocked')
  assert.deepEqual(result.map(step => [step.kind, step.state]),
    [['started', 'started'], ['stage', 'verified'], ['stage', 'verified'],
      ['stage', 'stopped'], ['finished', 'finished']])
  assert.deepEqual(result.filter(step => step.state === 'verified').flatMap(step => step.files),
    ['creative-direction/foundation.md', 'arcs/missing-page.md',
      'milestones/colleague-conversation.md'])
  assert.equal(activityTitle(result[1]!), 'Verified creative direction')
  assert.equal(activityTitle(result[2]!), 'Verified Story architecture')
  assert.equal(activityTitle(result[3]!), 'Stopped during world and character foundations')
  assert.equal(activityTitle(result[4]!), 'Generation stopped')
  assert.deepEqual(result[3]!.files, [], 'unverified World work must not claim file changes')
  assert.equal(events[1]!.kind, 'working', 'projection must not mutate durable events')
})

test('a running specialist has live status, which settles on terminal or persisted failure', () => {
  const events = [event(1, 'started'), event(2, 'working', 'event')]
  const live = projectActivity(events, 'running')
  assert.equal(live[1]!.state, 'working')
  assert.equal(activityTitle(live[1]!), 'Working on Event')
  assert.equal(projectActivity(events, 'blocked')[1]!.state, 'stopped')
  assert.equal(projectActivity(events, 'paused')[1]!.state, 'paused')
  assert.equal(projectActivity(events, 'completed')[1]!.state, 'unverified')
  assert.equal(projectActivity([...events, event(3, 'interrupted')])[1]!.state, 'stopped')
  assert.equal(projectActivity([...events, event(3, 'finished', null, [], 'paused')])[1]!.state, 'paused')
})

test('an unfinished previous stage is never marked verified when new work begins', () => {
  const events = [
    event(1, 'working', 'event'),
    event(2, 'working', 'interactive'),
    event(3, 'verified', 'interactive', ['events/conversation.md']),
  ]
  const projected = projectActivity(events, 'completed')
  assert.equal(projected[0]!.state, 'unverified')
  assert.equal(projected[1]!.state, 'verified')
  assert.deepEqual(projected[0]!.files, [])
  assert.deepEqual(projected[1]!.files, ['events/conversation.md'])
  assert.equal(activityStageName('event', 'milestone.colleague-conversation'),
    'Event · colleague conversation')
  assert.equal(projectActivity([event(9, 'verified', 'foundation', ['creative-direction/foundation.md'])])[0]!.state,
    'verified', 'a paginated event snapshot can start with a verified event')
})

test('minimal shadcn-style Trace renders accessible list semantics and status', () => {
  const html = renderToStaticMarkup(createElement(Trace, { 'aria-label': 'Story activity' },
    createElement(TraceLine, { status: 'running' },
      createElement(TraceIcon, null, 'icon'),
      createElement('div', null,
        createElement(TraceTitle, null, 'Working on Story architecture'),
        createElement(TraceDescription, null, 'No verified files yet')))))
  assert.match(html, /<ol[^>]+aria-label="Story activity"/)
  assert.match(html, /<li[^>]+data-status="running"/)
  assert.match(html, /data-slot="trace-title"/)
  assert.match(html, /aria-hidden="true"/)
})

test('Trace stages can be individually collapsed and reveal a nested file trace', () => {
  const file = createElement(TraceLine, null,
    createElement(TraceIcon, null, 'file'),
    createElement(TraceTitle, null, 'arcs/missing-page.md'))
  const fileTrace = createElement(Trace, { 'aria-label': 'Verified Story files' }, file)
  const stage = createElement(TraceCollapsible, { open: false },
    createElement(TraceCollapsibleTrigger, null,
      createElement(TraceIcon, null, 'verified'),
      createElement(TraceTitle, null, 'Verified Story architecture')),
    createElement(TraceCollapsibleContent, null, fileTrace))
  const html = renderToStaticMarkup(createElement(Trace,
    { 'aria-label': 'Generation activity' }, createElement(TraceLine, null, stage)))
  assert.match(html, /<div[^>]+data-slot="trace-collapsible"[^>]+data-state="closed"/)
  assert.match(html, /<button[^>]+data-slot="trace-collapsible-trigger"[^>]+aria-expanded="false"/)
  assert.match(html, /data-slot="trace-collapsible-content"/)
  assert.match(html, /aria-label="Verified Story files"/)
  assert.match(html, /arcs\/missing-page\.md/)
  assert.equal((html.match(/<ol\b/g) ?? []).length, 2)
  assert.equal((html.match(/<li\b/g) ?? []).length, 2)
  assert.match(html, /data-state="closed" aria-hidden="true" inert=""/,
    'collapsed content is retained but inaccessible')
  assert.match(html, /grid-rows-\[0fr\]/)
  assert.match(html, /data-\[state=open\]:grid-rows-\[1fr\]/)
  assert.match(html, /motion-reduce:transition-none/,
    'height animation is disabled for reduced-motion users')
})

test('closing the root retains independently opened child stages', () => {
  const stage = createElement(TraceCollapsible, { open: true },
    createElement(TraceCollapsibleTrigger, null, 'Verified Story architecture'),
    createElement(TraceCollapsibleContent, null, 'arcs/missing-page.md'))
  const render = (rootOpen: boolean) => renderToStaticMarkup(
    createElement(TraceCollapsible, { open: rootOpen },
      createElement(TraceCollapsibleTrigger, null, 'Generation activity'),
      createElement(TraceCollapsibleContent, null,
        createElement(Trace, null, createElement(TraceLine, null, stage)))))
  const collapsed = render(false)
  const reopened = render(true)
  assert.match(collapsed, /aria-expanded="false"/)
  assert.equal((collapsed.match(/data-state="open"/g) ?? []).length, 2,
    'nested stage and its content remain open within a closed parent')
  assert.match(collapsed, /arcs\/missing-page\.md/,
    'outer collapse keeps the entire nested stage mounted')
  assert.equal((reopened.match(/aria-expanded="true"/g) ?? []).length, 2,
    'reopening the root must preserve the child open state')
})
