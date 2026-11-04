import { AlertCircle, Archive, ArchiveRestore, CheckCircle2, ChevronDown, ChevronRight, Clock3, GitBranch, LoaderCircle, Pencil } from 'lucide-react'
import { orderThreads } from '@/lib/thread-navigation'
import { ThreadExecutionTimeline } from '@/components/thread-execution-timeline'
import type { StoryThread } from '@/lib/threads.server'

const statusText = (status: StoryThread['status']) => ({
  'needs-author': 'Needs author', 'prepared': 'Prepared', 'queued': 'Queued',
  'running': 'Running', 'paused': 'Paused', 'blocked': 'Blocked',
  'completed': 'Completed', 'cancelled': 'Cancelled', 'archived': 'Archived',
})[status]

function StatusIcon({ status }: { status: StoryThread['status'] }) {
  if (status === 'archived') return <Archive aria-hidden="true" className="size-3" />
  if (status === 'running') return <LoaderCircle aria-hidden="true"
    className="size-3 animate-spin motion-reduce:animate-none" />
  if (status === 'queued' || status === 'prepared')
    return <Clock3 aria-hidden="true" className="size-3" />
  if (status === 'completed') return <CheckCircle2 aria-hidden="true" className="size-3" />
  if (status === 'needs-author' || status === 'blocked')
    return <AlertCircle aria-hidden="true" className="size-3" />
  return null
}

export function ThreadList({ threads, view, expandedIds, archivedView = false,
  busyThreadId, onExpand, onRename, onArchiveChange }: {
  threads: StoryThread[]; view: 'tree' | 'flat'; expandedIds: string[]
  archivedView?: boolean; busyThreadId?: string | null
  onExpand: (id: string) => void; onRename: (thread: StoryThread) => void
  onArchiveChange: (thread: StoryThread, archived: boolean) => void
}) {
  const rows = orderThreads(threads, view)
  const threadsById = new Map(threads.map(thread => [thread.id, thread]))
  const parents = new Map(threads.map(thread => [thread.id, thread.parentThreadId]))
  const hasChildren = new Set(threads.map(thread => thread.parentThreadId).filter(Boolean))
  // A dedicated archive view always reveals the full context chain: archived
  // descendants must never be hidden by the active view's collapse preference.
  const expanded = archivedView ? new Set(threads.map(thread => thread.id)) : new Set(expandedIds)
  const visible = rows.filter(thread => {
    if (view === 'flat') return true
    let parent = thread.parentThreadId
    const seen = new Set([thread.id])
    while (parent && threadsById.has(parent)) {
      if (seen.has(parent)) return false
      if (!expanded.has(parent)) return false
      seen.add(parent)
      parent = parents.get(parent) ?? null
    }
    return true
  })
  return <ul className="m-0 grid gap-0.5 p-0" role={view === 'tree' ? 'tree' : 'list'} aria-label="Story Threads">
    {visible.map(thread => <li key={thread.id}
      role={view === 'tree' ? 'treeitem' : 'listitem'}
      aria-level={view === 'tree' ? thread.depth + 1 : undefined}
      aria-expanded={view === 'tree' && hasChildren.has(thread.id) ? expanded.has(thread.id) : undefined}
      className="list-none">
      <div className="flex min-w-0 items-center gap-1 rounded-md px-2 py-2 hover:bg-muted/50"
        style={{ paddingInlineStart: view === 'tree' ? Math.min(thread.depth, 12) * 16 + 8 : 8 }}>
        {view === 'tree' && hasChildren.has(thread.id)
          ? archivedView
            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            : <button type="button" className="rounded p-0.5 hover:bg-muted focus-visible:outline-2"
              aria-label={(expanded.has(thread.id) ? 'Collapse ' : 'Expand ') + thread.title}
              onClick={() => onExpand(thread.id)}>
              {expanded.has(thread.id) ? <ChevronDown className="size-3.5" /> :
                <ChevronRight className="size-3.5" />}
            </button>
          : <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          {thread.jobId ? <a href={'/jobs/' + encodeURIComponent(thread.jobId)}
            className="block truncate text-sm font-medium" title={thread.title}>{thread.title}</a>
            : <span className="block truncate text-sm font-medium">{thread.title}</span>}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className={thread.status === 'needs-author' ? 'text-amber-400' : ''}>
              <span className="inline-flex items-center gap-1"><StatusIcon status={thread.status} />
                {archivedView && !thread.archivedAt ? 'Ancestor · ' : ''}{statusText(thread.status)}</span></span>
            {!archivedView && thread.parentThreadId && !parents.has(thread.parentThreadId) &&
              <span>Parent archived</span>}
            {view === 'flat' && thread.parentThreadId && threadsById.has(thread.parentThreadId) &&
              <span>From {threadsById.get(thread.parentThreadId)!.title}</span>}
            {thread.currentWork && <span className="truncate" title={thread.currentWork}>{thread.currentWork}</span>}
            <time dateTime={thread.activityAt} title={thread.activityAt}>
              {thread.activityAt.slice(0, 10)}</time>
          </div>
        </div>
        <button type="button" title={'Rename ' + thread.title} aria-label={'Rename Thread ' + thread.title}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2"
          onClick={() => onRename(thread)}><Pencil className="size-3.5" /></button>
        {(!archivedView || thread.archivedAt) && <button type="button"
          title={(thread.archivedAt ? 'Restore ' : 'Archive ') + thread.title}
          aria-label={(thread.archivedAt ? 'Restore Thread ' : 'Archive Thread ') + thread.title}
          disabled={busyThreadId === thread.id}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 disabled:opacity-50"
          onClick={() => onArchiveChange(thread, !thread.archivedAt)}>
          {thread.archivedAt ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        </button>}
      </div>
      {thread.jobId && <ThreadExecutionTimeline jobId={thread.jobId} />}
    </li>)}
  </ul>
}
