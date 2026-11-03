import { useEffect, useState } from 'react'

type FoundationConflict = {
  digest: string; explanation: string; headSha: string; requestSha256: string
  sourceExcerpt: string
  status: 'awaiting-author' | 'authorized' | 'rejected'; retryUsed?: boolean
  authorization?: { reason: string }
}
type Reply = { conflict: FoundationConflict | null; error?: string }

export function FoundationReview({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const url = '/api/jobs/' + encodeURIComponent(jobId) + '/foundation-review'
  const [conflict, setConflict] = useState<FoundationConflict | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const check = async () => {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        const data = await response.json() as Reply
        if (!response.ok) throw Error(data.error || 'Foundation review unavailable')
        if (live) setConflict(data.conflict)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Foundation review unavailable')
      }
    }
    void check()
    const poll = setInterval(() => void check(), 8000)
    return () => { live = false; clearInterval(poll) }
  }, [url])
  const decide = async (action: 'prepare' | 'approve' | 'reject') => {
    setBusy(true); setError(null)
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'prepare' ? { action }
          : { action, digest: conflict?.digest, reason }),
      })
      const data = await response.json() as Reply
      if (!response.ok || !data.conflict) throw Error(data.error || 'Foundation review failed')
      setConflict(data.conflict)
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Foundation review failed') }
    finally { setBusy(false) }
  }
  if (!conflict && !error) return null
  return <section aria-label="Foundation author authorization">
    <h2>Foundation author authorization</h2>
    {error && <p role="alert" className="error">{error}</p>}
    {conflict && <>
      <p><strong>No Story files were changed.</strong> The completed Foundation specialist
        requested clarification about existing user-protected constraints. This
        request is tied to the pinned job, original model session and Git revision.</p>
      <p><strong>Specialist explanation:</strong> {conflict.explanation}</p>
      <details>
        <summary>Review original Creative Direction source (bound to pinned Git HEAD)</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {conflict.sourceExcerpt}
        </pre>
      </details>
      <p><small>Git HEAD: <code>{conflict.headSha.slice(0, 12)}</code>
        {' · '}Authorization digest: <code>{conflict.digest.slice(0, 16)}</code></small></p>
      {conflict.status === 'awaiting-author' ? <>
        <p><strong>Authorize a job-scoped exception</strong> only if you want this exact
          generation task to proceed despite the protected discovery/preflight
          restriction. The protected record remains unchanged. This is not
          authorization to edit, delete or weaken that record's decisions.</p>
        <label>Reason for your decision
          <textarea rows={3} maxLength={1000} value={reason} disabled={busy}
            onChange={event => setReason(event.target.value)}
            placeholder="I authorize full composition for this disposable test job while retaining the protected record." />
        </label>
        <div className="generation-actions">
          <button type="button" disabled={busy || reason.trim().length < 12}
            onClick={() => void decide('approve')}>Authorize exception</button>
          <button type="button" disabled={busy || reason.trim().length < 12}
            onClick={() => void decide('reject')}>Reject and leave blocked</button>
        </div>
      </> : <p role="status">{conflict.status === 'authorized'
        ? conflict.retryUsed
          ? 'The one-time authorized retry has been used. Inspect the resulting job state.'
          : 'Authorization recorded. Use Resume in Execution controls to request one verified retry.'
        : 'Request rejected. The Story remains unchanged and this job cannot resume through this exception.'}</p>}
    </>}
  </section>
}
