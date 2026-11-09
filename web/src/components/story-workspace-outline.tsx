import { Button } from '@/components/ui/button'
import type { ExplorerIndex, ExplorerRecord } from '@/lib/story-explorer.server'
import { StoryChangeLabels } from '@/routes/_protected/jobs/-StoryChangeLabels'

type Selection = {
  index: ExplorerIndex
  selectedId: string | null
  onSelect: (id: string) => void
}

const order = ['creative-direction', 'arc', 'milestone', 'event', 'beat', 'character',
  'relationship', 'world-entity', 'fact', 'revelation', 'choice-point', 'puzzle',
  'narrative-position', 'authored-content']

/** Record hierarchy comes from the native catalog, not inferred Markdown links.
 * Git-only placeholders never become selectable typed records. */
export function StoryWorkspaceOutline({ index, selectedId, onSelect }: Selection) {
  const groups = new Map<string, ExplorerRecord[]>()
  for (const record of index.records) groups.set(record.type, [...(groups.get(record.type) ?? []), record])
  const arcs = groups.get('arc') ?? []
  const milestones = groups.get('milestone') ?? []
  const events = groups.get('event') ?? []
  const arcIds = new Set(arcs.map(arc => arc.id))
  const linkedEvents = new Set(milestones.filter(m => m.arcs.some(id => arcIds.has(id)))
    .flatMap(m => m.events))
  const entry = (record: ExplorerRecord) => {
    const diagnostics = index.diagnostics.filter(item => item.path === record.path).length
    return <Button key={record.id} type="button" size="sm" variant="ghost"
      data-record-id={record.id}
      aria-current={selectedId === record.id ? 'true' : undefined}
      className={'h-auto min-h-7 w-full items-start justify-start px-2 py-1 text-left text-xs ' +
        (selectedId === record.id ? 'bg-secondary' : '')}
      onClick={() => onSelect(record.id)}>
      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{record.title}</span>
      <StoryChangeLabels change={record.change} />
      {diagnostics > 0 && <span title={diagnostics + ' diagnostics'} className="text-destructive">!</span>}
    </Button>
  }
  const group = (type: string, records: ExplorerRecord[]) => records.length > 0 && <details
    key={type} open={type === 'creative-direction' || records.some(record => record.id === selectedId)}>
    <summary className="cursor-pointer px-1 py-1 text-xs font-medium">
      {type.replaceAll('-', ' ')} ({records.length})
    </summary>
    <div className="grid pl-2">{records.map(entry)}</div>
  </details>
  return <nav aria-label="Canonical Story Outline" className="story-workspace-outline min-w-0 w-full">
    {group('creative-direction', groups.get('creative-direction') ?? [])}
    {arcs.length > 0 && <details open>
      <summary className="cursor-pointer px-1 py-1 text-xs font-medium">Arcs ({arcs.length})</summary>
      <div className="grid gap-1 pl-1">
        {arcs.map(arc => <div key={arc.id} className="min-w-0">
          {entry(arc)}
          <div className="ml-2 border-l border-border/50 pl-1">
            {milestones.filter(m => m.arcs.includes(arc.id)).map(m => <div key={m.id}>
              {entry(m)}
              <div className="ml-2 border-l border-border/50 pl-1">
                {events.filter(e => m.events.includes(e.id)).map(entry)}
              </div>
            </div>)}
            {events.filter(e => e.arcs.includes(arc.id) && !linkedEvents.has(e.id)).map(entry)}
          </div>
        </div>)}
      </div>
    </details>}
    {group('milestone', milestones.filter(m => !m.arcs.some(id => arcIds.has(id))))}
    {group('event', events.filter(e =>
      !e.arcs.some(id => arcIds.has(id)) && !linkedEvents.has(e.id)))}
    {[...groups].filter(([type]) => !['creative-direction', 'arc', 'milestone', 'event'].includes(type))
      .sort(([a], [b]) => (order.indexOf(a) < 0 ? order.length : order.indexOf(a)) -
        (order.indexOf(b) < 0 ? order.length : order.indexOf(b)) || a.localeCompare(b))
      .map(([type, records]) => group(type, records))}
    {index.deletedRecords.length > 0 && <details>
      <summary className="cursor-pointer px-1 py-1 text-xs font-medium">
        Deleted ({index.deletedRecords.length})
      </summary>
      <div className="space-y-1 pl-2 text-xs text-muted-foreground">
        {index.deletedRecords.map(record =>
          <p key={record.path} className="my-1 break-all">{record.title} <StoryChangeLabels change={record.change} /></p>)}
      </div>
    </details>}
    {index.unindexedRecords.length > 0 && <details>
      <summary className="cursor-pointer px-1 py-1 text-xs font-medium">
        Unindexed changes ({index.unindexedRecords.length})
      </summary>
      <div className="space-y-1 pl-2 text-xs text-muted-foreground">
        {index.unindexedRecords.map(record =>
          <p key={record.path} className="my-1 break-all">{record.path} <StoryChangeLabels change={record.change} /></p>)}
      </div>
    </details>}
    {!index.records.length && <p className="px-2 text-xs text-muted-foreground">
      No indexed canonical records at this revision.
    </p>}
  </nav>
}
