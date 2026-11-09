import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Archive, ArrowLeft, ChevronDown, LoaderCircle, MoreHorizontal, PanelLeft, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { StoryCollectionsPanel } from '@/components/story-collections-panel'
import { StudioSelect } from '@/components/studio-select'
import { ThreadChat } from '@/components/thread-chat'
import { ThreadUsage } from '@/components/thread-usage'
import { StoryFirstChat } from '@/components/story-first-chat'
import { StoryWorkspaceOutline } from '@/components/story-workspace-outline'
import { StoryDesktopWorkspace, StoryMobileWorkspace } from '@/components/story-desktop-workspace'
import { StoryInspectorSheet } from '@/components/story-workspace-explorer'
import { StoryRelationshipGraph } from '@/routes/_protected/jobs/-StoryRelationshipGraph'
import { readWorkspaceStoryIndex } from '@/lib/story-data.functions'
import { dashboardQuery } from '@/lib/dashboard.queries'
import { storyNavigationQuery, storyNavigationKey, storyUsageKey, storyUsageQuery } from '@/lib/threads.queries'
import { addCollection, setCollectionName, deleteCollection, moveThreadToCollection,
  saveSelectedStory, changeThreadArchive, deleteThreadResources,
  setThreadPreferences, setThreadTitle } from '@/lib/threads.functions'
import { selectNavigationThreads } from '@/lib/thread-navigation'
import type { StoryThread } from '@/lib/threads.server'
import type { StoryCollection } from '@/persistence/collection-contracts'

