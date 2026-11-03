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
type RecoveryDecision = {
  id: 'foundation-conflict' | 'validator-upgrade'
  title: string; description: string; proposalSha256: string; verifiedHead: string
  phase: 'awaiting-author' | 'applying' | 'recorded'
  decision?: 'approved' | 'rejected'; note?: string
  details: { sourceExcerpt: string; explanation: string } | {
    original: { executable: string; sha256: string }
    replacement: { executable: string; sha256: string }
    validationDigest: string; diagnostics: number
  }
}
type SpecialistChoice = {
  id: string; workItem: string; phase: 'awaiting-author' | 'answered'
  proposalSha256: string
  question: { question: string; recommendedId: string; recommendationReason: string;
    options: Array<{ id: string; title: string; approach: string;
      benefits: string; tradeoffs: string }> }
  answer?: { kind: 'option' | 'custom'; optionId?: string; text?: string; note: string }
}
type AuthorState = { status: string; items: Item[]; decisions: RecoveryDecision[];
  choice: SpecialistChoice | null }

export function AuthorInteractions({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const [state, setState] = useState<AuthorState | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})
  const [choiceSelections, setChoiceSelections] = useState<Record<string, string>>({})
  const [choiceNotes, setChoiceNotes] = useState<Record<string, string>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
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
  const submitChoice = async (item: SpecialistChoice) => {
    const selected = choiceSelections[item.id] ?? item.question.recommendedId
    const custom = selected === '__custom__'
    const text = (customAnswers[item.id] ?? '').trim()
    if (custom && !text) return
    setBusy(item.id); setError(null)
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'choice', id: item.id,
          proposalSha256: item.proposalSha256, kind: custom ? 'custom' : 'option',
          ...(custom ? { text } : { optionId: selected }),
          ...(choiceNotes[item.id]?.trim() ? { note: choiceNotes[item.id]?.trim() ?? '' } : {}) }),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error || 'Author choice was not accepted')
      await refresh()
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Author choice was not accepted') }
    finally { setBusy(null) }
  }
  const decideRecovery = async (item: RecoveryDecision, decision: 'approved' | 'rejected') => {
    const note = item.phase === 'applying' ? item.note ?? '' : decisionNotes[item.id] ?? ''
    setBusy(item.id); setError(null)
    try {
      const response = await fetch(url, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'decision', id: item.id,
          proposalSha256: item.proposalSha256, decision, ...(note.trim() ? { note } : {}) }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error || 'Unable to record author decision')
      await refresh()
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to record author decision') }
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
    {state && items.length === 0 && (state.decisions ?? []).length === 0 && !state.choice && <p>No author responses are awaiting review.</p>}
    {state?.choice && <article aria-label="Specialist creative choice" key={state.choice.id}>
      <h3>Creative decision needed · <code>{state.choice.workItem}</code></h3>
      <p>{state.choice.question.question}</p>
      {state.choice.phase === 'answered' ? <p role="status">Your choice is saved.
        Select Resume in Execution controls to continue the original specialist.
        The answer does not itself authorize changing protected creative decisions.</p> : <>
        <fieldset disabled={busy !== null}>
          <legend>Choose an approach or provide your own</legend>
          {state.choice.question.options.map(option => <label key={option.id}
            style={{ display: 'block', marginBottom: '1rem' }}>
            <input type="radio" name={'specialist-choice-' + state.choice!.id}
              value={option.id}
              checked={(choiceSelections[state.choice!.id] ?? state.choice!.question.recommendedId) === option.id}
              onChange={() => setChoiceSelections(old => ({ ...old, [state.choice!.id]: option.id }))}/>
            {' '}<strong>{option.title}</strong>
            {option.id === state.choice!.question.recommendedId &&
              <strong> · Recommended by specialist</strong>}
            <p>{option.approach}</p>
            <p><strong>Benefits:</strong> {option.benefits}</p>
            <p><strong>Trade-offs:</strong> {option.tradeoffs}</p>
            {option.id === state.choice!.question.recommendedId &&
              <p><strong>Why recommended:</strong> {state.choice!.question.recommendationReason}</p>}
          </label>)}
          <label style={{ display: 'block' }}>
            <input type="radio" name={'specialist-choice-' + state.choice.id}
              value="__custom__"
              checked={choiceSelections[state.choice.id] === '__custom__'}
              onChange={() => setChoiceSelections(old => ({ ...old, [state.choice!.id]: '__custom__' }))}/>
            {' '}<strong>Something else — my own direction</strong>
          </label>
          {choiceSelections[state.choice.id] === '__custom__' && <textarea
            aria-label="Custom creative direction" rows={4} maxLength={4000}
            value={customAnswers[state.choice.id] ?? ''}
            placeholder="Describe the solution you'd prefer, independently of the suggested options."
            onChange={e => setCustomAnswers(old => ({ ...old, [state.choice!.id]: e.target.value }))}/>}
        </fieldset>
        <label htmlFor={'choice-note-' + state.choice.id}>Additional instructions (optional)</label>
        <textarea id={'choice-note-' + state.choice.id} rows={2} maxLength={1000}
          disabled={busy !== null} value={choiceNotes[state.choice.id] ?? ''}
          onChange={e => setChoiceNotes(old => ({ ...old, [state.choice!.id]: e.target.value }))}/>
        <button type="button" disabled={busy !== null ||
          (choiceSelections[state.choice.id] === '__custom__' &&
            !(customAnswers[state.choice.id] ?? '').trim())}
          onClick={() => void submitChoice(state.choice!)}>Submit decision</button>
      </>}
    </article>}
    {(state?.decisions ?? []).map(item => <article key={'recovery-' + item.id}
      aria-label={item.title}>
      <h3>{item.title}</h3>
      <p>{item.description}</p>
      {'sourceExcerpt' in item.details ? <>
        <p><strong>Specialist explanation:</strong> {item.details.explanation}</p>
        <details><summary>Original protected Creative Direction</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {item.details.sourceExcerpt}
          </pre>
        </details>
      </> : <>
        <p><strong>Original validator:</strong> <code>{item.details.original.sha256}</code></p>
        <p><strong>Installed replacement:</strong> <code>{item.details.replacement.sha256}</code></p>
        <p><strong>Installed path:</strong> <code>{item.details.replacement.executable}</code></p>
        <p><strong>Native preflight:</strong> {item.details.diagnostics} diagnostics,
          protected-decision checks passed.</p>
        <p><small>Validation digest: <code>{item.details.validationDigest}</code></small></p>
      </>}
      <p><small>Git HEAD: <code>{item.verifiedHead}</code> ·
        Exact proposal: <code>{item.proposalSha256}</code></small></p>
      {item.phase === 'recorded' ? <p role="status">
        Decision recorded: {item.decision === 'approved' ? 'Approved' : 'Rejected'}.
        {item.note && <> Additional note: {item.note}</>}
        {item.id === 'foundation-conflict' && item.decision === 'approved' &&
          ' If the validator changed, review its replacement here before resuming.'}
        {item.id === 'validator-upgrade' && item.decision === 'approved' &&
          ' The replacement is pinned; Resume remains a separate action.'}
      </p> : <>
        {item.phase === 'applying' ? <p role="status">A previous decision was
          durably recorded but interrupted during application. You can finish only
          the same exact decision.</p> : <>
          <label htmlFor={'author-decision-note-' + item.id}>
            {item.id === 'foundation-conflict'
              ? 'Additional author direction (optional)'
              : 'Additional explanation (optional)'}
          </label>
          <textarea id={'author-decision-note-' + item.id} rows={2} maxLength={1000}
            disabled={busy !== null} value={decisionNotes[item.id] ?? ''}
            placeholder={item.id === 'foundation-conflict'
              ? 'Optional clarification for subsequent specialists'
              : 'Optional note for the authorization record'}
            onChange={e => setDecisionNotes(previous =>
              ({ ...previous, [item.id]: e.target.value }))} />
        </>}
        {item.phase === 'applying' ? <button type="button" disabled={busy !== null}
          onClick={() => void decideRecovery(item, item.decision!)}>
          Finish saved {item.decision === 'approved' ? 'approval' : 'rejection'}
        </button> : <>
          <button type="button" disabled={busy !== null}
            onClick={() => void decideRecovery(item, 'approved')}>Approve</button>{' '}
          <button type="button" disabled={busy !== null}
            onClick={() => void decideRecovery(item, 'rejected')}>Reject</button>
        </>}
      </>}
    </article>)}
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
