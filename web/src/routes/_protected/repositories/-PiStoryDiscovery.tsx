import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { StudioSelect } from '@/components/studio-select'
import { AuthorQuestionHistory, AuthorQuestionSetView,
  type AcceptedQuestionRound } from '@/components/author-question-set'
import { useQuestionSetDrafts } from '@/components/use-question-set-drafts'
import { initialQuestionDraft, questionDraftAnswer,
  type QuestionDraft, type QuestionSet } from '../../../../../src/author-question-set'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { loadPiDiscovery, actPiDiscovery } from '../../../lib/story-workflows.functions'
import { getPiCatalog } from '../../../lib/pi.functions'

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
type Turn = { role: 'user' | 'assistant'; text: string; source?: 'question-set' }
type Session = { phase: 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'; revision: number
  model: PiModel; turns: Turn[]; questions: QuestionSet | null; proposal: PiProposal | null
  legacyQuestions?: boolean; drafts?: Record<string, QuestionDraft>; accepted?: AcceptedQuestionRound[]
  digest: string | null; skillId: string; startedAt: number | null }

/** The repository-creation adapter uses the same validated Question Sets and
 * debounced, CAS-fenced drafts as the ordinary first-Thread discovery flow. */
export function PiStoryDiscovery({ repositoryId, workspace, initialBrief, onApproved }: {
  repositoryId: string; workspace: string; initialBrief: string
  onApproved: (proposal: PiProposal, reference: PiApproval, model: PiModel) => void
}) {
  const queryClient = useQueryClient()
  const sessionKey = ['pi-discovery', repositoryId, workspace] as const
  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      const body = await loadPiDiscovery({ data: { repositoryId, workspace } })
      return JSON.parse(body) as { session: Session | null }
    },
  })
  const modelQuery = useQuery({
    queryKey: ['pi-models'] as const,
    queryFn: async () => JSON.parse(await getPiCatalog()) as {
      models: Array<{ provider: string; id: string; reasoning: boolean }>,
    },
  })
  const session = sessionQuery.data?.session ?? null
  const models = modelQuery.data?.models ?? []
  const [selection, setSelection] = useState('')
  const [thinking, setThinking] = useState<'low' | 'medium' | 'high' | ''>('')
  const [brief, setBrief] = useState(initialBrief)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drafts = useQuestionSetDrafts({
    session, identity: repositoryId + ':' + workspace,
    save: async (current, value) => {
      const set = current.questions!
      const result = JSON.parse(await actPiDiscovery({ data: {
        repositoryId, workspace, json: JSON.stringify({
          action: 'draft', revision: current.revision, setId: set.id,
          setRevision: set.revision, drafts: value,
        }),
      } })) as { session: Session }
      queryClient.setQueryData(sessionKey, result)
      return result.session
    },
    onSaved: () => {},
  })
  useEffect(() => {
    setBrief(initialBrief); setError(null)
  }, [repositoryId, workspace, initialBrief])
  useEffect(() => {
    if (session?.phase === 'approved' && session.proposal && session.digest)
      onApproved(session.proposal, { revision: session.revision, digest: session.digest }, session.model)
  }, [session?.phase, session?.revision, session?.digest])
  const perform = async (input: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try {
      const result = JSON.parse(await actPiDiscovery({ data: {
        repositoryId, workspace, json: JSON.stringify(input),
      } })) as { session: Session }
      drafts.sessionRef.current = result.session
      queryClient.setQueryData(sessionKey, result)
      setAnswer('')
      if (result.session.phase === 'approved' && result.session.proposal && result.session.digest)
        onApproved(result.session.proposal, {
          revision: result.session.revision, digest: result.session.digest,
        }, result.session.model)
    } catch (e) { setError(e instanceof Error ? e.message : 'Story discovery could not continue') }
    finally { setBusy(false) }
  }
  const submitAnswers = async () => {
    if (busy || drafts.conflict || !await drafts.flush()) return
    const current = drafts.sessionRef.current
    const set = current?.phase === 'questions' ? current.questions : null
    if (!current || !set) {
      setError('The Question Set is no longer available; reload before submitting.')
      return
    }
    const responses = set.questions.map(question => ({ questionId: question.id,
      answer: questionDraftAnswer(question,
        drafts.draftsRef.current[question.id] ?? initialQuestionDraft(question)) }))
    if (responses.some(response => !response.answer)) {
      setError('Complete every question or delegate where permitted.')
      return
    }
    await perform({ action: 'answer', revision: current.revision,
      setId: set.id, setRevision: set.revision, responses })
  }
  const selected = models.find(m => m.provider + '/' + m.id === selection)
  const disabled = busy || drafts.conflict
  return <section aria-label="NovelTea Studio collaborative discovery" className="story-onboarding">
    <h3>Develop your Story with NovelTea Studio</h3>
    <p>Describe your idea. Studio will ask relevant questions and suggest a Creative Direction
      for your review. No Story files are written until you approve it.</p>
    {!session && <>
      <label className="story-onboarding-field">Your Story idea
        <Textarea rows={5} maxLength={4000} disabled={busy} value={brief}
          onChange={e => setBrief(e.target.value)} placeholder="A one-sentence premise is enough." />
      </label>
      <label className="story-onboarding-field">Model
        <StudioSelect aria-label="Connected model" value={selection} disabled={busy}
          onValueChange={value => { setSelection(value); setThinking('') }}
          options={[{ value: '', label: 'Select model' },
            ...models.map(m => ({ value: m.provider + '/' + m.id,
              label: m.provider + ' / ' + m.id }))]} />
      </label>
      {selected?.reasoning && <label className="story-onboarding-field">Reasoning effort
        <StudioSelect aria-label="Reasoning effort" value={thinking} disabled={busy}
          onValueChange={value => setThinking(value as typeof thinking)}
          options={[{ value: '', label: 'Default' }, { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
      </label>}
      <Button type="button" disabled={busy || !brief.trim() || !selected}
        onClick={() => { if (selected) void perform({ action: 'start', text: brief,
          model: { provider: selected.provider, id: selected.id, ...(thinking ? {thinking} : {}) } }) }}>
        {busy ? 'Starting discovery…' : 'Start discovery'}
      </Button>
      {!models.length && <p>Connect a model in Settings before continuing.</p>}
    </>}
    {session && <>
      <p>Discovery: <strong>{session.phase}</strong>.</p>
      {session.turns.filter(t => t.role === 'user' && t.source !== 'question-set').map((turn, i) =>
        <p key={i}><strong>Author {i + 1}:</strong> {turn.text}</p>)}
      <AuthorQuestionHistory accepted={session.accepted} />
      {session.phase === 'running' && <div role="status">
        <p>A model turn was reserved. Reload to inspect its outcome. If interrupted,
          reconcile the turn before retrying.</p>
        <Button type="button" disabled={disabled || !session.startedAt || Date.now() - session.startedAt < 600_000}
          onClick={() => void perform({ action: 'reconcile', revision: session.revision })}>
          Reconcile interrupted turn
        </Button>
      </div>}
      {session.legacyQuestions && ['questions', 'blocked'].includes(session.phase) ? <div role="status">
        <p>This session uses the previous textual question format. Restart from the saved
          original Story idea and pinned method to use structured Question Sets.
          Unapproved textual answers cannot be converted.</p>
        <Button type="button" variant="outline" disabled={disabled}
          onClick={() => void perform({ action: 'restart', revision: session.revision })}>
          Restart discovery questions
        </Button>
      </div> : <>
        {session.phase === 'blocked' && <div role="alert">
          <p>The model turn was interrupted. The accepted answers remain saved;
            explicitly retry only after checking the interrupted work.</p>
          <Button type="button" disabled={disabled}
            onClick={() => void perform({ action: 'retry', revision: session.revision })}>
            Retry interrupted discovery turn
          </Button>
        </div>}
        {session.phase === 'questions' && session.questions && <>
          <h3>Current questions</h3>
          <AuthorQuestionSetView set={session.questions} drafts={drafts.drafts}
            disabled={disabled} onDraftChange={value => { if (!busy) drafts.change(value) }}
            onSubmit={() => void submitAnswers()} />
        </>}
      </>}
      {(session.phase === 'proposed' || session.phase === 'approved') && session.proposal && <>
        <h3>Review the proposed Creative Direction</h3>
        <p><strong>{session.proposal.foundation.title}</strong> (<code>{session.proposal.foundation.id}</code>)</p>
        <p>{session.proposal.foundation.premise}</p>
        <p><strong>Conflict:</strong> {session.proposal.foundation.central_conflict}</p>
        <p><strong>Genre/tone:</strong> {session.proposal.foundation.genre} / {session.proposal.foundation.tone}</p>
        <p><strong>Player experience:</strong> {session.proposal.foundation.player_experience}</p>
        <p><strong>Scope:</strong> {session.proposal.foundation.scope}</p>
        <p className="whitespace-pre-wrap break-words">{session.proposal.foundation.body}</p>
        <h3>Creative decision authority</h3>
        {session.proposal.foundation.decisions.map(d => <p key={d.id}>
          <strong>{d.origin} / {d.authority}:</strong> {d.statement}</p>)}
        <p><strong>Next generation task:</strong> {session.proposal.task}</p>
        {session.phase === 'proposed'
          ? <>
            <label className="story-onboarding-field">Corrections or additional creative direction
              <Textarea rows={4} maxLength={4000} value={answer} disabled={disabled}
                onChange={e => setAnswer(e.target.value)} />
            </label>
            <div className="actions">
              <Button type="button" disabled={disabled || !answer.trim()}
                onClick={() => void perform({action: 'revise', revision: session.revision, text: answer})}>
                Request revision
              </Button>
              <Button type="button" disabled={disabled || !session.digest}
                onClick={() => void perform({action: 'approve', revision: session.revision, digest: session.digest})}>
                Approve exact Creative Direction
              </Button>
            </div>
          </>
          : <p role="status">This exact proposal is approved. Initialize it on the selected Story branch below.</p>}
      </>}
    </>}
    {(error || drafts.error || sessionQuery.error || modelQuery.error) &&
      <p role="alert" className="error">{error || drafts.error || sessionQuery.error?.message || modelQuery.error?.message}</p>}
  </section>
}
