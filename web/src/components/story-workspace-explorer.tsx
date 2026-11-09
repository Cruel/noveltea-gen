import { useQuery } from '@tanstack/react-query'
import { readWorkspaceStoryRecord } from '@/lib/story-data.functions'
import type { ExplorerIndex } from '@/lib/story-explorer.server'
import { StoryChangeLabels } from '@/routes/_protected/jobs/-StoryChangeLabels'

/** The inspector always reads the exact selected Thread's verified revision. */
export function StoryWorkspaceInspector({ storyId, threadId, index, selectedId, onSelect }: {
  storyId: string; threadId: string; index: ExplorerIndex
  selectedId: string | null; onSelect: (id: string) => void
}) {
  const record = useQuery({
    queryKey: ['workspace-record', storyId, threadId, index.headSha, selectedId],
    queryFn: () => readWorkspaceStoryRecord({ data: { storyId, threadId, recordId: selectedId! } }),
    enabled: !!selectedId,
  })
  const loaded = record.data?.headSha === index.headSha && record.data.record.id === selectedId
    ? record.data : null
  const diagnostics = index.diagnostics.filter(d => d.path === loaded?.record.path)
  return <section aria-label="Canonical record inspector" className="min-w-0 space-y-2 rounded-md border border-border/50 p-3 text-sm">
    <h3 className="m-0 text-sm font-semibold">Record inspector</h3>
    {!selectedId ? <p className="m-0 text-muted-foreground">Select a canonical record in Outline or Graph.</p>
      : record.error ? <p role="alert" className="text-destructive">{record.error.message}</p>
      : !loaded ? <p role="status" className="text-muted-foreground">Loading verified record…</p>
      : <>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <strong>{loaded.record.title}</strong><StoryChangeLabels change={loaded.record.change} />
        </div>
        <p className="m-0 break-all text-xs text-muted-foreground">{loaded.record.id} · {loaded.record.path} · {loaded.record.status}</p>
        <pre aria-label="Canonical record Markdown"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">{loaded.markdown}</pre>
        {diagnostics.length > 0 && <div role="status" className="space-y-1 text-xs">
          <h4 className="font-semibold">Record diagnostics</h4>
          {diagnostics.map((d, i) => <p key={i}>
            {d.code} (line {d.line ?? '?'}) — {d.message}
          </p>)}
        </div>}
      </>}
    {index.diagnostics.some(d => !index.records.some(r => r.path === d.path)) &&
      <details><summary className="cursor-pointer text-xs">Story-level diagnostics</summary>
        {index.diagnostics.filter(d => !index.records.some(r => r.path === d.path))
          .map((d, i) => <p key={i} className="text-xs">{d.code}: {d.message}</p>)}
      </details>}
    {index.diagnostics.some(d => index.records.some(r => r.path === d.path && r.id !== selectedId)) &&
      <details><summary className="cursor-pointer text-xs">Other record diagnostics</summary>
        {index.diagnostics.filter(d => index.records.some(r => r.path === d.path && r.id !== selectedId))
          .map((d, i) => <p key={i} className="text-xs">
            <button className="underline" onClick={() => {
              const item = index.records.find(r => r.path === d.path)
              if (item) onSelect(item.id)
            }}>{d.path}</button> {d.code}: {d.message}
          </p>)}
      </details>}
  </section>
}
