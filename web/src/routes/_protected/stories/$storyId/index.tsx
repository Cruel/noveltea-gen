import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Archive, ArrowLeft, ChevronDown, LoaderCircle, MoreHorizontal, PanelLeft, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { StoryCollectionsPanel } from '@/components/story-collections-panel'
import { StudioSelect } from '@/components/studio-select'
import { ThreadChat } from '@/components/thread-chat'
import { ThreadChatHeader } from '@/components/thread-chat-header'
import { ThreadUsage } from '@/components/thread-usage'
import { StoryFirstChat } from '@/components/story-first-chat'
import { StoryWorkspaceOutline } from '@/components/story-workspace-outline'
import { StoryDesktopWorkspace, StoryMobileWorkspace, parseStoryMobileView,
  STORY_MOBILE_VIEW_KEY, type StoryMobileView } from '@/components/story-desktop-workspace'
import { StoryInspectorSheet } from '@/components/story-workspace-explorer'
import { ThreadReviewSheet, type ReviewOpen } from '@/components/thread-review-sheet'
import { ThreadPublishSheet } from '@/components/thread-publish-sheet'
import type { ReviewSelection } from '@/lib/thread-review.server'
import { StoryRelationshipGraph } from '@/routes/_protected/jobs/-StoryRelationshipGraph'
import { readWorkspaceStoryIndex } from '@/lib/story-data.functions'
import { getThreadChat } from '@/lib/thread-chat.functions'
import { getThreadReview } from '@/lib/thread-review.functions'
import { jobEventsQuery } from '@/lib/job-events.queries'
import { projectActivity, type ActivityStep } from '@/lib/thread-activity'
import { activityHighlights, visibleActivityStep } from '@/lib/story-activity-overlay'
import { readStoryGraphPreferences, saveStoryGraphPreferences } from '@/lib/story-graph-preferences'
import { dashboardQuery } from '@/lib/dashboard.queries'
import { storyNavigationQuery, storyNavigationKey, storyUsageKey, storyUsageQuery } from '@/lib/threads.queries'
import { addCollection, setCollectionName, deleteCollection, moveThreadToCollection,
  saveSelectedStory, changeThreadArchive, deleteThreadResources,
  setThreadPreferences, setThreadTitle } from '@/lib/threads.functions'
import { selectNavigationThreads } from '@/lib/thread-navigation'
import { setCreativeMode } from '@/lib/threads.functions'
import type { CreativeMode } from '../../../../../../src/creative-policy'
import type { StoryThread } from '@/lib/threads.server'
import type { StoryCollection } from '@/persistence/collection-contracts'

