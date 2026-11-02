import { useEffect, useState } from 'react'

type Approval = {
  id: string; nonce: string; proposalSha256: string; verifiedHead: string
  phase: 'awaiting-controller' | 'recorded'; review: unknown
  decision?: 'approved' | 'rejected'; principal?: string
}
type Item = {
  id: string; kind: 'question' | 'approval'
  phase: 'queued' | 'awaiting-author' | 'applied' | 'review-required'
  prompt: string; answer?: string | null
  requestType?: 'plan' | 'decision'; workItemId?: string | null
  proposalSha256?: string; changeId?: string | null
  approval: Approval | null
}
type AuthorState = { status: string; items: Item[] }

export function AuthorInteractions({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const [state, setState] = useState<AuthorState | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const url = '/api/jobs/' + encodeURIComponent(jobId) + '/author'
  const refresh = async () => {
    const response = await fetch(url, { cache: 'no-store' })
    const data = await response.json() as AuthorState & { error?: string }
    if (!response.ok) throw new Error(data.error || 'Author prompts unavailable')
    setState(data)
  }
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        const data = await response.json() as AuthorState
        if (active && response.ok) { setState(data); setError(null) }
        else if (active) setError('Unable to inspect saved author questions.')
      } catch { if (active) setError('Unable to inspect saved author questions.') }
    }
    void poll()
    const timer = setInterval(() => void poll(), 8000)
    return () => { active = false; clearInterval(timer) }
  }, [url])
  const send = async (id: string, payload: Record<string, unknown>) => {
    setBusy(id); setError(null)
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, messageId: id }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'The saved response could not be recorded')
      await refresh()
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Author response failed') }
    finally { setBusy(null) }
  }
  const sendIdea = async () => {
    const original = idea.trim()
    if (!original) return
    setBusy('new-idea'); setError(null)
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send', message: {
          kind: 'idea', payload: { kind: 'event-concept',
            source: { kind: 'author-continuation', reference: 'Studio author message' },
            original, requirements: { meaning: [{ text: original, binding: false }], wording: [], participants: [] },
            identities: { known: [], unresolved: [] }, prerequisites: [],
            placement: { scopeIds: [], flexible: true, earliest: 'event' }, upstreamConstraints: [],
          },
        } }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Unable to queue author idea')
      setIdea(''); setNotice('Idea queued for the next safe work boundary.'); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to queue author idea') }
    finally { setBusy(null) }
  }
  const items = state?.items.filter(item => item.phase === 'awaiting-author' || item.approval?.phase === 'recorded') ?? []
  return <section aria-label="Author questions and approvals">
    <h2>Author questions and approvals</h2>
    <label htmlFor="author-new-idea">Send an idea to this job</label>
    <textarea id="author-new-idea" rows={3} maxLength={2500} value={idea}
      onChange={e => setIdea(e.target.value)} disabled={busy !== null}
      placeholder="New narrative idea or constraint for the next safe work boundary" />
    <button type="button" onClick={() => void sendIdea()} disabled={busy !== null || !idea.trim()}>
      Save idea for next safe boundary
    </button>
    <p className="muted">Responses are bound to this job's saved graph interrupt.
      Protected changes require reviewing the exact proposal and confirming the trusted approval.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!state && !error && <p>Checking saved author interrupts…</p>}
    {state && items.length === 0 && <p>No author responses are awaiting review.</p>}
    {items.map(item => <article key={item.id}>
      <h3>{item.kind === 'question' ? 'Author question' : 'Protected approval'}: <code>{item.id}</code></h3>
      {item.kind === 'question' ? <>
        <p>{item.prompt}</p>
        {item.phase === 'applied' ? <p>Answered: {item.answer}</p> : <>
          <label htmlFor={'author-answer-' + item.id}>Your answer</label>
          <textarea id={'author-answer-' + item.id} value={answers[item.id] ?? ''}
            maxLength={4000} rows={3} disabled={busy !== null}
            onChange={e => setAnswers(previous => ({ ...previous, [item.id]: e.target.value }))} />
          <button type="button" disabled={busy !== null || !(answers[item.id] ?? '').trim()}
            onClick={() => void send(item.id, { action: 'answer', answer: answers[item.id] })}>Submit answer</button>
        </>}
      </> : <>
        <p>Proposal type: {item.requestType}. {item.workItemId && <>Work item: <code>{item.workItemId}</code>. </>}</p>
        <p>Proposal digest: <code>{item.proposalSha256}</code></p>
        {item.changeId && <p>Change digest: <code>{item.changeId}</code></p>}
        {!item.approval ? <button type="button" disabled={busy !== null}
          onClick={() => void send(item.id, { action: 'prepare' })}>Inspect exact proposal</button> : <>
          <p>Verified Git HEAD: <code>{item.approval.verifiedHead}</code></p>
          <details open={item.approval.phase === 'awaiting-controller'}>
            <summary>Exact proposed change and review</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(item.approval.review, null, 2)}</pre>
          </details>
          {item.approval.phase === 'recorded'
            ? <p role="status">Decision recorded: {item.approval.decision}.
              {item.approval.decision === 'rejected' && ' Revision not authorized; further review is required.'}</p>
            : <>
              <p>Confirm only after reviewing this exact proposed content and Git baseline.
                This decision cannot be transferred to another proposal.</p>
              <button type="button" disabled={busy !== null} onClick={() => void send(item.id, {
                action: 'decide', receiptId: item.approval!.id, nonce: item.approval!.nonce,
                proposalSha256: item.approval!.proposalSha256, decision: 'approved',
              })}>Approve and resume</button>{' '}
              <button type="button" disabled={busy !== null} onClick={() => void send(item.id, {
                action: 'decide', receiptId: item.approval!.id, nonce: item.approval!.nonce,
                proposalSha256: item.approval!.proposalSha256, decision: 'rejected',
              })}>Reject proposal</button>
            </>}
        </>}
      </>}
    </article>)}
  </section>
}
