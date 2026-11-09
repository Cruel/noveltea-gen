import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode, KeyboardEvent, PointerEvent } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelTopClose, PanelTopOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type StoryMobileView = 'chat' | 'outline' | 'graph'
export const STORY_MOBILE_VIEW_KEY = 'noveltea.story-workspace.mobile-view.v1'
export function parseStoryMobileView(value: string | null): StoryMobileView {
  return value === 'outline' || value === 'graph' ? value : 'chat'
}

const mobileViews: StoryMobileView[] = ['chat', 'outline', 'graph']
export function mobileViewForKey(current: StoryMobileView, key: string): StoryMobileView | null {
  const index = mobileViews.indexOf(current)
  const nextIndex = key === 'Home' ? 0 : key === 'End' ? mobileViews.length - 1 :
    key === 'ArrowRight' ? (index + 1) % mobileViews.length :
    key === 'ArrowLeft' ? (index + mobileViews.length - 1) % mobileViews.length : -1
  return nextIndex < 0 ? null : mobileViews[nextIndex]!
}

/** Mobile views occupy the same workspace. Chat remains mounted when hidden so
 * pending choices and an unsent composer draft survive navigation. */
export function StoryMobileWorkspace({ chat, outline, graph, view, onViewChange }: {
  chat: ReactElement; outline: ReactNode; graph: ReactNode
  view: StoryMobileView; onViewChange: (view: StoryMobileView) => void
}) {
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, current: StoryMobileView) => {
    const next = mobileViewForKey(current, event.key)
    if (!next) return
    event.preventDefault()
    onViewChange(next)
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[mobileViews.indexOf(next)]?.focus()
  }
  return <section aria-label="Selected Thread"
    className="story-mobile-workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60">
    <nav role="tablist" aria-label="Story workspace views"
      className="story-mobile-tabs flex shrink-0 items-center justify-center gap-1 border-b border-border/60 p-2">
      {mobileViews.map(item => <Button key={item} type="button" role="tab"
        id={'story-mobile-tab-' + item} aria-controls={'story-mobile-panel-' + item}
        aria-selected={view === item} tabIndex={view === item ? 0 : -1}
        size="sm" variant={view === item ? 'secondary' : 'ghost'}
        className="min-w-0 flex-1 text-xs motion-reduce:transition-none"
        onClick={() => onViewChange(item)} onKeyDown={event => navigateTabs(event, item)}>
        {item.charAt(0).toUpperCase() + item.slice(1)}
      </Button>)}
    </nav>
    <div id="story-mobile-panel-chat" role="tabpanel" aria-labelledby="story-mobile-tab-chat"
      hidden={view !== 'chat'}
      className={view === 'chat' ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
      {chat}
    </div>
    <div id="story-mobile-panel-outline" role="tabpanel" aria-labelledby="story-mobile-tab-outline"
      hidden={view !== 'outline'}
      className={view === 'outline' ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
      {view === 'outline' ? outline : null}
    </div>
    <div id="story-mobile-panel-graph" role="tabpanel" aria-labelledby="story-mobile-tab-graph"
      hidden={view !== 'graph'}
      className={view === 'graph' ? 'story-mobile-graph min-h-0 min-w-0 flex-1 overflow-hidden' : 'hidden'}>
      {view === 'graph' ? graph : null}
    </div>
  </section>
}

export const STORY_LAYOUT_KEY = 'noveltea.story-workspace.layout.v1'
export type StoryLayout = {
  storyOpen: boolean
  outlineOpen: boolean
  threadsOpen: boolean
  height: number
}
export const DEFAULT_STORY_LAYOUT: StoryLayout = {
  storyOpen: true, outlineOpen: true, threadsOpen: true, height: 42,
}
export const STORY_HEIGHT_MIN = 20
export const STORY_HEIGHT_MAX = 70

export function clampStoryHeight(height: number): number {
  // Preserve fractional percentages: rounding to whole points made dragging jump
  // by roughly 8px in an 800px workspace instead of following the pointer.
  return Math.min(STORY_HEIGHT_MAX, Math.max(STORY_HEIGHT_MIN, Math.round(height * 100) / 100))
}

export function storyHeightForPointer(startHeight: number, startY: number,
  currentY: number, viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return startHeight
  return clampStoryHeight(startHeight + 100 * (currentY - startY) / viewportHeight)
}

export function storyHeightForKey(height: number, key: string, shift: boolean): number | null {
  if (key === 'Home') return STORY_HEIGHT_MIN
  if (key === 'End') return STORY_HEIGHT_MAX
  if (key === 'ArrowUp') return clampStoryHeight(height - (shift ? 10 : 2))
  if (key === 'ArrowDown') return clampStoryHeight(height + (shift ? 10 : 2))
  return null
}

export function parseStoryLayout(value: string | null): StoryLayout {
  if (!value) return { ...DEFAULT_STORY_LAYOUT }
  try {
    const data: unknown = JSON.parse(value)
    if (!data || typeof data !== 'object') return { ...DEFAULT_STORY_LAYOUT }
    const item = data as Record<string, unknown>
    return {
      storyOpen: typeof item.storyOpen === 'boolean' ? item.storyOpen : true,
      outlineOpen: typeof item.outlineOpen === 'boolean' ? item.outlineOpen : true,
      threadsOpen: typeof item.threadsOpen === 'boolean' ? item.threadsOpen : true,
      height: typeof item.height === 'number' && Number.isFinite(item.height)
        ? clampStoryHeight(item.height) : DEFAULT_STORY_LAYOUT.height,
    }
  } catch {
    return { ...DEFAULT_STORY_LAYOUT }
  }
}

type Props = {
  outline: ReactNode
  graph: ReactNode
  threads: ReactNode
  chat: ReactNode
}

/** Site-wide layout is independent of each Thread's Graph viewport and filters. */
export function StoryDesktopWorkspace({ outline, graph, threads, chat }: Props) {
  const [layout, setLayout] = useState<StoryLayout>(DEFAULT_STORY_LAYOUT)
  const [ready, setReady] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ pointer: number; y: number; height: number } | null>(null)

  useEffect(() => {
    try { setLayout(parseStoryLayout(window.localStorage.getItem(STORY_LAYOUT_KEY))) } catch { /* storage disabled */ }
    setReady(true)
  }, [])
  useEffect(() => {
    if (!ready) return
    try { window.localStorage.setItem(STORY_LAYOUT_KEY, JSON.stringify(layout)) } catch { /* storage disabled */ }
  }, [ready, layout])

  const change = (patch: Partial<StoryLayout>) => setLayout(current => ({ ...current, ...patch }))
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = storyHeightForKey(layout.height, event.key, event.shiftKey)
    if (next === null) return
    change({ height: next })
    event.preventDefault()
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!layout.storyOpen || !viewport.current) return
    dragging.current = { pointer: event.pointerId, y: event.clientY, height: layout.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || dragging.current.pointer !== event.pointerId || !viewport.current) return
    const pixels = viewport.current.getBoundingClientRect().height
    change({ height: storyHeightForPointer(dragging.current.height,
      dragging.current.y, event.clientY, pixels) })
  }
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointer !== event.pointerId) return
    dragging.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const sidebar = 'min-h-0 min-w-0 overflow-y-auto'
  const column = 'minmax(200px,252px) minmax(0,1fr)'
  return <div ref={viewport} aria-label="Story workspace layout"
    className="hidden min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex"
    style={{ '--story-height': layout.height + '%' } as React.CSSProperties}>
    <div className="flex shrink-0 items-center gap-2 px-1 py-1">
      <Button size="sm" variant="ghost" aria-label={layout.storyOpen ? 'Collapse Story workspace' : 'Expand Story workspace'}
        aria-expanded={layout.storyOpen} onClick={() => change({ storyOpen: !layout.storyOpen })}>
        {layout.storyOpen ? <PanelTopClose className="size-4" /> : <PanelTopOpen className="size-4" />}
        <span className="ml-1">Story</span>
      </Button>
      {layout.storyOpen && <Button size="icon-sm" variant="ghost"
        aria-label={layout.outlineOpen ? 'Collapse Outline sidebar' : 'Expand Outline sidebar'}
        aria-expanded={layout.outlineOpen} onClick={() => change({ outlineOpen: !layout.outlineOpen })}>
        {layout.outlineOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
      </Button>}
    </div>
    {layout.storyOpen && <>
      <section aria-label="Story exploration" className="grid min-h-24 min-w-0 shrink-0 gap-3 overflow-hidden"
        style={{ height: 'calc(var(--story-height) - 36px)',
          gridTemplateColumns: layout.outlineOpen ? column : 'minmax(0,1fr)' }}>
        {layout.outlineOpen && <aside aria-label="Outline sidebar" className={sidebar}>{outline}</aside>}
        <div className="story-desktop-graph min-h-0 min-w-0 overflow-hidden rounded-lg border border-border/60">
          {graph}
        </div>
      </section>
      <div role="separator" tabIndex={0} aria-label="Resize Story and Chat panels"
        aria-orientation="horizontal" aria-valuemin={STORY_HEIGHT_MIN} aria-valuemax={STORY_HEIGHT_MAX}
        aria-valuenow={layout.height} aria-valuetext={layout.height + '% Story height'}
        onKeyDown={handleKey} onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
        className="group flex h-3 shrink-0 touch-none cursor-row-resize items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="h-1 w-12 rounded-full bg-border group-hover:bg-muted-foreground/60 group-focus-visible:bg-foreground" />
      </div>
    </>}
    <div className="flex shrink-0 items-center gap-2 px-1 py-1">
      <Button size="icon-sm" variant="ghost"
        aria-label={layout.threadsOpen ? 'Collapse Thread sidebar' : 'Expand Thread sidebar'}
        aria-expanded={layout.threadsOpen} onClick={() => change({ threadsOpen: !layout.threadsOpen })}>
        {layout.threadsOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
      </Button>
      <span className="text-xs font-semibold">Threads / Chat</span>
    </div>
    <div aria-label="Thread and Chat workspace" className="grid min-h-0 min-w-0 flex-1 gap-3"
      style={{ gridTemplateColumns: layout.threadsOpen ? column : 'minmax(0,1fr)' }}>
      {layout.threadsOpen && <aside aria-label="Thread sidebar" className={sidebar}>{threads}</aside>}
      <section aria-label="Selected Thread" className="min-h-0 min-w-0 overflow-hidden rounded-lg border border-border/60">
        {chat}
      </section>
    </div>
  </div>
}