export const Route = createFileRoute('/_protected/stories/$storyId/')({
  validateSearch: (search: Record<string, unknown>): { thread?: string; archived?: boolean; context?: string } => ({
    ...(typeof search.thread === 'string' ? { thread: search.thread } : {}),
    ...(search.archived === true || search.archived === 'true' ? { archived: true } : {}),
    ...(typeof search.context === 'string' &&
      /^[a-z][a-z0-9-]*\/[a-z0-9._-]+\.md$/.test(search.context)
      ? { context: search.context } : {}),
  }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(storyNavigationQuery(params.storyId)),
  component: StoryWorkspace,
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

function StoryWorkspace() {
  const { storyId } = Route.useParams()
  const { thread: selectedThreadId, archived, context: contextPath } = Route.useSearch()
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
  const [modeSaving, setModeSaving] = useState(false)
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
  const [explorerView, setExplorerView] = useState<StoryMobileView>('chat')
  const graphTabFocusPending = useRef(false)
  const [graphFocus, setGraphFocus] = useState<{ id: string; threadId: string; token: number } | null>(null)
  useEffect(() => {
    try { setExplorerView(parseStoryMobileView(window.localStorage.getItem(STORY_MOBILE_VIEW_KEY))) }
    catch { /* storage disabled */ }
  }, [])
  const changeMobileView = (next: StoryMobileView) => {
    if (next !== 'graph') setGraphFocus(null)
    setExplorerView(next)
    try { window.localStorage.setItem(STORY_MOBILE_VIEW_KEY, next) } catch { /* storage disabled */ }
  }
  const viewInGraph = () => {
    if (!selectedRecordId || !explorerThreadId || !explorerIndex) return
    graphTabFocusPending.current = true
    setGraphFocus(current => ({ id: selectedRecordId, threadId: explorerThreadId,
      token: (current?.token ?? 0) + 1 }))
    changeMobileView('graph')
  }
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    // View in Graph removes the focused Outline button. Restore keyboard
    // focus to the new active tab after React commits the mobile view.
    if (!isDesktop && explorerView === 'graph' && graphTabFocusPending.current) {
      graphTabFocusPending.current = false
      document.getElementById('story-mobile-tab-graph')?.focus()
    }
  }, [isDesktop, explorerView])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [hoveredActivity, setHoveredActivity] = useState<{
    threadId: string; jobId: string; step: ActivityStep
  } | null>(null)
  const [pinnedActivity, setPinnedActivity] = useState<{
    threadId: string; jobId: string; step: ActivityStep
  } | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState<ReviewOpen | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const openReview = (scope: ReviewSelection) => {
    setReviewOpen(previous => ({ scope, token: (previous?.token ?? 0) + 1 }))
  }
  useEffect(() => {
    setInspectorOpen(false)
    setReviewOpen(null)
    setPublishOpen(false)
    setGraphFocus(null)
    setHoveredActivity(null)
    setPinnedActivity(null)
    setSelectedRecordId(explorerThreadId
      ? readStoryGraphPreferences(storyId, explorerThreadId).selectedId : null)
  }, [storyId, explorerThreadId])
  const explorer = useQuery({
    queryKey: ['workspace-explorer', storyId, explorerThreadId],
    queryFn: () => readWorkspaceStoryIndex({ data: { storyId, threadId: explorerThreadId } }),
    retry: false,
    refetchInterval: selectedThread?.status === 'running' ? 8000 : 30000,
  })
  const explorerIndex = explorer.data?.index ?? null
  const selectedChat = useQuery({
    queryKey: ['thread-chat', explorerThreadId],
    queryFn: () => getThreadChat({ data: explorerThreadId! }),
    enabled: !!explorerThreadId,
  })
  // An execution is not proof of reviewable changes. The verified review
  // endpoint compares the actual cumulative Git revisions, including prior
  // publications; empty or unverified results do not display Review Changes.
  const reviewRevision = selectedChat.data?.turnReceipts.flatMap(turn =>
    turn.executions.filter(execution =>
      execution.status === 'completed' && execution.queuePhase === 'finished' &&
      !!execution.validatedSha).map(execution => execution.validatedSha!)).at(-1) ?? null
  const reviewAvailability = useQuery({
    queryKey: ['thread-review', explorerThreadId, { kind: 'cumulative' }, reviewRevision],
    queryFn: () => getThreadReview({ data: {
      threadId: explorerThreadId!, scope: { kind: 'cumulative' },
    } }),
    enabled: !!explorerThreadId && !!reviewRevision, retry: false, staleTime: 15_000,
  })
  const hasReviewableChanges = !!reviewRevision && !!reviewAvailability.data?.files.length &&
    reviewAvailability.data.headSha === reviewRevision
  const runJobs = selectedChat.data?.runs.map(run => run.jobId) ?? []
  const activeJobId = selectedChat.data?.runs.at(-1)?.jobId ?? null
  const jobActivity = useQuery({
    ...jobEventsQuery(activeJobId ?? ''), enabled: !!activeJobId,
  })
  const activeSteps = projectActivity(jobActivity.data?.events ?? [],
    selectedChat.data?.runs.at(-1)?.status)
  const recentStep = [...activeSteps].reverse().find(step =>
    step.state === 'verified' || step.state === 'working' || step.state === 'proposed') ?? null
  const pinnedStep = pinnedActivity?.threadId === explorerThreadId &&
    runJobs.includes(pinnedActivity.jobId) ? pinnedActivity : null
  const activityStep = visibleActivityStep(hoveredActivity, explorerThreadId, runJobs,
    pinnedStep ?? (recentStep && activeJobId ? { jobId: activeJobId, step: recentStep } : null))
  const highlights = activityHighlights(explorerIndex, activityStep)
  const onActivityHover = (jobId: string, step: ActivityStep | null) => {
    setHoveredActivity(step && explorerThreadId
      ? { jobId, threadId: explorerThreadId, step } : null)
  }
  const onActivityPin = (jobId: string, step: ActivityStep) => {
    if (!explorerThreadId) return
    setPinnedActivity(previous => previous?.threadId === explorerThreadId &&
      previous.jobId === jobId && previous.step.id === step.id ? null :
      { threadId: explorerThreadId, jobId, step })
  }
  useEffect(() => {
    if (!explorerIndex) return
    setSelectedRecordId(current => current &&
      explorerIndex.records.some(record => record.id === current) ? current :
      explorerIndex.records.find(record => record.type === 'creative-direction')?.id ??
      explorerIndex.records[0]?.id ?? null)
  }, [explorerIndex, explorerThreadId, storyId])
  useEffect(() => {
    if (!contextPath || !explorerIndex) return
    const target = explorerIndex.records.find(record => record.path === contextPath)
    if (!target) return
    setSelectedRecordId(target.id)
    setInspectorOpen(true)
    changeMobileView('outline')
    // Consume the navigation hint so later manual record selection is not reset.
    void navigate({ to: '/stories/$storyId', params: { storyId },
      search: { ...(selectedThreadId ? { thread: selectedThreadId } : {}),
        ...(archived ? { archived: true } : {}) }, replace: true })
  }, [contextPath, explorerIndex, storyId, selectedThreadId, archived, navigate])
  useEffect(() => {
    if (explorerThreadId && selectedRecordId && explorerIndex?.records.some(
      record => record.id === selectedRecordId))
      saveStoryGraphPreferences(storyId, explorerThreadId, { selectedId: selectedRecordId })
  }, [explorerIndex, explorerThreadId, selectedRecordId, storyId])
  const selectRecord = (id: string) => {
    setGraphFocus(null)
    setSelectedRecordId(id)
    if (explorerThreadId) saveStoryGraphPreferences(storyId, explorerThreadId, { selectedId: id })
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
    to: '/stories/$storyId', params: { storyId },
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
            <Link to="/stories/$storyId" params={{ storyId }}
              search={{}}
              onClick={() => setNavigationOpen(false)}
              aria-current={!archivedView ? 'page' : undefined}
              className={'rounded px-2 py-1 no-underline hover:bg-muted ' +
                (!archivedView ? 'bg-secondary font-medium' : 'text-muted-foreground')}>Active</Link>
            <Link to="/stories/$storyId" params={{ storyId }}
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
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
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
    {!isDesktop && <Button type="button" size="sm" variant="ghost"
      disabled={!selectedRecordId || !explorerIndex || !explorerThreadId}
      onClick={viewInGraph}>View in Graph</Button>}
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
      selectedId={selectedRecordId} onSelect={selectRecord} highlights={highlights} />}
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
        <StoryRelationshipGraph key={storyId + ':' + explorerThreadId}
          workspace={{ storyId, threadId: explorerThreadId }}
          index={explorerIndex} selectedId={selectedRecordId} onSelect={selectRecord}
          focusRequest={!isDesktop && graphFocus?.threadId === explorerThreadId ? graphFocus : null}
          onFocusComplete={token => setGraphFocus(current => current?.token === token ? null : current)}
          highlights={highlights} />
      </div>
    </>}
</div>
  const chatPanel = <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
  {data ? <>
    <ThreadChatHeader
      title={creatingThread ? 'New Thread' : selectedThread?.title ?? 'New Thread'}
      mode={creatingThread ? null : selectedChat.data?.creativePolicy.mode ?? null}
      modeDisabled={modeSaving || !!selectedChat.data?.archived}
      status={creatingThread ? null : selectedChat.data?.runs.at(-1)?.status ?? null}
      showReview={!creatingThread && hasReviewableChanges}
      onReview={() => openReview({ kind: 'cumulative' })}
      onModeChange={async (mode: CreativeMode) => {
        if (!explorerThreadId) return
        setModeSaving(true); setIssue(null)
        try {
          await setCreativeMode({ data: { threadId: explorerThreadId, mode } })
          await queryClient.invalidateQueries({ queryKey: ['thread-chat', explorerThreadId] })
        } catch (cause) {
          setIssue(cause instanceof Error ? cause.message : 'Thread mode could not be saved.')
        } finally { setModeSaving(false) }
      }}
    />
    <div className="flex min-h-0 flex-1 flex-col">
    {creatingThread || !data.threads.length ||
      (selectedThread && selectedThread.status === 'prepared' && selectedThread.id.startsWith('root:'))
      ? <StoryFirstChat key={creatingThread || !data.threads.length ? 'new:' + storyId : selectedThread!.id}
          storyId={storyId}
          threadId={!creatingThread && data.threads.length > 0 && selectedThread?.id.startsWith('root:')
            ? selectedThread.id : undefined}
          onSubmitted={async threadId => {
            setCreatingThread(false); await refresh()
            await navigate({ to: '/stories/$storyId', params: { storyId },
              search: { thread: threadId } })
          }} />
      : selectedThread ? <ThreadChat key={selectedThread.id} threadId={selectedThread.id}
        onReviewTurn={turnId => openReview({ kind: 'turn', turnId })}
        onActivityHover={onActivityHover} onActivityPin={onActivityPin}
        pinnedActivity={pinnedActivity?.threadId === selectedThread.id ?
          { jobId: pinnedActivity.jobId, stepId: pinnedActivity.step.id } : null} />
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
            if (next !== storyId) void navigate({ to: '/stories/$storyId',
              params: { storyId: next }, search: {} })
          }}
          options={dashboard.stories.map(story => ({
            value: story.id, label: story.title + ' · ' +
              (dashboard.repositories.find(repo => repo.id === story.repositoryId)?.name ?? 'Story'),
          }))} />
      </div> : <div className="min-w-0 flex-1 truncate text-lg font-semibold">
        {data?.story.title ?? 'Story'}
      </div>}
      {explorerThreadId && !selectedThread?.archivedAt && <Button type="button"
        size="sm" variant="outline" onClick={() => setPublishOpen(true)}>
        Publish
      </Button>}
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
      <StoryMobileWorkspace chat={chatPanel} outline={outlinePanel} graph={graphPanel}
        view={explorerView} onViewChange={changeMobileView} />}
    {explorerIndex && explorerThreadId && <StoryInspectorSheet storyId={storyId} threadId={explorerThreadId}
      index={explorerIndex} selectedId={selectedRecordId} onSelect={selectRecord}
      open={inspectorOpen} onOpenChange={setInspectorOpen} />}
    {explorerThreadId && publishOpen && <ThreadPublishSheet key={explorerThreadId}
      threadId={explorerThreadId} open onOpenChange={setPublishOpen} />}
    {explorerThreadId && reviewOpen && <ThreadReviewSheet
      key={explorerThreadId + ':' + reviewOpen.token} threadId={explorerThreadId}
      initialScope={reviewOpen.scope} open onOpenChange={next => { if (!next) setReviewOpen(null) }}
      canInspectRecord={id => !!explorerIndex?.records.some(record => record.id === id)}
      onInspectRecord={id => {
        if (!explorerIndex?.records.some(record => record.id === id)) return
        selectRecord(id)
        setReviewOpen(null)
        setInspectorOpen(true)
      }}
      onCorrection={() => {
        changeMobileView('chat')
        void queryClient.invalidateQueries({ queryKey: storyNavigationKey(storyId) })
      }} />}
  </main>
}