export const Route = createFileRoute('/_protected/stories/$storyId/conversations')({
  validateSearch: (search: Record<string, unknown>): { thread?: string; archived?: boolean } => ({
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
  const { thread: selectedThreadId, archived } = Route.useSearch()
  const archivedView = archived === true
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: dashboard } = useQuery(dashboardQuery())
  const [showAll, setShowAll] = useState(false)
  const { data, error, isFetching } = useQuery({
    ...storyNavigationQuery(storyId),
    refetchInterval: query => query.state.data?.threads.some(thread => thread.status === 'running' || thread.status === 'queued')
      ? 8000 : 30000,
  })
  const [navigationOpen, setNavigationOpen] = useState(false)
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (desktop.matches) setNavigationOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])
  useEffect(() => {
    setShowAll(false)
    setCreatingThread(false)
    // A saved Story selection is per-user navigation only. The server
    // verifies ownership before updating it; never trust a client-supplied ID.
    void saveSelectedStory({ data: storyId }).then(() =>
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })).catch(() => {})
  }, [storyId, queryClient])
  const [usageOpen, setUsageOpen] = useState(false)
  const usage = useQuery({ ...storyUsageQuery(storyId), enabled: usageOpen, refetchInterval: usageOpen ? 15000 : false })
  const [creatingThread, setCreatingThread] = useState(false)
  const [changingArchive, setChangingArchive] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ kind: 'thread'; id: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: storyNavigationKey(storyId) }),
      queryClient.invalidateQueries({ queryKey: storyUsageKey(storyId) }),
    ])
  }
  const view = data?.preferences.view ?? 'tree'
  const expandedIds = data?.preferences.expandedIds ?? []
  const collapsedCollectionIds = data?.preferences.collapsedCollectionIds ?? []
  const visibleThreads = selectNavigationThreads(data?.threads ?? [],
    archivedView ? 'archived' : 'active')
  const archivedCount = data?.threads.filter(thread =>
    !!thread.archivedAt && !thread.deletionCompleteAt).length ?? 0
  const selectedThread = visibleThreads.find(thread => thread.id === selectedThreadId && !thread.deletedAt) ??
    visibleThreads.find(thread => !thread.deletedAt && (archivedView ? !!thread.archivedAt : !thread.archivedAt)) ??
    visibleThreads.find(thread => !thread.deletedAt)
  const explorerThreadId = creatingThread ? null : selectedThread?.id ?? null
  const [explorerView, setExplorerView] = useState<'chat' | 'graph' | 'outline'>('chat')
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  useEffect(() => { setInspectorOpen(false) }, [storyId, explorerThreadId])
  const explorer = useQuery({
    queryKey: ['workspace-explorer', storyId, explorerThreadId],
    queryFn: () => readWorkspaceStoryIndex({ data: { storyId, threadId: explorerThreadId } }),
    retry: false,
    refetchInterval: selectedThread?.status === 'running' ? 8000 : 30000,
  })
  const explorerIndex = explorer.data?.index ?? null
  useEffect(() => {
    setSelectedRecordId(current => {
      if (!explorerIndex) return null
      return current && explorerIndex.records.some(record => record.id === current) ? current :
        explorerIndex.records.find(record => record.type === 'creative-direction')?.id ??
        explorerIndex.records[0]?.id ?? null
    })
  }, [explorerIndex, explorerThreadId, storyId])
  const selectRecord = (id: string) => {
    setSelectedRecordId(id)
    setExplorerView('graph')
    setNavigationOpen(false)
  }
  const savePreferences = async (nextView: 'tree' | 'flat', nextExpanded = expandedIds,
    nextCollapsed = collapsedCollectionIds) => {
    setIssue(null)
    try {
      await setThreadPreferences({ data: { storyId, view: nextView, expandedIds: nextExpanded,
        collapsedCollectionIds: nextCollapsed } })
      await refresh()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Unable to save preferences') }
  }
  const createGroup = async (name: string) => {
    await addCollection({ data: { storyId, name } })
    await refresh()
  }
  const renameGroup = async (collection: StoryCollection, name: string) => {
    await setCollectionName({ data: { storyId, id: collection.id, name } })
    await refresh()
  }
  const removeGroup = async (collection: StoryCollection) => {
    if (!window.confirm('Remove Collection "' + collection.name +
      '"? Its Threads will become ungrouped. Fork lineage and saved work are unchanged.')) return
    setIssue(null)
    try {
      await deleteCollection({ data: { storyId, id: collection.id } })
      await refresh()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Could not remove Collection.') }
  }
  const moveToGroup = async (thread: StoryThread, collectionId: string | null) => {
    setChangingArchive(thread.id); setIssue(null)
    try {
      await moveThreadToCollection({ data: { storyId, threadId: thread.id, collectionId } })
      await refresh()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : 'Could not move Thread.') }
    finally { setChangingArchive(null) }
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
    await setThreadTitle({ data: { id: editing.id, title: value } })
    await refresh()
  }
  const openThread = (thread: StoryThread) => {
    setNavigationOpen(false)
    setCreatingThread(false)
    void navigate({
    to: '/stories/$storyId/conversations', params: { storyId },
    search: { thread: thread.id,
      ...(archivedView ? { archived: true } : {}) },
    })
  }
  // Reuse one navigation presentation in the desktop sidebar and mobile Sheet.
  // The chat is always the main panel; navigation never stacks above it.
  const navigation = <aside aria-label="Story Threads"
    className="flex h-full min-h-0 min-w-0 flex-col gap-2 rounded-lg bg-muted/20 p-2">
        {data && <>
          <div className="flex items-center justify-between px-2">
            <h2 className="m-0 text-xs font-semibold">Threads</h2>
            <Button variant="ghost" size="icon-sm" title="New Thread" aria-label="New Thread"
              onClick={() => { setCreatingThread(true); setEditing(null); setNavigationOpen(false) }}><Plus className="size-4" /></Button>
          </div>
          <nav aria-label="Thread visibility" className="flex items-center gap-1 px-1 text-xs">
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{}}
              onClick={() => setNavigationOpen(false)}
              aria-current={!archivedView ? 'page' : undefined}
              className={'rounded px-2 py-1 no-underline hover:bg-muted ' +
                (!archivedView ? 'bg-secondary font-medium' : 'text-muted-foreground')}>Active</Link>
            <Link to="/stories/$storyId/conversations" params={{ storyId }}
              search={{ archived: true }}
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
              title={data.threads.find(thread => thread.id === editing.id)?.title ?? ''}
              label="Thread title" onSubmit={rename} onCancel={() => setEditing(null)} />}
            <StoryCollectionsPanel threads={visibleThreads} collections={data.collections}
              view={view} expandedIds={expandedIds} collapsedCollectionIds={collapsedCollectionIds}
              selectedThreadId={selectedThread?.id} archivedView={archivedView} busyThreadId={changingArchive}
              showAll={showAll} onShowAll={setShowAll}
              onCreateCollection={createGroup} onRenameCollection={renameGroup}
              onRemoveCollection={collection => void removeGroup(collection)}
              onMoveThread={(thread, collectionId) => void moveToGroup(thread, collectionId)}
              onToggleCollection={id => void savePreferences(view, expandedIds,
                collapsedCollectionIds.includes(id)
                  ? collapsedCollectionIds.filter(item => item !== id)
                  : [...collapsedCollectionIds, id])}
              onArchiveChange={(thread, archive) => void changeArchive(thread, archive)}
              onDelete={deleteExecution}
              onExpand={id => void savePreferences(view,
                expandedIds.includes(id) ? expandedIds.filter(item => item !== id) : [...expandedIds, id])}
              onRenameThread={(thread: StoryThread) => setEditing({ kind: 'thread', id: thread.id })}
              onOpen={openThread} />
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
  const outlinePanel = <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg bg-muted/20 p-3">
  <div className="flex shrink-0 items-center justify-between gap-2">
    <h2 className="text-xs font-semibold">Story Outline</h2>
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs"
      disabled={!explorerIndex || !selectedRecordId || !explorerThreadId}
      onClick={() => setInspectorOpen(true)}>Inspect record</Button>
  </div>
  <div className="min-h-0 flex-1 overflow-auto" aria-label="Story Outline">
    {explorer.error && <p role="alert" className="text-xs text-destructive">{explorer.error.message}</p>}
    {!explorer.data && !explorer.error &&
      <p role="status" className="text-xs text-muted-foreground">Verifying Story revision…</p>}
    {explorer.data?.source === 'base' && <p className="text-xs text-muted-foreground">
      {explorer.data.story?.title ?? 'Story'} · {explorer.data.story?.provider ?? 'repository'}
      {' · '}{explorer.data.story?.directory ?? 'Story root'}
      {' · '}pinned source {explorer.data.baseSha.slice(0, 12)}.
      Select a verified Thread to browse native records.
    </p>}
    {explorerIndex && <StoryWorkspaceOutline index={explorerIndex}
      selectedId={selectedRecordId} onSelect={selectRecord} />}
  </div>
