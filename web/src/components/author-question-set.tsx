import { AuthorQuestionControls } from './author-question-controls'
import { initialQuestionDraft, questionDraftAnswer,
  type QuestionDraft, type QuestionSet } from '../../../src/author-question-set'
import { Button } from '@/components/ui/button'

/** Shared controls render a whole immutable batch; no individual question
 * can be submitted as an approval or advance the waiting workflow. */
export function AuthorQuestionSetView({ set, drafts, disabled, onDraftChange, onSubmit }: {
  set: QuestionSet; drafts: Record<string, QuestionDraft>; disabled: boolean
  onDraftChange: (drafts: Record<string, QuestionDraft>) => void
  onSubmit: () => void
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
  return <div className="grid gap-3" aria-label="Story discovery questions">
    <p className="m-0 text-xs text-muted-foreground">
      Answer together or let NovelTea Studio decide where offered. Recommendations are suggestions, not selections.
    </p>
    {choices.map(({ question, draft }, index) => <div key={question.id}
      className="grid gap-1 rounded-md bg-muted/20 p-3">
      <p className="m-0 text-xs font-medium text-muted-foreground">Question {index + 1} of {choices.length}</p>
      <AuthorQuestionControls question={question} questionId={set.id + '-' + question.id}
        disabled={disabled} delegationAllowed={question.delegationAllowed === true}
        selection={draft.selection} selectedIds={draft.selectedIds} multiCustom={draft.multiCustom}
        customAnswer={draft.customAnswer} note={draft.note}
        onSelect={selection => change(question.id, {
          selection, ...(selection === '__delegate__' ? { selectedIds: [],
            multiCustom: false, customAnswer: '' } : {}),
        })}
        onSelectedIds={selectedIds => change(question.id, { selectedIds, selection: '' })}
        onMultiCustom={multiCustom => change(question.id, { multiCustom, selection: '' })}
        onCustomAnswer={customAnswer => change(question.id, {
          customAnswer, ...(draft.selection === '__delegate__' ? { selection: '__answer__' } : {}),
        })}
        onNote={note => change(question.id, { note })} />
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
