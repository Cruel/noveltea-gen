import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect } from '@/components/ui/native-select'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { readStoryGraph } from '../../../lib/story-data.functions'
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ExplorerGraph, ExplorerIndex } from '../../../lib/story-explorer.server'
import { changeText } from './-StoryChangeLabels'

type Props = {
  jobId: string
  index: ExplorerIndex
  selectedId: string | null
  onSelect: (id: string) => void
}

const limits = [16, 40, 80] as const

/** Render only the native Context Manifest neighborhood; no client link discovery. */
export function StoryRelationshipGraph({ jobId, index, selectedId, onSelect }: Props) {
  const [scope, setScope] = useState<'focused' | 'related'>('focused')
  const [kind, setKind] = useState('all')
  const [limit, setLimit] = useState<number>(16)
  const [connectedOnly, setConnectedOnly] = useState(false)
  const [collapseOuter, setCollapseOuter] = useState(true)
  const [showDeleted, setShowDeleted] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => { setKind('all') }, [selectedId])

  const graphQuery = useQuery({
    queryKey: ['story-graph', jobId, index.headSha, selectedId, scope, refreshToken] as const,
    queryFn: () => readStoryGraph({ data: { jobId, selectedId: selectedId!, scope } }),
    enabled: !!selectedId,
  })
  const graph = graphQuery.data?.graph ?? null
  const error = graphQuery.error?.message ?? null

  const currentGraph = graph?.selectedId === selectedId && graph.headSha === index.headSha &&
    graph.scope === scope ? graph : null
  const kinds = useMemo(() => [...new Set([
    ...(currentGraph?.records.map(r => r.type) ?? []),
    ...index.deletedRecords.map(r => r.type).filter((type): type is string => !!type),
  ])].sort(), [currentGraph, index.deletedRecords])
  const view = useMemo(() => {
    if (!currentGraph || !selectedId) {
      const paths = showDeleted ? [
        ...index.deletedRecords.map(record => ({ path: record.path,
          label: record.title + ' · deleted', change: record.change })),
        ...index.unindexedRecords.map(record => ({ path: record.path,
          label: record.path + ' · no typed ID', change: record.change })),
      ] : []
      const nodes: Node[] = paths.slice(0, limit).map((record, i) => ({
        id: 'placeholder:' + record.path, position: { x: (i % 3) * 260, y: Math.floor(i / 3) * 96 },
        data: { label: record.label + '\n' + changeText(record.change) }, selectable: false,
        style: { width: 205, border: '1px dashed #b3a69c', borderRadius: 7,
          background: '#302d2b', color: '#e4e9ef', fontSize: 12, padding: 7, whiteSpace: 'pre-wrap' },
      }))
      return { nodes, edges: [] as Edge[], hidden: paths.length - nodes.length, collapsed: 0 }
    }
    const records = new Map(currentGraph.records.map(record => [record.id, record]))
    const neighbors = new Map<string, Set<string>>()
    for (const edge of currentGraph.relationships) {
      if (!records.has(edge.source) || !records.has(edge.target)) continue
      for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]] as Array<[string, string]>) {
        const adjacent = neighbors.get(from) ?? new Set<string>()
        adjacent.add(to); neighbors.set(from, adjacent)
      }
    }
    const depth = new Map<string, number>([[selectedId, 0]])
    const queue = [selectedId]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]!
      for (const next of neighbors.get(id) ?? []) {
        if (depth.has(next)) continue
        depth.set(next, depth.get(id)! + 1)
        queue.push(next)
      }
    }
    const filtered = currentGraph.records.filter(record =>
      record.id === selectedId || ((kind === 'all' || record.type === kind) &&
        (!connectedOnly || depth.has(record.id))))
    const candidates = filtered.filter(record =>
      record.id === selectedId || !collapseOuter || (depth.get(record.id) ?? 100) <= 1)
      .sort((a, b) => (depth.get(a.id) ?? 100) - (depth.get(b.id) ?? 100) ||
        a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
    const shown = candidates.slice(0, limit)
    const ids = new Set(shown.map(record => record.id))
    const columns = new Map<number, number>()
    const nodes: Node[] = shown.map(record => {
      const level = Math.min(depth.get(record.id) ?? 3, 3)
      const row = columns.get(level) ?? 0
      columns.set(level, row + 1)
      return {
        id: record.id,
        position: { x: level * 260, y: row * 96 },
        data: { label: record.title + ' · ' + record.type + (changeText(record.change) ? '\n' + changeText(record.change) : '') },
        selected: record.id === selectedId,
        style: { width: 205, background: record.id === selectedId ? '#244e65' : '#263847',
          border: record.id === selectedId ? '2px solid #86c9ed' : '1px solid #60788b',
          borderRadius: 7, color: '#e4e9ef', fontSize: 12, padding: 7 },
      }
    })
    // Deleted records have no current native Context Manifest evidence. Show
    // disconnected Git placeholders, NEVER inferred or stale relationship edges.
    const deleted = showDeleted ? index.deletedRecords.filter(record =>
      kind === 'all' || record.type === kind) : []
    const visibleDeleted = deleted.slice(0, Math.max(0, limit - shown.length))
    for (const [i, record] of visibleDeleted.entries()) nodes.push({
      id: 'deleted:' + record.path,
      position: { x: 1040, y: i * 96 },
      data: { label: record.title + ' · deleted\n' + changeText(record.change) },
      selectable: false,
      style: { width: 205, border: '1px dashed #b3a69c', borderRadius: 7,
        background: '#302d2b', color: '#e4e9ef', fontSize: 12, padding: 7, whiteSpace: 'pre-wrap' },
    })
    const unindexed = kind === 'all' && showDeleted ? index.unindexedRecords : []
    const visibleUnindexed = unindexed.slice(0, Math.max(0, limit - shown.length - visibleDeleted.length))
    for (const [i, record] of visibleUnindexed.entries()) nodes.push({
      id: 'unindexed:' + record.path,
      position: { x: 1300, y: i * 96 },
      data: { label: record.path + ' · no typed ID\n' + changeText(record.change) },
      selectable: false,
      style: { width: 205, border: '1px dashed #b3a69c', borderRadius: 7,
        background: '#302d2b', color: '#e4e9ef', fontSize: 12, padding: 7, whiteSpace: 'pre-wrap' },
    })
    const edges: Edge[] = currentGraph.relationships.filter(edge =>
      ids.has(edge.source) && ids.has(edge.target)).map((edge, i) => ({
        id: edge.source + ':' + edge.target + ':' + edge.code + ':' + i,
        source: edge.source, target: edge.target, data: { relationCode: edge.code },
        label: shown.length <= 16 ? edge.code.replaceAll('-', ' ') : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#8eb4c8' },
        labelStyle: { fill: '#b9d1df', fontSize: 10 },
      }))
    return { nodes, edges, hidden: candidates.length - shown.length + deleted.length - visibleDeleted.length +
      unindexed.length - visibleUnindexed.length,
      collapsed: filtered.length - candidates.length }
  }, [currentGraph, selectedId, kind, connectedOnly, collapseOuter, limit, showDeleted,
    index.deletedRecords, index.unindexedRecords])

  return <section aria-label="Story relationship explorer" className="story-relationships">
    <div className="story-explorer-heading">
      <div><h3>Canonical relationships</h3>
        <p className="muted">Read-only native Context Manifest links, with separate Git change overlays. Deleted nodes have no inferred links.</p>
      </div>
      <Button type="button" disabled={!selectedId} onClick={() => setRefreshToken(n => n + 1)}>
        Refresh links
      </Button>
    </div>
    <div className="story-graph-filters">
      <label>Neighborhood <NativeSelect value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
        <option value="focused">Focused</option><option value="related">Related</option>
      </NativeSelect></label>
      <label>Record type <NativeSelect value={kind} onChange={e => setKind(e.target.value)}>
        <option value="all">All types</option>
        {kinds.map(type => <option key={type} value={type}>{type}</option>)}
      </NativeSelect></label>
      <label>Visible records <NativeSelect value={limit} onChange={e => setLimit(Number(e.target.value))}>
        {limits.map(n => <option key={n} value={n}>{n}</option>)}
      </NativeSelect></label>
      <label className="story-graph-checkbox"><Checkbox checked={connectedOnly}
        onCheckedChange={checked => setConnectedOnly(checked)} /> Only connected</label>
      <label className="story-graph-checkbox"><Checkbox checked={collapseOuter}
        onCheckedChange={checked => setCollapseOuter(checked)} /> Collapse outer layers</label>
      <label className="story-graph-checkbox"><Checkbox checked={showDeleted}
        onCheckedChange={checked => setShowDeleted(checked)} /> Git placeholders</label>
    </div>
    {!selectedId ? (view.nodes.length > 0 ? <>
      <p role="status" className="muted">No current typed records. {view.nodes.length} Git-only placeholders
        {view.hidden > 0 ? ' · ' + view.hidden + ' hidden by the record limit' : ''}; no native links.</p>
      <div className="story-graph-canvas" aria-label="Read-only Git-only Story placeholders">
        <ReactFlow nodes={view.nodes} edges={[]} fitView fitViewOptions={{ padding: 0.3 }}
          nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
          colorMode="dark" deleteKeyCode={null} proOptions={{ hideAttribution: true }}>
          <Background gap={22} color="#344657" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </> : <p>Select a record in the tree to inspect its native links.</p>) :
      error ? <p role="alert" className="error">{error}</p> :
        !currentGraph ? <p role="status">Loading native relationships…</p> : <>
          <p className="muted" role="status">{view.nodes.length} visible records, {view.edges.length} visible native links
            {view.hidden > 0 ? ' · ' + view.hidden + ' hidden by the record limit' : ''}
            {view.collapsed > 0 ? ' · ' + view.collapsed + ' outer records collapsed' : ''}
            {' · '}{currentGraph.records.length} in the bounded native manifest (maximum {currentGraph.maxFiles}).
          </p>
          <div className="story-graph-canvas" aria-label="Interactive read-only Story relationship graph">
            <ReactFlow key={selectedId + scope + kind + limit + connectedOnly + collapseOuter + showDeleted}
              nodes={view.nodes} edges={view.edges} fitView fitViewOptions={{ padding: 0.3 }}
              colorMode="dark" nodesDraggable={false} nodesConnectable={false}
              edgesReconnectable={false} deleteKeyCode={null}
              onNodeClick={(_, node) => {
                if (!node.id.startsWith('deleted:') && !node.id.startsWith('unindexed:')) onSelect(node.id)
              }}
              proOptions={{ hideAttribution: true }}>
              <Background gap={22} color="#344657" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {!currentGraph.relationships.length && <p>No typed relationship evidence in this native context.</p>}
          <details className="story-graph-link-list">
            <summary>Native link details ({view.edges.length})</summary>
            <ul>{view.edges.map(edge => <li key={edge.id}>
              <Button type="button" onClick={() => onSelect(edge.source)}>{edge.source}</Button>
              {' — '}{String(edge.data?.relationCode ?? 'native link')}{' → '}
              <Button type="button" onClick={() => onSelect(edge.target)}>{edge.target}</Button>
            </li>)}</ul>
          </details>
        </>}
  </section>
}
