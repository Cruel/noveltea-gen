import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExplorerDiagnostic, ExplorerIndex, ExplorerRecord } from '../../../lib/story-explorer.server'
import { StoryRelationshipGraph } from './-StoryRelationshipGraph'
import { StoryChangeLabels } from './-StoryChangeLabels'

type LoadedRecord = { record: ExplorerRecord; markdown: string; headSha: string }
type Category = { title: string; records: ExplorerRecord[] }
const typeOrder = ['creative-direction', 'arc', 'milestone', 'event', 'beat', 'character',
  'relationship', 'world-entity', 'fact', 'revelation', 'choice-point', 'puzzle',
  'narrative-position', 'authored-content']

function heading(type: string) {
  return type.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') + 's'
}

export function StoryExplorer({ jobId, revision }: { jobId: string; revision: string }) {
  const [index, setIndex] = useState<ExplorerIndex | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const treeRef = useRef<HTMLElement>(null)
  const url = '/api/jobs/' + encodeURIComponent(jobId) + '/records'

  useEffect(() => {
    const controller = new AbortController()
    setIndex(null); setSelected(null); setLoaded(null); setError(null)
    void fetch(url, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { index?: ExplorerIndex; error?: string }
        if (!response.ok || !body.index) throw new Error(body.error || 'Could not load canonical Story index.')
        return body.index
      }).then(value => { setIndex(value); setSelected(
        value.records.find(record => record.type === 'creative-direction')?.id ?? value.records[0]?.id ?? null) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load Story') })
    return () => controller.abort()
  }, [url, revision, refreshToken])

  useEffect(() => {
    if (!selected || !index) return
    const controller = new AbortController()
    setLoaded(null); setRecordError(null)
    void fetch(url + '?id=' + encodeURIComponent(selected), { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { record?: ExplorerRecord; markdown?: string; headSha?: string; error?: string }
        if (!response.ok || !body.record || typeof body.markdown !== 'string' || !body.headSha)
          throw new Error(body.error || 'Could not read canonical record.')
        if (body.headSha !== index.headSha) throw new Error('Story revision changed. Refresh the record index.')
        return body as LoadedRecord
      }).then(value => setLoaded(value))
      .catch(e => { if (!controller.signal.aborted) setRecordError(e instanceof Error ? e.message : 'Unable to read record') })
    return () => controller.abort()
  }, [url, selected, index])

  useEffect(() => {
    if (!selected) return
    const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>('[data-record-id]')
    const target = [...(buttons ?? [])].find(button => button.dataset.recordId === selected)
    if (!target) return
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
  }, [selected, index])

  const groups = useMemo(() => {
    if (!index) return [] as Category[]
    const byType = new Map<string, ExplorerRecord[]>()
    for (const item of index.records) {
      const group = byType.get(item.type) ?? []
      group.push(item)
      byType.set(item.type, group)
    }
    return [...byType].sort(([a], [b]) => {
      const ia = typeOrder.indexOf(a), ib = typeOrder.indexOf(b)
      return (ia < 0 ? typeOrder.length : ia) - (ib < 0 ? typeOrder.length : ib) || a.localeCompare(b)
    }).map(([type, records]) => ({ title: heading(type), records }))
  }, [index])

  if (error) return <section aria-label="Story explorer">
    <h2>Canonical Story explorer</h2>
    <p role="alert" className="error">{error}</p>
    <button type="button" onClick={() => setRefreshToken(n => n + 1)}>Retry validation</button>
  </section>

  const diagnostics = index?.diagnostics ?? []
  const changedCount = (items: ExplorerRecord[]) =>
    new Set(items.filter(r => r.change).map(r => r.path)).size
  const groupChanges = (items: ExplorerRecord[], type: string) =>
    changedCount(items) + (index?.deletedRecords.filter(r => r.type === type).length ?? 0)
  const issueCount = (record: ExplorerRecord) => diagnostics.filter(d => d.path === record.path).length
  const item = (record: ExplorerRecord) => <button type="button" key={record.id}
    className={'story-record-link' + (selected === record.id ? ' selected' : '')}
    data-record-id={record.id}
    aria-current={selected === record.id ? 'true' : undefined}
    onClick={() => setSelected(record.id)}>
    <span>{record.title} <StoryChangeLabels change={record.change} /></span>
    <small>{record.id}{issueCount(record) ? ' · ' + issueCount(record) + ' diagnostics' : ''}</small>
  </button>
  const arcs = index?.records.filter(r => r.type === 'arc') ?? []
  const milestones = index?.records.filter(r => r.type === 'milestone') ?? []
  const events = index?.records.filter(r => r.type === 'event') ?? []
  const linkedEvents = new Set(milestones.flatMap(m => m.events))
  const arcMilestones = new Set(milestones.filter(m => m.arcs.some(id => arcs.some(a => a.id === id))).map(m => m.id))
  const arcEvents = new Set(events.filter(e => e.arcs.some(id => arcs.some(a => a.id === id))).map(e => e.id))
  const milestoneItem = (milestone: ExplorerRecord) => <li key={milestone.id}>
    {item(milestone)}
    {milestone.events.some(id => events.some(e => e.id === id)) && <ul className="story-tree-children">
      {events.filter(event => milestone.events.includes(event.id)).map(event => <li key={event.id}>{item(event)}</li>)}
    </ul>}
  </li>
  const otherGroups = groups.filter(g => !['Arcs', 'Milestones', 'Events'].includes(g.title))
  const arcDescendants = [...arcs, ...milestones.filter(m => m.arcs.some(id => arcs.some(a => a.id === id))),
    ...events.filter(e => e.arcs.some(id => arcs.some(a => a.id === id)))]
  const deleted = index?.deletedRecords ?? []
  const unindexed = index?.unindexedRecords ?? []

  return <section aria-label="Story explorer">
    <div className="story-explorer-heading">
      <div><h2>Canonical Story explorer</h2><p className="muted">Read-only records from the pinned native Story catalog.</p></div>
      <button type="button" onClick={() => setRefreshToken(n => n + 1)}>Revalidate</button>
    </div>
    {!index ? <p role="status">Loading canonical records and diagnostics…</p> : <>
      <p role="status" className="story-validation">
        Validation: <strong>{index.validation}</strong> · Protection: <strong>{index.protection}</strong> ·
        {index.records.length} typed records · {deleted.length} deleted · {unindexed.length} unindexed changes · {diagnostics.length} diagnostics
      </p>
      <div className="story-explorer-layout">
        <aside ref={treeRef} aria-label="Story record hierarchy" className="story-explorer-tree">
          {otherGroups.filter(g => g.records.some(r => r.type === 'creative-direction')).map(group =>
            <details key={group.title} open><summary>{group.title} ({group.records.length}) · {groupChanges(group.records, group.records[0]?.type ?? '')} changed</summary>
              <ul>{group.records.map(record => <li key={record.id}>{item(record)}</li>)}</ul>
            </details>)}
          {arcs.length > 0 && <details open><summary>Arcs ({arcs.length}) · {changedCount(arcDescendants) + deleted.filter(r => r.type === 'arc' ||
              r.arcs.some(id => arcs.some(a => a.id === id))).length} changed including descendants</summary><ul>
            {arcs.map(arc => <li key={arc.id}>{item(arc)}
              <ul className="story-tree-children">
                {milestones.filter(m => m.arcs.includes(arc.id)).map(milestoneItem)}
                {events.filter(event => event.arcs.includes(arc.id) && !linkedEvents.has(event.id))
                  .map(event => <li key={event.id}>{item(event)}</li>)}
              </ul></li>)}
          </ul></details>}
          {milestones.some(m => !arcMilestones.has(m.id)) && <details open>
            <summary>Unassigned milestones · {changedCount(milestones.filter(m => !arcMilestones.has(m.id)))} changed</summary><ul>{milestones.filter(m => !arcMilestones.has(m.id)).map(milestoneItem)}</ul>
          </details>}
          {events.some(e => !arcEvents.has(e.id) && !linkedEvents.has(e.id)) && <details open>
            <summary>Other events · {changedCount(events.filter(e => !arcEvents.has(e.id) && !linkedEvents.has(e.id)))} changed</summary><ul>{events.filter(e => !arcEvents.has(e.id) && !linkedEvents.has(e.id))
              .map(event => <li key={event.id}>{item(event)}</li>)}</ul>
          </details>}
          {otherGroups.filter(g => !g.records.some(r => r.type === 'creative-direction')).map(group =>
            <details key={group.title}><summary>{group.title} ({group.records.length}) · {groupChanges(group.records, group.records[0]?.type ?? '')} changed</summary>
              <ul>{group.records.map(record => <li key={record.id}>{item(record)}</li>)}</ul>
            </details>)}
          {deleted.length > 0 && <details open><summary>Deleted records ({deleted.length})</summary>
            <ul>{deleted.map(record => <li key={record.path} className="story-deleted-record">
              <span>{record.title} <StoryChangeLabels change={record.change} /></span>
              <small>{record.id ?? 'Historical path only'} · {record.path}</small>
            </li>)}</ul>
          </details>}
          {unindexed.length > 0 && <details open><summary>Unindexed changed files ({unindexed.length})</summary>
            <ul>{unindexed.map(record => <li key={record.path} className="story-deleted-record">
              <span>{record.path} <StoryChangeLabels change={record.change} /></span>
              <small>No canonical typed ID · not navigable</small>
            </li>)}</ul>
          </details>}
          {!index.records.length && !deleted.length && !unindexed.length && <p>No indexed canonical records.</p>}
        </aside>
        <div className="story-explorer-detail">
          <StoryRelationshipGraph jobId={jobId} index={index} selectedId={selected} onSelect={setSelected} />
        <div className="story-record-view" aria-label="Read-only Markdown record">
          {!selected && <p>Select a typed record to read its Markdown.</p>}
          {recordError && <p role="alert" className="error">{recordError}</p>}
          {selected && !loaded && !recordError && <p role="status">Loading record…</p>}
          {loaded && loaded.record.id === selected && <>
            <h3>{loaded.record.title}</h3>
            <p className="muted">{loaded.record.id} · {loaded.record.status} · {loaded.record.path} <StoryChangeLabels change={loaded.record.change} /></p>
            <pre className="story-markdown">{loaded.markdown}</pre>
            {diagnostics.filter(d => d.path === loaded.record.path).length > 0 &&
              <div><h3>Record diagnostics</h3><ul className="story-issues">
                {diagnostics.filter(d => d.path === loaded.record.path).map((d, i) =>
                  <li key={i}><strong>{d.code}</strong> (line {d.line ?? '?'}) — {d.message}</li>)}
              </ul></div>}
          </>}
        </div>
        </div>
      </div>
      <div className="story-diagnostics">
        <h3>Validation diagnostics ({diagnostics.length})</h3>
        {!diagnostics.length ? <p>No structural diagnostics reported.</p> :
          <ul className="story-issues">{diagnostics.map((d: ExplorerDiagnostic, i) => {
            const record = index.records.find(r => r.path === d.path)
            return <li key={i}>
              {record ? <button type="button" onClick={() => setSelected(record.id)}>
                {d.path}:{d.line ?? '?'}
              </button> : <span>{d.path ?? 'Story'}{d.line ? ':' + d.line : ''}</span>}
              {' '}<strong>{d.code}</strong> — {d.message}
            </li>
          })}</ul>}
      </div>
    </>}
  </section>
}
