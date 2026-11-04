import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Archive, ArrowLeft, List, LoaderCircle, Pencil, Plus, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ThreadList } from '@/components/thread-list'
import { storyNavigationQuery, storyNavigationKey } from '@/lib/threads.queries'
import { addConversation, changeThreadArchive, setConversationTitle, setThreadPreferences, setThreadTitle } from '@/lib/threads.functions'
import { selectNavigationThreads } from '@/lib/thread-navigation'
import type { StoryThread } from '@/lib/threads.server'
import { useJobEventStream } from '@/hooks/use-job-event-stream'

export const Route = createFileRoute('/_protected/stories/$storyId/conversations')({
  validateSearch: (search: Record<string, unknown>): { conversation?: string; archived?: boolean } => ({
    ...(typeof search.conversation === 'string' ? { conversation: search.conversation } : {}),
    ...(search.archived === true || search.archived === 'true' ? { archived: true } : {}),
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(storyNavigationQuery(params.storyId)),
  component: StoryConversations,
})

function ThreadLiveUpdates({ jobId }: { jobId: string }) {
  // The existing durable EventSource hook owns replay/reconnect; only semantic
  // events, never keepalive comments, invalidate the Story navigation query.
  useJobEventStream(jobId, false)
  return null
}
function TitleEditor({ title, label, onSubmit, onCancel }: {
  title: string; label: string; onSubmit: (title: string) => Promise<void>; onCancel: () => void
}) {
  const [value, setValue] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
    event.preventDefault()
    setBusy(true); setError(null)
    void onSubmit(value).then(onCancel).catch(cause =>
      setError(cause instanceof Error ? cause.message : 'Unable to save title')).finally(() => setBusy(false))
  }}>
    <Input autoFocus aria-label={label} maxLength={120} value={value}
      onChange={event => setValue(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') onCancel()
      }} className="min-w-44 max-w-sm flex-1" />
    <Button type="submit" size="sm" disabled={busy || !value.trim()}>Save</Button>
    <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
    {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
  </form>
}
function StoryConversations() {
  const { storyId } = Route.useParams()
  const { conversation: selectedId, archived } = Route.useSearch()
  const archivedView = archived === true
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, error, isFetching } = useQuery({
    ...storyNavigationQuery(storyId),
    refetchInterval: query => query.state.data?.conversations.some(item =>
      item.threads.some(thread => thread.status === 'running' || thread.status === 'queued'))
      ? 8000 : 30000,
  })
  const [creating, setCreating] = useState(false)
  const [changingArchive, setChangingArchive] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ kind: 'conversation' | 'thread'; id: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: storyNavigationKey(storyId) })
  }
  const conversation = data?.conversations.find(item => item.id === selectedId) ?? data?.conversations[0]
  const view = data?.preferences.view ?? 'tree'
  const expandedIds = data?.preferences.expandedIds ?? []
  const visibleThreads = conversation ? selectNavigationThreads(conversation.threads,
    archivedView ? 'archived' : 'active') : []
  const archivedCount = conversation?.threads.filter(thread => !!thread.archivedAt).length ?? 0
  const savePreferences = async (nextView: 'tree' | 'flat', nextExpanded = expandedIds) => {
    setIssue(null)
    try {
      await setThreadPreferences({ data: { storyId, view: nextView, expandedIds: nextExpanded } })
      await refresh()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Unable to save preferences') }
  }
  const changeArchive = async (thread: StoryThread, archive: boolean) => {
    setChangingArchive(thread.id); setIssue(null)
    try {
      await changeThreadArchive({ data: { id: thread.id, archived: archive } })
      await refresh()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Unable to change Thread archive') }
    finally { setChangingArchive(null) }
  }
  const rename = async (value: string) => {
    if (!editing) return
    if (editing.kind === 'conversation')
      await setConversationTitle({ data: { id: editing.id, title: value } })
    else await setThreadTitle({ data: { id: editing.id, title: value } })
    await refresh()
  }
  const create = async () => {
    setCreating(true); setIssue(null)
    try {
      const made = await addConversation({ data: storyId })
      await refresh()
      await navigate({ to: '/stories/$storyId/conversations', params: { storyId },
        search: { conversation: made.id, ...(archivedView ? { archived: true } : {}) } })
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Unable to create Conversation') }
    finally { setCreating(false) }
  }
  // Watching the most recently active current job keeps this view responsive
  // between polling cycles. Job pages retain their own SSE subscription.
  const liveJob = visibleThreads.find(thread =>
    (thread.status === 'running' || thread.status === 'queued') && thread.jobId)?.jobId

  return <main className="page">
    {liveJob && <ThreadLiveUpdates key={liveJob} jobId={liveJob} />}
    <Link to="/dashboard" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <ArrowLeft className="size-4" /> Back to dashboard
    </Link>
    <div className="mb-5 flex items-center gap-2">
      <h1 className="m-0 flex-1 truncate text-xl font-semibold">{data?.story.title ?? 'Story'} · Conversations</h1>
      {isFetching && <LoaderCircle aria-label="Refreshing Conversations"
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
    </div>
    {(issue || error) && <p role="alert" className="mb-4 text-sm text-destructive">{issue ?? error?.message}</p>}
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(200px,260px)_minmax(0,1fr)]">
      <aside aria-label="Conversations" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="m-0 text-sm font-semibold">Conversations</h2>
          <Button variant="outline" size="sm" disabled={creating} onClick={() => void create()}>
            <Plus className="size-4" /> New
          </Button>
        </div>
        <nav aria-label="Story Conversations" className="grid gap-1">
          {data?.conversations.map(item =>
            <Link key={item.id} to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: item.id, ...(archivedView ? { archived: true } : {}) }}
              aria-current={item.id === conversation?.id ? 'page' : undefined}
              className={'block min-w-0 rounded-md px-3 py-2 text-sm no-underline hover:bg-muted/70 ' +
                (item.id === conversation?.id ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground')}>
              <span className="block truncate" title={item.title}>{item.title}</span>
              <span className="text-xs font-normal text-muted-foreground">{item.threads.length} Threads</span>
            </Link>)}
        </nav>
      </aside>
      <section aria-label="Conversation Threads" className="min-w-0">
        {conversation ? <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              {editing?.kind === 'conversation' && editing.id === conversation.id
                ? <TitleEditor key={conversation.id} title={conversation.title} label="Conversation title"
                  onSubmit={rename} onCancel={() => setEditing(null)} />
                : <div className="flex min-w-0 items-center gap-2">
                  <h2 className="m-0 truncate text-lg font-semibold">{conversation.title}</h2>
                  <Button size="icon" variant="ghost" aria-label="Rename Conversation"
                    onClick={() => setEditing({ kind: 'conversation', id: conversation.id })}>
                    <Pencil className="size-4" /></Button>
                </div>}
            </div>
            <div className="inline-flex items-center rounded-md border border-border p-0.5"
              role="group" aria-label="Thread layout">
              <Button size="sm" variant={view === 'tree' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'tree'} onClick={() => void savePreferences('tree')}>
                <Network className="size-4" /> Tree</Button>
              <Button size="sm" variant={view === 'flat' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'flat'} onClick={() => void savePreferences('flat')}>
                <List className="size-4" /> Flat</Button>
            </div>
          </div>
          <nav className="mb-3 flex flex-wrap items-center gap-2 text-sm" aria-label="Thread visibility">
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: conversation.id }}
              aria-current={!archivedView ? 'page' : undefined}
              className={'rounded-md px-3 py-1.5 no-underline hover:bg-muted ' +
                (!archivedView ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground')}>
              Active ({conversation.threads.length - archivedCount})
            </Link>
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: conversation.id, archived: true }}
              aria-current={archivedView ? 'page' : undefined}
              className={'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 no-underline hover:bg-muted ' +
                (archivedView ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground')}>
              <Archive className="size-3.5" /> Archived ({archivedCount})
            </Link>
          </nav>
          {archivedView && <p className="mb-3 text-xs text-muted-foreground">
            Archived Threads retain their job history and verified checkpoints. Archiving never pauses execution.
            Active ancestors are displayed for context.
          </p>}
          {editing?.kind === 'thread' ? <TitleEditor key={editing.id}
            title={conversation.threads.find(thread => thread.id === editing.id)?.title ?? ''}
            label="Thread title" onSubmit={rename} onCancel={() => setEditing(null)} /> : null}
          {visibleThreads.length ?
            <ThreadList threads={visibleThreads} view={view} expandedIds={expandedIds}
              archivedView={archivedView} busyThreadId={changingArchive}
              onArchiveChange={(thread, archive) => void changeArchive(thread, archive)}
              onExpand={id => void savePreferences(view,
                expandedIds.includes(id) ? expandedIds.filter(item => item !== id) : [...expandedIds, id])}
              onRename={(thread: StoryThread) => setEditing({ kind: 'thread', id: thread.id })} />
            : <p className="text-sm text-muted-foreground">{archivedView
              ? 'No archived Threads in this Conversation.'
              : conversation.threads.length
                ? 'No active Threads. Open Archived to inspect or restore a Thread.'
                : 'No Threads yet. The first generation run will create a root Thread in this Story.'}</p>}
        </> : <p className="text-sm text-muted-foreground">
          {data ? 'Create a Conversation to get started.' : 'Loading Conversations…'}
        </p>}
      </section>
    </div>
  </main>
}
