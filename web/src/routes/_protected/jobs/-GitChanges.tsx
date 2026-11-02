import { useEffect, useState } from 'react'

type Changes = { headSha: string; files: string[] }
type Diff = { file: string; headSha: string; diff: string }
const endpoint = (jobId: string) => '/api/jobs/' + encodeURIComponent(jobId) + '/changes'

export function GitChanges({ jobId, revision }: { jobId: string; revision: string }) {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setChanges(null); setSelected(null); setError(null)
    void fetch(endpoint(jobId), { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as Changes & { error?: string }
        if (!response.ok) throw new Error(body.error || 'Could not inspect verified Git changes')
        return body
      }).then(value => { if (!controller.signal.aborted) setChanges(value) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Git changes unavailable') })
    return () => controller.abort()
  }, [jobId, revision, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDiff(null)
    if (!selected || !changes) return () => controller.abort()
    void fetch(endpoint(jobId) + '?file=' + encodeURIComponent(selected), {
      cache: 'no-store', signal: controller.signal,
    }).then(async response => {
      const body = await response.json() as Diff & { error?: string }
      if (!response.ok) throw new Error(body.error || 'Diff unavailable')
      return body
    }).then(value => {
      if (!controller.signal.aborted && value.headSha === changes.headSha) setDiff(value)
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Diff unavailable') })
    return () => controller.abort()
  }, [jobId, changes, selected])
  return <section aria-label="Verified Git changes">
    <h2>Verified Git changes</h2>
    <p className="muted">Separate from generation status. Read-only comparison of pinned base and verified Story HEAD.</p>
    <button type="button" onClick={() => setRefresh(n => n + 1)}>Refresh changes</button>
    {error && <p role="alert" className="error">{error}</p>}
    {!changes && !error && <p>Loading verified commits…</p>}
    {changes && <>{!changes.files.length ? <p>No committed Story Markdown changes.</p> :
      <ul>{changes.files.map(file => <li key={file}>
        <button type="button" onClick={() => setSelected(file)}
          aria-pressed={selected === file}>{file}</button>
      </li>)}</ul>}
      {selected && <div aria-label="Git diff for selected Story file">
        <h3>{selected}</h3>
        {diff?.file === selected ? <pre className="story-markdown">{diff.diff}</pre> : <p>Loading diff…</p>}
      </div>}
    </>}
  </section>
}
