import { AuthorQuestionControls } from './author-question-controls'
import { initialQuestionDraft, questionDraftAnswer,
  type QuestionDraft, type QuestionSet, type QuestionResponse } from '../../../src/author-question-set'
import { authorQuestionOptions, type AuthorQuestion, type AuthorQuestionAnswer } from '../../../src/author-question'
import type { RecoverableQuestionDrafts } from './use-question-set-drafts'
import { Button } from '@/components/ui/button'

export type AcceptedQuestionRound = { setId: string; setRevision: number; principal: string;
  submittedAt: string; questions: QuestionSet['questions']; responses: QuestionResponse[] }

/** One read-only answer presentation for discovery history and paused-specialist receipts. */
export function AuthorQuestionAnswerSummary({ question, answer }: {
  question: AuthorQuestion; answer: AuthorQuestionAnswer
}) {
  const options = authorQuestionOptions(question)
  const title = (id: string) => options.find(option => option.id === id)?.title ?? id
  const value = answer.kind === 'delegate' ? 'Delegated to NovelTea Studio'
    : answer.kind === 'custom' ? answer.text
      : answer.kind === 'multiple' ? [...answer.optionIds.map(title),
        ...(answer.text ? [answer.text] : [])].join('; ')
        : title(answer.optionId)
  return <>{value}{answer.note && <> (Note: {answer.note})</>}</>
}

/** A replaced set cannot receive stale input, but its unsent words remain
 * selectable for copying instead of vanishing on a poll from another tab. */
export function RecoverableQuestionDraftsView({ recovery, onDismiss }: {
  recovery: RecoverableQuestionDrafts | null; onDismiss: () => void
}) {
  if (!recovery) return null
  const transcript = recovery.set.questions.map(question => {
    const draft = recovery.drafts[question.id]
    if (!draft) return null
    const options = authorQuestionOptions(question)
    const choices = draft.selectedIds.length ? draft.selectedIds :
      draft.selection && !draft.selection.startsWith('__') ? [draft.selection] : []
    const labels = choices.map(id => options.find(option => option.id === id)?.title ?? id)
    if (draft.selection === '__delegate__') labels.push('Decide for me (not submitted)')
    if (draft.customAnswer) labels.push(draft.customAnswer)
    if (draft.note) labels.push('Additional instructions: ' + draft.note)
    return question.question + '\n' + (labels.join('; ') || '(No completed answer)')
  }).filter(Boolean).join('\n\n')
  return <section role="status" aria-label="Unsaved Question Set recovery"
    className="grid gap-2 rounded-md border border-border/60 p-3 text-sm">
    <p className="m-0">The questions changed in another tab before your edits could be saved.
      Your unsent input is preserved below for copying, but it cannot be applied
      automatically to the new questions.</p>
    <label className="grid gap-1">Previous unsent answers
      <textarea readOnly rows={Math.min(10, Math.max(3, transcript.split('\n').length))}
        className="w-full rounded-md border border-input bg-background px-3 py-2"
        value={transcript} /></label>
    <div><Button size="sm" type="button" variant="outline" onClick={onDismiss}>
      Dismiss unsent copy</Button></div>
  </section>
}

export function AuthorQuestionHistory({ accepted }: { accepted?: AcceptedQuestionRound[] }) {
  if (!accepted?.length) return null
  return <details className="text-xs">
    <summary>Submitted question history ({accepted.length} rounds)</summary>
    {accepted.map(batch => <div key={batch.setId} className="grid gap-1 p-2">
      {batch.responses.map(response => {
        const question = batch.questions.find(q => q.id === response.questionId)!
        return <p key={response.questionId} className="m-0">
          <strong>{question.question}</strong> — <AuthorQuestionAnswerSummary
            question={question} answer={response.answer} />
        </p>
      })}
    </div>)}
  </details>
}

/** Shared controls render a whole immutable batch; no individual question
 * can be submitted as an approval or advance the waiting workflow. */
export function AuthorQuestionSetView({ set, drafts, disabled, onDraftChange, onSubmit,
  contextHref, label = 'Story discovery questions' }: {
  set: QuestionSet; drafts: Record<string, QuestionDraft>; disabled: boolean
  onDraftChange: (drafts: Record<string, QuestionDraft>) => void
  onSubmit: () => void
  contextHref?: (path: string) => string | undefined
  label?: string
}) {
  const choices = set.questions.map(question => ({ question,
    draft: drafts[question.id] ?? initialQuestionDraft(question) }))
  const responses = choices.map(({ question, draft }) => questionDraftAnswer(question, draft))
  const complete = responses.every(Boolean)
  const delegated = responses.filter(answer => answer?.kind === 'delegate').length
  const change = (id: string, update: Partial<QuestionDraft>) => {
    const question = set.questions.find(q => q.id === id)!
    onDraftChange({ ...drafts, [id]: {
      ...(drafts[id] ?? initialQuestionDraft(question)), ...update,
    } })
  }
  return <div className="grid gap-1" aria-label={label}>
    <p className="m-0 text-xs text-muted-foreground">
      Answer or delegate each question. Recommendations are suggestions, not selections.
    </p>
    {choices.map(({ question, draft }, index) => <div key={question.id}
      className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-2 border-b border-border/40 py-2 last:border-b-0">
      <span className="pt-0.5 text-xs tabular-nums text-muted-foreground" aria-label={'Question ' + (index + 1) + ' of ' + choices.length}>
        {index + 1}/{choices.length}
      </span>
      <AuthorQuestionControls question={question} questionId={set.id + '-' + question.id}
        disabled={disabled} contextHref={contextHref} delegationAllowed={question.delegationAllowed === true}
        selection={draft.selection} selectedIds={draft.selectedIds} multiCustom={draft.multiCustom}
        customAnswer={draft.customAnswer} note={draft.note}
        onSelect={selection => change(question.id, { selection })}
        onSelectedIds={selectedIds => change(question.id, { selectedIds, selection: '' })}
        onMultiCustom={multiCustom => change(question.id, { multiCustom, selection: '' })}
        onCustomAnswer={customAnswer => change(question.id, {
          customAnswer, ...(draft.selection === '__delegate__' ? { selection: '__answer__' } : {}),
        })}
        onNote={note => change(question.id, { note })} />
      {drafts[question.id] && !responses[index] && <p role="status"
        className="col-start-2 m-0 text-xs text-destructive">
        Choose a valid response or complete the custom answer.
      </p>}
    </div>)}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" disabled={disabled || !complete} onClick={onSubmit}>
        Submit {responses.length - delegated} {responses.length - delegated === 1 ? 'answer' : 'answers'} and delegate {delegated} {delegated === 1 ? 'decision' : 'decisions'}
      </Button>
      {!complete && <p role="status" className="m-0 text-xs text-muted-foreground">
        Complete every question or delegate where permitted.
      </p>}
    </div>
  </div>
}