</div>
  const graphPanel = <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-3">
  {explorer.error ? <p role="alert" className="text-sm text-destructive">{explorer.error.message}</p>
    : !explorer.data ? <p role="status" className="text-sm text-muted-foreground">Verifying selected Thread revision…</p>
    : !explorerIndex ? <div className="space-y-2 text-sm text-muted-foreground">
      <h3 className="text-sm font-semibold text-foreground">Pinned Story source</h3>
      <p>{explorer.data.story?.title} · {explorer.data.story?.provider} · {explorer.data.story?.directory}</p>
      <p>Source commit: <code>{explorer.data.baseSha}</code></p>
      <p>No verified Thread revision is available yet. Canonical records and native links appear after validation.</p>
    </div> : <>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <p role="status" className="min-w-0 text-xs text-muted-foreground">
          Verified Thread <code>{explorerIndex.headSha.slice(0, 12)}</code>
          {' · '}{explorerIndex.records.length} records
          {' · '}{explorerIndex.diagnostics.length} diagnostics
        </p>
        <Button type="button" size="sm" variant="outline" className="shrink-0 text-xs"
          disabled={!selectedRecordId || !explorerThreadId}
          onClick={() => setInspectorOpen(true)}>Inspect record</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <StoryRelationshipGraph workspace={{ storyId, threadId: explorerThreadId }}
          index={explorerIndex} selectedId={selectedRecordId} onSelect={selectRecord} />
      </div>
      {explorer.data.jobId && <Link to="/jobs/$jobId"
        params={{ jobId: explorer.data.jobId }} search={{ tab: 'story' }}
        className="mt-2 shrink-0 text-xs underline underline-offset-2">
        Review Changes (full diff)
      </Link>}
    </>}
