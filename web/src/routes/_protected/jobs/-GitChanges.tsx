import { Button } from '@/components/ui/button'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { readJobChanges } from '../../../lib/story-data.functions'

export function GitChanges({ jobId, revision }: { jobId: string; revision: string }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const listing = useQuery({
    queryKey: ['job-changes', jobId, revision, refresh] as const,
    queryFn: () => readJobChanges({ data: { jobId } }),
  })
  const changes = listing.data
  useEffect(() => setSelected(null), [jobId, revision])
  const detail = useQuery({
    queryKey: ['job-diff', jobId, changes?.headSha, selected] as const,
    queryFn: () => readJobChanges({ data: { jobId, file: selected! } }),
    enabled: !!selected && !!changes,
  })
  const diff = detail.data?.headSha === changes?.headSha && detail.data?.file === selected
    ? detail.data : null
  const files = changes?.files ?? []
  return <section aria-label="Verified Git changes">
    <h2>Verified Git changes</h2>
    <p className="muted">Separate from generation status. Read-only comparison of pinned base and verified Story HEAD.</p>
    <Button variant="outline" type="button" onClick={() => setRefresh(n => n + 1)}>Refresh changes</Button>
    {listing.error && <p role="alert" className="error">{listing.error.message}</p>}
    {detail.error && <p role="alert" className="error">{detail.error.message}</p>}
    {!changes && !listing.error && <p>Loading verified commits…</p>}
    {changes && <>{!files.length ? <p>No committed Story Markdown changes.</p> :
      <ul>{files.map(file => <li key={file}>
        <Button variant={selected === file ? 'secondary' : 'ghost'} type="button"
          onClick={() => setSelected(file)} aria-pressed={selected === file}>{file}</Button>
      </li>)}</ul>}
      {selected && <div aria-label="Git diff for selected Story file">
        <h3>{selected}</h3>
        {diff ? <pre className="story-markdown">{diff.diff}</pre> : <p>Loading diff…</p>}
      </div>}
    </>}
  </section>
}
