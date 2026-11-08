import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Archive, ArrowLeft, ChevronDown, LoaderCircle, MoreHorizontal, PanelLeft, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ThreadList } from '@/components/thread-list'
import { ThreadChat } from '@/components/thread-chat'
import { ThreadUsage } from '@/components/thread-usage'
import { NaturalStoryComposer } from '@/components/natural-story-composer'
import { storyNavigationQuery, storyNavigationKey, storyUsageKey, storyUsageQuery } from '@/lib/threads.queries'
import { addConversation, changeThreadArchive, deleteThreadResources,
  setConversationTitle, setThreadPreferences, setThreadTitle } from '@/lib/threads.functions'
import { selectNavigationThreads } from '@/lib/thread-navigation'
import type { StoryThread } from '@/lib/threads.server'

export const Route = createFileRoute('/_protected/stories/$storyId/conversations')({
  validateSearch: (search: Record<string, unknown>): { conversation?: string; thread?: string; archived?: boolean } => ({
    ...(typeof search.conversation === 'string' ? { conversation: search.conversation } : {}),
    ...(typeof search.thread === 'string' ? { thread: search.thread } : {}),
    ...(search.archived === true || search.archived === 'true' ? { archived: true } : {}),
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(storyNavigationQuery(params.storyId)),
  component: StoryConversations,
})

function TitleEditor({ title, label, onSubmit, onCancel }: {
  title: string; label: string; onSubmit: (title: string) => Promise<void>; onCancel: () => void
}) {
  const [value, setValue] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={event => {
    event.preventDefault()
    setBusy(true); setError(null)
    void onSubmit(value).then(onCancel).catch(cause =>
      setError(cause instanceof Error ? cause.message : 'Unable to save title')).finally(() => setBusy(false))
  }}>
    <Input autoFocus aria-label={label} maxLength={120} value={value}
      onChange={event => setValue(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') onCancel()
      }} className="min-w-32 max-w-sm flex-1" />
    <Button type="submit" size="sm" disabled={busy || !value.trim()}>Save</Button>
    <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
    {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
  </form>
}

function StoryConversations() {
  const { storyId } = Route.useParams()
  const { conversation: selectedId, thread: selectedThreadId, archived } = Route.useSearch()
  const archivedView = archived === true
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, error, isFetching } = useQuery({
    ...storyNavigationQuery(storyId),
    refetchInterval: query => query.state.data?.conversations.some(item =>
      item.threads.some(thread => thread.status === 'running' || thread.status === 'queued'))
      ? 8000 : 30000,
  })
  const [navigationOpen, setNavigationOpen] = useState(false)
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (desktop.matches) setNavigationOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])
  const [usageOpen, setUsageOpen] = useState(false)
  const usage = useQuery({ ...storyUsageQuery(storyId), enabled: usageOpen, refetchInterval: usageOpen ? 15000 : false })
  const [creating, setCreating] = useState(false)
  const [creatingThread, setCreatingThread] = useState(false)
  const [changingArchive, setChangingArchive] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ kind: 'conversation' | 'thread'; id: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: storyNavigationKey(storyId) }),
      queryClient.invalidateQueries({ queryKey: storyUsageKey(storyId) }),
    ])
  }
  const conversation = data?.conversations.find(item => item.id === selectedId) ?? data?.conversations[0]
  const view = data?.preferences.view ?? 'tree'
  const expandedIds = data?.preferences.expandedIds ?? []
  const visibleThreads = conversation ? selectNavigationThreads(conversation.threads,
    archivedView ? 'archived' : 'active') : []
  const archivedCount = conversation?.threads.filter(thread =>
    !!thread.archivedAt && !thread.deletionCompleteAt).length ?? 0
  const selectedThread = visibleThreads.find(thread => thread.id === selectedThreadId) ?? visibleThreads[0]
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
  const deleteExecution = async (thread: StoryThread) => {
    if (!thread.deletedAt && !window.confirm(
      'Permanently delete execution resources for "' + thread.title + '"?\n\n' +
      'This removes its disposable Git branch, worktree and unreferenced private receipts. ' +
      'Verified checkpoints will no longer be branchable. Archive is reversible; deletion is not.')) return
    setChangingArchive(thread.id); setIssue(null)
    try {
      const outcome = await deleteThreadResources({ data: thread.id })
      await refresh()
      if (outcome.state === 'pending') setIssue(outcome.message)
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Deletion was not completed; retry after inspection.') }
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
      setCreatingThread(true)
      setNavigationOpen(false)
      await navigate({ to: '/stories/$storyId/conversations', params: { storyId },
        search: { conversation: made.id } })
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Unable to create Conversation') }
    finally { setCreating(false) }
  }
  const openThread = (thread: StoryThread) => {
    setNavigationOpen(false)
    void navigate({
    to: '/stories/$storyId/conversations', params: { storyId },
    search: { conversation: conversation!.id, thread: thread.id,
      ...(archivedView ? { archived: true } : {}) },
    })
  }
  // Reuse one navigation presentation in the desktop sidebar and mobile Sheet.
  // The chat is always the main panel; navigation never stacks above it.
  const navigation = <aside aria-label="Conversations and Threads"
    className="flex h-full min-h-0 min-w-0 flex-col gap-2 rounded-lg bg-muted/20 p-2">
        <div className="flex items-center justify-between px-2 pt-1">
          <h2 className="m-0 text-xs font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon-sm" title="New Conversation" aria-label="New Conversation"
            disabled={creating} onClick={() => void create()}><Plus className="size-4" /></Button>
        </div>
        <nav aria-label="Story Conversations" className="story-conversation-list max-h-40 min-w-0 overflow-y-auto">
          {data?.conversations.map(item =>
            <Link key={item.id} to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: item.id }}
              onClick={() => { setNavigationOpen(false); setCreatingThread(false) }}
              aria-current={item.id === conversation?.id ? 'page' : undefined}
              className={'block w-full min-w-0 shrink-0 rounded-md px-2 py-1.5 text-sm no-underline hover:bg-muted/70 ' +
                (item.id === conversation?.id ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground')}>
              <span className="block truncate" title={item.title}>{item.title}</span>
            </Link>)}
        </nav>
        {conversation && <>
          <div className="my-1 border-t border-border/50" />
          <div className="flex items-center justify-between px-2">
            <h2 className="m-0 text-xs font-semibold">Threads</h2>
            <Button variant="ghost" size="icon-sm" title="New Thread" aria-label="New Thread"
              onClick={() => { setCreatingThread(true); setEditing(null); setNavigationOpen(false) }}><Plus className="size-4" /></Button>
          </div>
          <nav aria-label="Thread visibility" className="flex items-center gap-1 px-1 text-xs">
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: conversation.id }}
              onClick={() => setNavigationOpen(false)}
              aria-current={!archivedView ? 'page' : undefined}
              className={'rounded px-2 py-1 no-underline hover:bg-muted ' +
                (!archivedView ? 'bg-secondary font-medium' : 'text-muted-foreground')}>Active</Link>
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ conversation: conversation.id, archived: true }}
              onClick={() => setNavigationOpen(false)}
              aria-current={archivedView ? 'page' : undefined}
              className={'rounded px-2 py-1 no-underline hover:bg-muted ' +
                (archivedView ? 'bg-secondary font-medium' : 'text-muted-foreground')}>
              <Archive className="mr-1 inline size-3" />Archived{archivedCount ? ' (' + archivedCount + ')' : ''}</Link>
            <details className="relative ml-auto text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center rounded p-1 hover:bg-muted"
                aria-label="Thread list options"><MoreHorizontal className="size-4" /></summary>
              <div className="absolute right-0 z-20 mt-1 grid min-w-36 gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
                <button className="rounded px-2 py-1 text-left hover:bg-muted" onClick={() => void savePreferences('tree')}>
                  {view === 'tree' ? '✓ ' : ''}Branch order</button>
                <button className="rounded px-2 py-1 text-left hover:bg-muted" onClick={() => void savePreferences('flat')}>
                  {view === 'flat' ? '✓ ' : ''}Flat order</button>
              </div>
            </details>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {editing?.kind === 'thread' && <TitleEditor key={editing.id}
              title={conversation.threads.find(thread => thread.id === editing.id)?.title ?? ''}
              label="Thread title" onSubmit={rename} onCancel={() => setEditing(null)} />}
            {visibleThreads.length ? <ThreadList threads={visibleThreads} view={view} expandedIds={expandedIds}
              selectedThreadId={selectedThread?.id} archivedView={archivedView} busyThreadId={changingArchive}
              onArchiveChange={(thread, archive) => void changeArchive(thread, archive)}
              onDelete={deleteExecution}
              onExpand={id => void savePreferences(view,
                expandedIds.includes(id) ? expandedIds.filter(item => item !== id) : [...expandedIds, id])}
              onRename={(thread: StoryThread) => setEditing({ kind: 'thread', id: thread.id })}
              onOpen={openThread} />
              : <p className="px-2 text-xs text-muted-foreground">
                {archivedView ? 'No archived Threads.' : 'No Threads yet.'}</p>}
          </div>
        </>}
        <details className="border-t border-border/50 px-2 pt-2" open={usageOpen}
          onToggle={event => setUsageOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <ChevronDown className="size-3" /> Usage &amp; budgets
          </summary>
          {usageOpen && usage.data && <ThreadUsage usage={usage.data} threadId={selectedThread?.id} />}
          {usageOpen && usage.error && <p role="status" className="text-xs text-muted-foreground">
            Usage unavailable: {usage.error.message}</p>}
        </details>
  </aside>
  return <main className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
    <div className="mb-3 flex shrink-0 min-w-0 items-center gap-2">
      <Link to="/dashboard" aria-label="Back to dashboard" title="Back to dashboard"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ArrowLeft className="size-4" />
      </Link>
      <h1 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold">{data?.story.title ?? 'Story'}</h1>
      <span className="hidden text-xs text-muted-foreground lg:inline">Conversations</span>
      <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
        <SheetTrigger aria-label="Open Conversations and Threads"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-2 lg:hidden">
          <PanelLeft className="size-4" />
          <span>Threads</span>
        </SheetTrigger>
        <SheetContent side="left" className="lg:hidden">
          <SheetTitle className="mb-3 shrink-0 px-2 pr-9">Browse Story</SheetTitle>
          <div className="min-h-0 flex-1">{navigation}</div>
        </SheetContent>
      </Sheet>
      {isFetching && <LoaderCircle aria-label="Refreshing Conversations"
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
    </div>
    {(issue || error) && <p role="alert" className="mb-3 text-sm text-destructive">{issue ?? error?.message}</p>}
    <div className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(200px,252px)_minmax(0,1fr)]">
      <div className="hidden min-h-0 lg:block">{navigation}</div>
      <section aria-label="Selected conversation"
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 p-0">
        {conversation ? <>
          <header className="flex min-h-12 items-center gap-2 border-b border-border/50 px-4 py-2">
            {editing?.kind === 'conversation' && editing.id === conversation.id
              ? <TitleEditor key={conversation.id} title={conversation.title} label="Conversation title"
                onSubmit={rename} onCancel={() => setEditing(null)} />
              : <>
                <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
                  {creatingThread ? 'New Thread' : selectedThread?.title ?? conversation.title}
                </h2>
                <Button size="icon-sm" variant="ghost" title="Rename Conversation" aria-label="Rename Conversation"
                  onClick={() => setEditing({ kind: 'conversation', id: conversation.id })}>
                  <Pencil className="size-3.5" /></Button>
              </>}
          </header>
          {creatingThread || !conversation.threads.length
            ? <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-6">
              <p className="mb-3 text-sm text-muted-foreground">Describe what you want to create in this Story.</p>
              <NaturalStoryComposer key={conversation.id} conversationId={conversation.id}
                onStarted={async threadId => {
                  setCreatingThread(false); await refresh()
                  await navigate({ to: '/stories/$storyId/conversations', params: { storyId },
                    search: { conversation: conversation.id, thread: threadId } })
                }} />
              {conversation.threads.length > 0 && <Button variant="ghost" size="sm"
                className="mt-3" onClick={() => setCreatingThread(false)}>Cancel</Button>}
            </div>
            : selectedThread ? <ThreadChat key={selectedThread.id} threadId={selectedThread.id} />
              : <p className="p-5 text-sm text-muted-foreground">Select a Thread or create a new one.</p>}
        </> : <p className="p-5 text-sm text-muted-foreground">
          {data ? 'Create a Conversation to get started.' : 'Loading Conversations…'}
        </p>}
      </section>
    </div>
  </main>
}
