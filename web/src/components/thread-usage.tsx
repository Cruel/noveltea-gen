import * as React from 'react'
import type { StoryUsage, UsageAggregate, RunUsage } from '@/lib/thread-usage.server'

const integer = (value: number) => value.toLocaleString('en-US')
const dollars = (value: number) => '$' + value.toFixed(3)

function Totals({ label, usage }: { label: string; usage: UsageAggregate }) {
  return <section aria-label={label + ' model usage'} className="min-w-0">
    <h3 className="mb-2 text-sm font-medium">{label}</h3>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
      <div><dt className="text-muted-foreground">Runs</dt>
        <dd className="font-semibold">{integer(usage.runs)}</dd></div>
      <div><dt className="text-muted-foreground">Recorded calls</dt>
        <dd className="font-semibold">{integer(usage.modelCalls)}</dd></div>
      <div><dt className="text-muted-foreground">Recorded tokens</dt>
        <dd className="font-semibold">{integer(usage.tokens.total)}</dd></div>
      <div><dt className="text-muted-foreground">Recorded cost</dt>
        <dd className="font-semibold">{dollars(usage.costUsd)}{usage.unpricedCalls > 0 ? ' +' : ''}</dd></div>
      <div><dt className="text-muted-foreground">Active execution</dt>
        <dd className="font-semibold">{usage.activeSeconds.toFixed(1)}s</dd></div>
    </dl>
    {(usage.unavailableRuns > 0 || usage.unpricedCalls > 0 || usage.unknownTokenCalls > 0) &&
      <p className="mt-2 text-xs text-amber-500">
        Partial totals: {[
          usage.unavailableRuns ? usage.unavailableRuns + ' unavailable run(s)' : '',
          usage.unpricedCalls ? usage.unpricedCalls + ' unpriced call(s)' : '',
          usage.unknownTokenCalls ? usage.unknownTokenCalls + ' call(s) without token totals' : '',
        ].filter(Boolean).join('; ')}.
      </p>}
  </section>
}

function Run({ run }: { run: RunUsage }) {
  const observed = run.spent
  const source = {
    'pi-transcript': 'Model transcript · observed',
    'retained-summary': 'Retained usage summary',
    'fixture': 'Fixture · no model usage',
    'prepared': 'Not started',
    'unavailable': 'Usage unavailable',
  }[run.origin]
  const limit = (used: number, max: number | undefined) =>
    integer(used) + ' / ' + (max === undefined ? 'no limit' : integer(max))
  return <li className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-xs">
    <div className="min-w-0">
      {run.deleted
        ? <span className="font-medium">Run {run.runOrder + 1}</span>
        : <a href={'/jobs/' + encodeURIComponent(run.jobId)} className="font-medium underline-offset-2 hover:underline">
          Run {run.runOrder + 1}</a>}
      <span className="ml-2 text-muted-foreground">{source} · {run.status}</span>
    </div>
    <div className="text-muted-foreground">
      {observed
        ? <>{limit(observed.steps, run.limits?.steps)} steps · {limit(observed.modelCalls, run.limits?.modelCalls)} calls
          {' · '}{integer(observed.tokens.total)} tokens · {observed.activeSeconds.toFixed(1)}s active · {dollars(observed.costUsd)}
          {run.limits?.costUsd !== undefined ? ' / ' + dollars(run.limits.costUsd) : ''}
          {observed.unpricedCalls ? ' + unpriced' : ''}</>
        : 'Counters unavailable'}
    </div>
    {observed?.pause && <p className="w-full text-amber-500">Budget paused: {observed.pause.reason}</p>}
  </li>
}

export function ThreadUsage({ usage, threadId }: { usage: StoryUsage; threadId?: string }) {
  const [scope, setScope] = React.useState<'story' | 'thread'>(threadId ? 'thread' : 'story')
  const thread = usage.threads.find(item => item.threadId === threadId)
  const selected = scope === 'thread' && thread ? thread.total : usage.total
  return <div className="mt-3 space-y-3 text-xs">
    <label className="flex items-center justify-between gap-2 text-muted-foreground">
      Scope
      <select aria-label="Usage scope" className="max-w-32 rounded border border-border bg-background px-2 py-1"
        value={scope === 'thread' && thread ? 'thread' : 'story'}
        onChange={event => setScope(event.target.value as 'story' | 'thread')}>
        <option value="story">Story</option>
        {thread && <option value="thread">This Thread</option>}
      </select>
    </label>
    <Totals label={scope === 'thread' && thread ? 'Thread usage' : 'Story usage'} usage={selected} />
    {scope === 'thread' && thread && <details>
      <summary className="cursor-pointer font-medium">Individual run budgets and usage</summary>
      <ol className="mt-2 divide-y divide-border/40">{thread.runs.map(run =>
        <Run key={run.jobId} run={run} />)}</ol>
    </details>}
    <p className="text-[11px] text-muted-foreground">
      Observed model-session transcript totals only; direct-model or unreported usage is excluded.
      Inherited messages are not billed again.
    </p>
  </div>
}
