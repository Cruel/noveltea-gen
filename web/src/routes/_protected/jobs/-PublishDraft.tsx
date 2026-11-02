import { useState } from 'react'

type Preview = {
  headSha: string; baseSha: string; branch: string; targetBranch: string; targetSha: string
  validation: string; protection: string; merge: string; blockers: string[]
  canPublish: boolean; diagnostics: unknown[]
  linked: { number: number; url: string; headSha: string; targetBranch: string } | null
}
export function PublishDraft({ jobId, provider }: { jobId: string; provider: 'github' | 'gitlab' }) {
  const isGitlab = provider === 'gitlab'
  const service = isGitlab ? 'GitLab' : 'GitHub'
  const review = isGitlab ? 'MR' : 'PR'
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchPreview = async () => {
    setBusy(true); setError(null); setConfirmed(false)
    try {
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/publish', { cache: 'no-store' })
      const result = await response.json() as { publication?: Preview; error?: string }
      if (!response.ok || !result.publication) throw new Error(result.error || 'Publication preview unavailable')
      setPreview(result.publication)
    } catch (err) { setPreview(null); setError(err instanceof Error ? err.message : 'Preview failed') }
    finally { setBusy(false) }
  }
  const publish = async () => {
    if (!preview) return
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ headSha: preview.headSha, targetSha: preview.targetSha,
          allowPartial: confirmed }),
      })
      const result = await response.json() as { publication?: Preview; error?: string }
      if (!response.ok || !result.publication) throw new Error(result.error || 'Draft ' + review + ' publication failed')
      setPreview(result.publication)
      setConfirmed(false)
    } catch (err) {
      // A push or PR creation may have completed before a transport failure.
      // Require a fresh server-side preview instead of blind replay.
      setPreview(null)
      setConfirmed(false)
      setError((err instanceof Error ? err.message : 'Publication failed') +
        ' Refresh the preview to reconcile any remotely published branch or review request.')
    } finally { setBusy(false) }
  }
  return <section aria-label={'Draft ' + service + ' ' + review}>
    <h2>Draft {service} {isGitlab ? 'merge request' : 'pull request'}</h2>
    <p>Review the pinned job against current upstream before pushing. Publication never merges,
      rebases or writes the default branch; incomplete work may be published for review as a draft.</p>
    <button type="button" disabled={busy} onClick={() => void fetchPreview()}>
      {busy ? 'Checking…' : 'Preview validation and upstream'}
    </button>
    {error && <p role="alert" className="error">{error}</p>}
    {preview && <div>
      <p><strong>Job branch:</strong> <code>{preview.branch}</code></p>
      <p><strong>Target:</strong> <code>{preview.targetBranch}</code> at <code>{preview.targetSha}</code></p>
      <p><strong>Verified HEAD:</strong> <code>{preview.headSha}</code></p>
      <p><strong>Canonical validation:</strong> {preview.validation} ·
        <strong> Protected decisions:</strong> {preview.protection} ·
        <strong> Git merge:</strong> {preview.merge}</p>
      {preview.diagnostics.length > 0 && <details>
        <summary>Canonical validator diagnostics ({preview.diagnostics.length})</summary>
        <pre>{JSON.stringify(preview.diagnostics, null, 2)}</pre>
      </details>}
      <h3>Review obligations and blockers</h3>
      {preview.blockers.length
        ? <ul>{preview.blockers.map(b => <li key={b}>{b}</li>)}</ul>
        : <p>No reported blockers; a draft {review} still requires human review.</p>}
      {preview.linked && <p>Linked draft {review}: <a href={preview.linked.url}
        target="_blank" rel="noopener noreferrer">#{preview.linked.number}</a>
        {' · '}Last published HEAD: <code>{preview.linked.headSha}</code></p>}
      {preview.canPublish && preview.blockers.length > 0 && <label>
        <input type="checkbox" checked={confirmed} disabled={busy}
          onChange={event => setConfirmed(event.target.checked)} />
        I reviewed these blockers and want to publish an incomplete draft for human review.
      </label>}
      <div className="generation-actions">
        <button type="button" disabled={busy || !preview.canPublish ||
          (preview.blockers.length > 0 && !confirmed)}
          onClick={() => void publish()}>
          {preview.linked ? 'Update existing draft ' + review : 'Push branch and create draft ' + review}
        </button>
      </div>
    </div>}
  </section>
}