</div>
  const chatPanel = <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
  {data ? <>
    <header className="flex min-h-12 items-center gap-2 border-b border-border/50 px-4 py-2">
      <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">
        {creatingThread ? 'New Thread' : selectedThread?.title ?? 'New Thread'}
      </h2>
      {!isDesktop && <nav aria-label="Story workspace views" className="flex shrink-0 items-center gap-1 text-xs">
        {(['chat', 'graph', 'outline'] as const).map(view =>
          <Button key={view} size="sm" variant={explorerView === view ? 'secondary' : 'ghost'}
            className="h-7 px-2" aria-pressed={explorerView === view}
            onClick={() => setExplorerView(view)}>
            {view.charAt(0).toUpperCase() + view.slice(1)}
          </Button>)}
      </nav>}
    </header>
    {!isDesktop && explorerView === 'outline' && <div className="min-h-0 flex-1 overflow-auto">
      {outlinePanel}
    </div>}
    {!isDesktop && explorerView === 'graph' && <div className="min-h-0 flex-1 overflow-y-auto">
      {graphPanel}
    </div>}
    {/* Keep the composer mounted while viewing Graph or Outline: unsent text must survive. */}
    <div className={'min-h-0 flex-1 flex-col ' + (!isDesktop && explorerView !== 'chat' ? 'hidden' : 'flex')}>
    {creatingThread || !data.threads.length ||
      (selectedThread && selectedThread.status === 'prepared' && selectedThread.id.startsWith('root:'))
      ? <StoryFirstChat key={creatingThread || !data.threads.length ? 'new:' + storyId : selectedThread!.id}
          storyId={storyId}
          threadId={!creatingThread && data.threads.length > 0 && selectedThread?.id.startsWith('root:')
            ? selectedThread.id : undefined}
          onSubmitted={async threadId => {
            setCreatingThread(false); await refresh()
            await navigate({ to: '/stories/$storyId/conversations', params: { storyId },
              search: { thread: threadId } })
          }} />
      : selectedThread ? <ThreadChat key={selectedThread.id} threadId={selectedThread.id} />
        : <p className="p-5 text-sm text-muted-foreground">Select a Thread or create a new one.</p>}
    </div>
  </> : <p className="p-5 text-sm text-muted-foreground">Loading Threads…</p>}
</div>
  return <main className="mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
    <div className="mb-3 flex shrink-0 min-w-0 items-center gap-2">
      <Link to="/dashboard" aria-label="Back to dashboard" title="Back to dashboard"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ArrowLeft className="size-4" />
      </Link>
      <h1 className="sr-only">{data?.story.title ?? 'Story'}</h1>
      {dashboard?.stories.length ? <div className="min-w-0 flex-1">
        <StudioSelect aria-label="Selected Story" value={storyId}
          onValueChange={next => {
            if (next !== storyId) void navigate({ to: '/stories/$storyId/conversations',
              params: { storyId: next }, search: {} })
          }}
          options={dashboard.stories.map(story => ({
            value: story.id, label: story.title + ' · ' +
              (dashboard.repositories.find(repo => repo.id === story.repositoryId)?.name ?? 'Story'),
          }))} />
      </div> : <div className="min-w-0 flex-1 truncate text-lg font-semibold">
        {data?.story.title ?? 'Story'}
      </div>}
      <span className="hidden text-xs text-muted-foreground lg:inline">Story workspace</span>
      <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
        <SheetTrigger aria-label="Open Story Threads"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-2 lg:hidden">
          <PanelLeft className="size-4" />
          <span>Threads</span>
        </SheetTrigger>
        <SheetContent side="left" className="lg:hidden">
          <SheetTitle className="mb-3 shrink-0 px-2 pr-9">Browse Story</SheetTitle>
          <div className="min-h-0 flex-1">{navigation}</div>
        </SheetContent>
      </Sheet>
      {isFetching && <LoaderCircle aria-label="Refreshing Threads"
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
    </div>
    {(issue || error) && <p role="alert" className="mb-3 text-sm text-destructive">{issue ?? error?.message}</p>}
    {isDesktop ? <StoryDesktopWorkspace outline={outlinePanel}
      graph={graphPanel} threads={navigation} chat={chatPanel} /> :
      <StoryMobileWorkspace chat={chatPanel} />}
    {explorerIndex && explorerThreadId && <StoryInspectorSheet storyId={storyId} threadId={explorerThreadId}
      index={explorerIndex} selectedId={selectedRecordId} onSelect={selectRecord}
      open={inspectorOpen} onOpenChange={setInspectorOpen} />}
  </main>
}
