import { useEffect, useState } from 'react'

export type PiModel = { provider: string; id: string; thinking?: 'low' | 'medium' | 'high' }
export type PiFoundation = {
  id: string; title: string; premise: string; central_conflict: string
  genre: string; tone: string; player_experience: string; scope: string; body: string
  decisions: Array<{id: string; statement: string; origin: 'user' | 'agent'; authority: 'delegated' | 'user-protected'}>
}
export type PiProposal = { foundation: PiFoundation; task: string; contract: {
  scope: { kind: 'full-story'; depth: 'composition'; targets: string[]; branches: string[] }
  constraints: string[]; envelope: { presentation: string; hardLimits: string[]; preferences: string[] }
} }
export type PiApproval = { revision: number; digest: string }
type Turn = { role: 'user' | 'assistant'; text: string }
type Session = { phase: 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'; revision: number
  model: PiModel; turns: Turn[]; questions: string | null; proposal: PiProposal | null; digest: string | null
  skillId: string; startedAt: number | null }
async function call<T>(url: string, data?: unknown): Promise<T> {
  const response = await fetch(url, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(result.error || 'Pi discovery request failed')
  return result
}
export function PiStoryDiscovery({ repositoryId, workspace, initialBrief, onApproved }: {
  repositoryId: string; workspace: string; initialBrief: string
  onApproved: (proposal: PiProposal, reference: PiApproval, model: PiModel) => void
}) {
  const url = '/api/onboarding/pi?' + new URLSearchParams({ repositoryId, workspace })
  const [session, setSession] = useState<Session | null>(null)
  const [models, setModels] = useState<Array<{ provider: string; id: string; reasoning: boolean }>>([])
  const [selection, setSelection] = useState('')
  const [thinking, setThinking] = useState<'low' | 'medium' | 'high' | ''>('')
  const [brief, setBrief] = useState(initialBrief)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let valid = true
    setSession(null); setBrief(initialBrief); setError(null)
    void Promise.all([
      call<{session: Session | null}>(url),
      call<{ models: typeof models }>('/api/pi/models'),
    ]).then(([record, catalog]) => {
      if (!valid) return
      setSession(record.session); setModels(catalog.models)
      if (record.session?.phase === 'approved' && record.session.proposal && record.session.digest)
        onApproved(record.session.proposal, {
          revision: record.session.revision, digest: record.session.digest,
        }, record.session.model)
    }).catch(e => { if (valid) setError(e instanceof Error ? e.message : 'Could not load Pi discovery') })
    return () => { valid = false }
  }, [repositoryId, workspace])
  const perform = async (input: unknown) => {
    setBusy(true); setError(null)
    try {
      const result = await call<{session: Session}>(url, input)
      setSession(result.session); setAnswer('')
      if (result.session.phase === 'approved' && result.session.proposal && result.session.digest)
        onApproved(result.session.proposal, {
          revision: result.session.revision, digest: result.session.digest,
        }, result.session.model)
    } catch (e) { setError(e instanceof Error ? e.message : 'Pi discovery failed') }
    finally { setBusy(false) }
  }
  const selected = models.find(m => m.provider + '/' + m.id === selection)
  return <section aria-label="Pi collaborative discovery" className="story-onboarding">
    <h3>Collaborative discovery with nt-story-discovery</h3>
    <p>Pi asks adaptive creative questions based on your brief, offers recommendations,
      and only proposes a foundation after your decisions are settled. No Story file
      is written until you review and explicitly approve the result.</p>
    {!session && <>
      <label>Starting brief (your structured answers may be included)
        <textarea rows={5} maxLength={4000} disabled={busy} value={brief}
          onChange={e => setBrief(e.target.value)} placeholder="A one-sentence premise is enough." />
      </label>
      <label>Connected Pi model
        <select value={selection} disabled={busy} onChange={e => { setSelection(e.target.value); setThinking('') }}>
          <option value="">Select model</option>
          {models.map(m => <option key={m.provider + '/' + m.id} value={m.provider + '/' + m.id}>
            {m.provider} / {m.id}</option>)}
        </select>
      </label>
      {selected?.reasoning && <label>Reasoning effort
        <select value={thinking} disabled={busy} onChange={e => setThinking(e.target.value as typeof thinking)}>
          <option value="">Default</option>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
      </label>}
      <button type="button" disabled={busy || !brief.trim() || !selected}
        onClick={() => { if (selected) void perform({ action: 'start', text: brief,
          model: { provider: selected.provider, id: selected.id, ...(thinking ? {thinking} : {}) } }) }}>
        {busy ? 'Consulting Pi…' : 'Start collaborative discovery'}
      </button>
      {!models.length && <p>Connect a Pi provider in the job model settings first.</p>}
    </>}
    {session && <>
      <p>Discovery: <strong>{session.phase}</strong>. Pinned skill snapshot: <code>{session.skillId.slice(0, 12)}</code>.</p>
      {session.turns.filter(t => t.role === 'user').map((turn, i) =>
        <p key={i}><strong>Author {i + 1}:</strong> {turn.text}</p>)}
      {session.phase === 'running' && <div role="status">
        <p>A model turn was reserved. Reload to check its outcome. Do not submit another turn.
          If the server died, you can manually reconcile an interrupted turn after ten minutes.</p>
        <button type="button" disabled={busy || !session.startedAt || Date.now() - session.startedAt < 600_000}
          onClick={() => void perform({action: 'reconcile', revision: session.revision})}>
          Mark old running turn interrupted
        </button>
      </div>}
      {session.phase === 'blocked' && <div role="alert">
        <p>The model turn did not complete. Your input is preserved. A deliberate
          retry can incur another provider charge and may return a different answer.</p>
        <button type="button" disabled={busy}
          onClick={() => void perform({ action: 'retry', revision: session.revision })}>
          {busy ? 'Retrying…' : 'Explicitly retry the interrupted turn'}
        </button>
      </div>}
      {session.phase === 'questions' && <>
        <h3>Pi's current questions and recommendations</h3>
        <pre className="story-markdown">{session.questions}</pre>
        <label>Your answers (partial answers and delegation are allowed)
          <textarea rows={5} maxLength={4000} disabled={busy} value={answer}
            onChange={e => setAnswer(e.target.value)} />
        </label>
        <button type="button" disabled={busy || !answer.trim()}
          onClick={() => void perform({ action: 'answer', revision: session.revision, text: answer })}>
          {busy ? 'Consulting Pi…' : 'Send answers'}
        </button>
      </>}
      {(session.phase === 'proposed' || session.phase === 'approved') && session.proposal && <>
        <h3>Review the model-generated Creative Direction</h3>
        <p><strong>{session.proposal.foundation.title}</strong> (<code>{session.proposal.foundation.id}</code>)</p>
        <p>{session.proposal.foundation.premise}</p>
        <p><strong>Conflict:</strong> {session.proposal.foundation.central_conflict}</p>
        <p><strong>Genre/tone:</strong> {session.proposal.foundation.genre} / {session.proposal.foundation.tone}</p>
        <p><strong>Player experience:</strong> {session.proposal.foundation.player_experience}</p>
        <p><strong>Scope:</strong> {session.proposal.foundation.scope}</p>
        <pre className="story-markdown">{session.proposal.foundation.body}</pre>
        <h3>Creative decision authority</h3>
        {session.proposal.foundation.decisions.map(d => <p key={d.id}>
          <strong>{d.origin} / {d.authority}:</strong> {d.statement}</p>)}
        <p><strong>Next generation task:</strong> {session.proposal.task}</p>
        {session.phase === 'proposed'
          ? <>
            <label>Corrections or additional creative direction
              <textarea rows={4} maxLength={4000} value={answer} disabled={busy}
                onChange={e => setAnswer(e.target.value)} />
            </label>
            <div className="actions">
              <button type="button" disabled={busy || !answer.trim()}
                onClick={() => void perform({action: 'revise', revision: session.revision, text: answer})}>
                Ask Pi to revise the proposal
              </button>
              <button type="button" disabled={busy || !session.digest}
                onClick={() => void perform({action: 'approve', revision: session.revision, digest: session.digest})}>
                Approve exact foundation proposal
              </button>
            </div>
          </>
          : <p role="status">This exact proposal is approved. Initialize it on the selected Story branch below.</p>}
      </>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
