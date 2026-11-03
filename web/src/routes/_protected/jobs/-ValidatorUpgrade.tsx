import { useEffect, useState } from 'react'

type ValidatorProposal = {
  version: number; proposalSha256: string; headSha: string
  previous: { executable: string; sha256: string }
  replacement: { executable: string; sha256: string }
  validationDigest: string; diagnostics: number
}
type Review = { phase: 'review-required' | 'approved' | 'committed' | 'unchanged'
  proposal: ValidatorProposal | null; error?: string }

/** Explicit trust-boundary review. Changes a job-local validator pin, never
 * the Story, model selection, protected decisions, or generation checkpoint. */
export function ValidatorUpgrade({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const url = '/api/jobs/' + encodeURIComponent(jobId) + '/validator-upgrade'
  const [review, setReview] = useState<Review | null>(null)
  const [rationale, setRationale] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void fetch(url, { cache: 'no-store' })
      .then(async response => {
        const data = await response.json() as Review
        if (!response.ok) throw Error(data.error || 'Validator review unavailable')
        if (active) { setReview(data); setError(null) }
      }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Review unavailable') })
    return () => { active = false }
  }, [url])
  const approve = async () => {
    if (!review?.proposal) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(url, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', proposalSha256: review.proposal.proposalSha256,
          rationale }),
      })
      const value = await response.json() as Review
      if (!response.ok) throw Error(value.error || 'Validator upgrade refused')
      setReview(value)
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Validator upgrade refused') }
    finally { setBusy(false) }
  }
  if (!review?.proposal) return null
  const p = review.proposal
  return <section aria-label="Native validator upgrade review">
    <h2>Native validator upgrade review</h2>
    {error && <p role="alert">{error}</p>}
    <p>The job's original native validator is no longer the one installed in Studio.
      The replacement successfully validated this <strong>unchanged, clean Story</strong>
      with zero diagnostics and protected-decision checks. It has not yet been
      demonstrated equivalent to the original executable.</p>
    <p><strong>Original validator SHA-256:</strong> <code>{p.previous.sha256}</code>
      {' · '}<code>{p.previous.executable}</code></p>
    <p><strong>Installed replacement SHA-256:</strong> <code>{p.replacement.sha256}</code></p>
    <p><strong>Replacement path:</strong> <code>{p.replacement.executable}</code></p>
    <p><strong>Reviewed Git HEAD:</strong> <code>{p.headSha}</code></p>
    <p><strong>Validation:</strong> passed, {p.diagnostics} diagnostics ·
      protection checked · preflight digest <code>{p.validationDigest.slice(0, 16)}</code></p>
    {review.phase === 'committed' ? <p role="status">This replacement has been
      explicitly authorized and pinned. You can now use Resume, which will still
      check the saved generation state and protected constraints.</p>
      : <><p><strong>This changes the validator trusted for future work in this job.</strong>
        It does not modify Story records, revoke previous author decisions or
        run the generation process. The original pin and approval are retained
        as a durable audit receipt.</p>
        <label>Reason for accepting the replacement
          <textarea rows={3} maxLength={1000} value={rationale}
            disabled={busy} onChange={e => setRationale(e.target.value)}
            placeholder="I authorize this exact validated replacement for this disposable test job." />
        </label>
        <button type="button" disabled={busy || rationale.trim().length < 12}
          onClick={() => void approve()}>
          {busy ? 'Verifying…' : review.phase === 'approved'
            ? 'Finish previously approved validator upgrade' : 'Approve validator replacement'}
        </button>
      </>}
  </section>
}
