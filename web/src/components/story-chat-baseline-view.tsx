import { Button } from '@/components/ui/button'

type Decision = { id: string; origin: 'user' | 'agent'
  authority: 'user-protected' | 'delegated'; statement: string }
type Foundation = {
  id: string; title: string; premise: string; central_conflict: string
  genre: string; tone: string; player_experience: string; scope: string
  body: string; decisions: Decision[]
}
export type StoryChatBaselineSession = {
  phase: 'running' | 'questions' | 'proposed' | 'approved' | 'blocked'
  revision: number; questions: string | null
  proposal: { foundation: Foundation; task: string } | null
  digest: string | null; skillId: string; startedAt: number | null
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  chat: { storyId: string; firstTurnId: string; sourceSha: string; directory: string }
}
export type BaselineAction = 'answer' | 'revise' | 'approve' | 'retry' | 'reconcile'

/** Presentational Chat disclosure; no server runtime is needed to render it. */
export function StoryChatBaselineView({ session, answer, onAnswerChange, busy, error, onAction }: {
  session: StoryChatBaselineSession | null | undefined
  answer: string; onAnswerChange: (text: string) => void
  busy: boolean; error: string | null
  onAction: (action: BaselineAction) => void
}) {
  if (!session && !error) return null
  const foundation = session?.proposal?.foundation
  return <section aria-label="Story baseline discovery" className="grid gap-3 rounded-lg bg-muted/20 p-3 text-sm">
    <h3 className="m-0 text-sm font-semibold">Creative Direction</h3>
    {session && <p className="m-0 text-xs text-muted-foreground">
      Discovery {session.phase} · Skill {session.skillId.slice(0, 12)} · Source {session.chat.sourceSha.slice(0, 12)}
    </p>}
    {session?.phase === 'questions' && <>
      <p className="m-0 whitespace-pre-wrap">{session.questions}</p>
      <label className="grid gap-1">Your answers (partial answers or delegation are fine)
        <textarea aria-label="Discovery answers" rows={4} maxLength={4000}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2"
          value={answer} disabled={busy} onChange={event => onAnswerChange(event.target.value)} />
      </label>
      <div><Button size="sm" disabled={busy || !answer.trim()} onClick={() => onAction('answer')}>
        Send answers
      </Button></div>
    </>}
    {foundation && (session?.phase === 'proposed' || session?.phase === 'approved') && <>
      <div className="grid gap-1">
        <strong>{foundation.title}</strong>
        <p className="m-0">{foundation.premise}</p>
        <p className="m-0"><strong>Conflict:</strong> {foundation.central_conflict}</p>
        <p className="m-0"><strong>Genre and tone:</strong> {foundation.genre} · {foundation.tone}</p>
        <p className="m-0"><strong>Player experience:</strong> {foundation.player_experience}</p>
        <p className="m-0"><strong>Scope:</strong> {foundation.scope}</p>
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
      </> : <p role="status" className="m-0">
        This exact Creative Direction is approved and native-validated. The original Turn
        remains saved for generation handoff; nothing else was authorized or published.
      </p>}
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
