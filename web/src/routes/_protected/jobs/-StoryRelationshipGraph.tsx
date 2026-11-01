import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ExplorerGraph, ExplorerIndex } from '../../../lib/story-explorer.server'

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
  const [graph, setGraph] = useState<ExplorerGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState('all')
  const [limit, setLimit] = useState<number>(16)
  const [connectedOnly, setConnectedOnly] = useState(false)
  const [collapseOuter, setCollapseOuter] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => { setKind('all') }, [selectedId])

  useEffect(() => {
    setGraph(null); setError(null)
    if (!selectedId) return
    const controller = new AbortController()
    const url = '/api/jobs/' + encodeURIComponent(jobId) + '/relationships?' +
      new URLSearchParams({ id: selectedId, scope })
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const payload = await response.json() as { graph?: ExplorerGraph; error?: string }
      if (!response.ok || !payload.graph) throw new Error(payload.error || 'Unable to load native relationships.')
      if (payload.graph.headSha !== index.headSha || payload.graph.selectedId !== selectedId)
        throw new Error('Story revision changed. Revalidate the explorer.')
      return payload.graph
    }).then(setGraph).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load relationships.')
    })
    return () => controller.abort()
  }, [jobId, index.headSha, selectedId, scope, refreshToken])

  const currentGraph = graph?.selectedId === selectedId && graph.headSha === index.headSha &&
    graph.scope === scope ? graph : null
  const kinds = useMemo(() => [...new Set(currentGraph?.records.map(r => r.type) ?? [])].sort(), [currentGraph])
  const view = useMemo(() => {
    if (!currentGraph || !selectedId) return { nodes: [] as Node[], edges: [] as Edge[], hidden: 0, collapsed: 0 }
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
        data: { label: record.title + ' · ' + record.type },
        selected: record.id === selectedId,
        style: { width: 205, background: record.id === selectedId ? '#244e65' : '#263847',
          border: record.id === selectedId ? '2px solid #86c9ed' : '1px solid #60788b',
          borderRadius: 7, color: '#e4e9ef', fontSize: 12, padding: 7 },
      }
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
    return { nodes, edges, hidden: candidates.length - shown.length,
      collapsed: filtered.length - candidates.length }
  }, [currentGraph, selectedId, kind, connectedOnly, collapseOuter, limit])

  return <section aria-label="Story relationship explorer" className="story-relationships">
    <div className="story-explorer-heading">
      <div><h3>Canonical relationships</h3>
        <p className="muted">Read-only native Context Manifest links. Select a node to open its Story record.</p>
      </div>
      <button type="button" disabled={!selectedId} onClick={() => setRefreshToken(n => n + 1)}>
        Refresh links
      </button>
    </div>
    <div className="story-graph-filters">
      <label>Neighborhood <select value={scope} onChange={e => setScope(e.target.value as typeof scope)}>
        <option value="focused">Focused</option><option value="related">Related</option>
      </select></label>
      <label>Record type <select value={kind} onChange={e => setKind(e.target.value)}>
        <option value="all">All types</option>
        {kinds.map(type => <option key={type} value={type}>{type}</option>)}
      </select></label>
      <label>Visible records <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
        {limits.map(n => <option key={n} value={n}>{n}</option>)}
      </select></label>
      <label className="story-graph-checkbox"><input type="checkbox" checked={connectedOnly}
        onChange={e => setConnectedOnly(e.target.checked)} /> Only connected</label>
      <label className="story-graph-checkbox"><input type="checkbox" checked={collapseOuter}
        onChange={e => setCollapseOuter(e.target.checked)} /> Collapse outer layers</label>
    </div>
    {!selectedId ? <p>Select a record in the tree to inspect its native links.</p> :
      error ? <p role="alert" className="error">{error}</p> :
        !currentGraph ? <p role="status">Loading native relationships…</p> : <>
          <p className="muted" role="status">{view.nodes.length} visible records, {view.edges.length} visible native links
            {view.hidden > 0 ? ' · ' + view.hidden + ' hidden by the record limit' : ''}
            {view.collapsed > 0 ? ' · ' + view.collapsed + ' outer records collapsed' : ''}
            {' · '}{currentGraph.records.length} in the bounded native manifest (maximum {currentGraph.maxFiles}).
          </p>
          <div className="story-graph-canvas" aria-label="Interactive read-only Story relationship graph">
            <ReactFlow key={selectedId + scope + kind + limit + connectedOnly + collapseOuter}
              nodes={view.nodes} edges={view.edges} fitView fitViewOptions={{ padding: 0.3 }}
              colorMode="dark" nodesDraggable={false} nodesConnectable={false}
              edgesReconnectable={false} deleteKeyCode={null}
              onNodeClick={(_, node) => onSelect(node.id)} proOptions={{ hideAttribution: true }}>
              <Background gap={22} color="#344657" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {!currentGraph.relationships.length && <p>No typed relationship evidence in this native context.</p>}
          <details className="story-graph-link-list">
            <summary>Native link details ({view.edges.length})</summary>
            <ul>{view.edges.map(edge => <li key={edge.id}>
              <button type="button" onClick={() => onSelect(edge.source)}>{edge.source}</button>
              {' — '}{String(edge.data?.relationCode ?? 'native link')}{' → '}
              <button type="button" onClick={() => onSelect(edge.target)}>{edge.target}</button>
            </li>)}</ul>
          </details>
        </>}
  </section>
}
