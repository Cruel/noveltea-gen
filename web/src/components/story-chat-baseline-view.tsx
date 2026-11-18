import { Button } from '@/components/ui/button'
import { AuthorQuestionSetView, AuthorQuestionHistory,
  type AcceptedQuestionRound } from './author-question-set'
import type { QuestionSet, QuestionDraft } from '../../../src/author-question-set'
import type { StoryPlanning } from '../../../src/story-planning'

type Decision = { id: string; origin: 'user' | 'agent'
  authority: 'user-protected' | 'delegated'; statement: string }
type Foundation = {
  id: string; title: string; premise: string; central_conflict: string
  genre: string; tone: string; player_experience: string; scope: string
  body: string; planning?: StoryPlanning; decisions: Decision[]
}
export type StoryChatBaselineSession = {
  phase: 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'
  revision: number; questions: QuestionSet | null; legacyQuestions?: boolean
  drafts?: Record<string, QuestionDraft>
  accepted?: AcceptedQuestionRound[]
  proposal: { foundation: Foundation; task: string } | null
  digest: string | null; skillId: string; startedAt: number | null
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  chat: { storyId: string; firstTurnId: string; sourceSha: string; directory: string }
}
export type BaselineAction = 'answer' | 'revise' | 'approve' | 'retry' | 'reconcile' | 'continue' | 'restart'
export type BaselineContinuation = { state: 'queued' | 'pending' | 'blocked' | 'completed'; message?: string }

/** Presentational Chat disclosure; no server runtime is needed to render it. */
export function StoryChatBaselineView({ session, continuation, answer, onAnswerChange,
  drafts, onDraftChange, busy, error, onAction }: {
  session: StoryChatBaselineSession | null | undefined
  continuation?: BaselineContinuation | null
  answer: string; onAnswerChange: (text: string) => void
  drafts: Record<string, QuestionDraft>
  onDraftChange: (drafts: Record<string, QuestionDraft>) => void
  busy: boolean; error: string | null
  onAction: (action: BaselineAction) => void
}) {
  if (!session && !error) return null
  if (session?.legacyQuestions) return <section aria-label="Story baseline discovery"
    className="grid gap-3 rounded-lg bg-muted/20 p-3 text-sm">
    <h3 className="m-0 text-sm font-semibold">Creative Direction</h3>
    <p>This pre-v1 discovery session uses an unsupported question format. Restart explicitly
      from the original first request and pinned discovery method; previous unapproved
      questions and answers will not be converted.</p>
    {session.phase === 'running' ? <Button size="sm" variant="outline"
      disabled={busy || !session.startedAt || Date.now() - session.startedAt < 600_000}
      onClick={() => onAction('reconcile')}>Reconcile interrupted turn</Button>
      : <div><Button size="sm" variant="outline" disabled={busy}
        onClick={() => onAction('restart')}>Restart discovery questions</Button></div>}
    {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
  </section>
  const foundation = session?.proposal?.foundation
  return <section aria-label="Story baseline discovery" className="grid gap-3 rounded-lg bg-muted/20 p-3 text-sm">
    <h3 className="m-0 text-sm font-semibold">Creative Direction</h3>
    {session && <p className="m-0 text-xs text-muted-foreground">
      Discovery {session.phase}
    </p>}
    {session?.phase === 'questions' && session.questions && !session.legacyQuestions &&
      <AuthorQuestionSetView set={session.questions} drafts={drafts} disabled={busy}
        onDraftChange={onDraftChange} onSubmit={() => onAction('answer')} />}
    <AuthorQuestionHistory accepted={session?.accepted} />
    {foundation && (session?.phase === 'proposed' || session?.phase === 'approved') && <>
      <div className="grid gap-1">
        <strong>{foundation.title}</strong>
        <p className="m-0">{foundation.premise}</p>
        <p className="m-0"><strong>Conflict:</strong> {foundation.central_conflict}</p>
        <p className="m-0"><strong>Genre and tone:</strong> {foundation.genre} · {foundation.tone}</p>
        <p className="m-0"><strong>Player experience:</strong> {foundation.player_experience}</p>
        <p className="m-0"><strong>Scope:</strong> {foundation.scope}</p>
        {foundation.planning && <div className="grid gap-1">
          <strong>Proposed interaction, playthrough and production contract</strong>
          <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs"
            aria-label="Exact proposed planning metadata">{JSON.stringify(foundation.planning, null, 2)}</pre>
          <p className="m-0 text-xs text-muted-foreground">Hard limits and soft preferences remain distinct. Estimates describe one playthrough, not all branches combined.</p>
        </div>}
        <p className="m-0 whitespace-pre-wrap">{foundation.body}</p>
      </div>
      <div className="grid gap-1">
        <strong>Creative choices</strong>
        {foundation.decisions.map(decision => <p key={decision.id} className="m-0">
          <span className="text-muted-foreground">{decision.origin} · {decision.authority}: </span>
          {decision.statement}
        </p>)}
      </div>
      {session?.phase === 'proposed' ? <>
        <label className="grid gap-1">Corrections (optional)
          <textarea aria-label="Baseline corrections" rows={3} maxLength={4000}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2"
            value={answer} disabled={busy} onChange={event => onAnswerChange(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || !answer.trim()}
            onClick={() => onAction('revise')}>Request revision</Button>
          <Button size="sm" disabled={busy || !session.digest}
            onClick={() => onAction('approve')}>Approve baseline</Button>
        </div>
      </> : <div className="grid gap-2" role="status">
        <p className="m-0">Creative Direction approved and native-validated.
          {continuation?.state === 'queued'
            ? ' The original request is queued in this Thread.'
            : continuation?.state === 'completed'
              ? ' The requested Creative Direction is complete.'
              : ' The original request remains saved for continuation.'}
          {' '}No later Story edits or publication were approved.
        </p>
        {continuation?.message && <p className="m-0 text-muted-foreground">{continuation.message}</p>}
        {continuation?.state === 'blocked' && <div className="flex gap-3 items-center">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('continue')}>
            Continue
          </Button>
          <a href="/settings#ai-models" className="text-xs underline underline-offset-2">Model settings</a>
        </div>}
      </div>}
    </>}
    {session?.phase === 'running' && <p role="status" className="m-0">
      A model turn is reserved. Reload to inspect its result. If interrupted, reconcile
      the stale reservation before explicitly retrying.
    </p>}
    {session?.phase === 'running' && <div><Button size="sm" variant="outline"
      disabled={busy || !session.startedAt || Date.now() - session.startedAt < 600_000}
      onClick={() => onAction('reconcile')}>Reconcile interrupted turn</Button></div>}
    {session?.phase === 'blocked' && <>
      <p role="status" className="m-0">Discovery was interrupted. The saved input and
        session remain intact; a retry may incur another model call.</p>
      <div><Button size="sm" variant="outline" disabled={busy}
        onClick={() => onAction('retry')}>Retry discovery</Button></div>
    </>}
    {error && <p role="alert" className="m-0 text-destructive">{error}</p>}
  </section>
}
