import { Button } from '@/components/ui/button'
import { AuthorQuestionContext, AuthorQuestionControls } from '@/components/author-question-controls'
import { authorQuestionKind, authorQuestionOptions } from '../../../src/author-question'
import type { SpecialistChoice } from '../lib/author-state'

/** Thin specialist adapter around shared controlled Author Question inputs.
 * The authenticated Job command and source-bound specialist receipt stay outside. */
export function AuthorChoicePanel({ choice, presentation, busy, selection, customAnswer, note,
  selectedIds, multiCustom, contextHref, onSelect, onSelectedIds, onMultiCustom,
  onCustomAnswer, onNote, onSubmit }: {
  choice: SpecialistChoice; presentation: 'page' | 'chat'; busy: boolean
  contextHref?: (path: string) => string | undefined
  selection: string; selectedIds?: string[]; multiCustom?: boolean
  customAnswer: string; note: string
  onSelect: (value: string) => void; onSelectedIds?: (value: string[]) => void
  onMultiCustom?: (enabled: boolean) => void; onCustomAnswer: (value: string) => void
  onNote: (value: string) => void; onSubmit: () => void
}) {
  const question = choice.question
  const options = authorQuestionOptions(question)
  const kind = authorQuestionKind(question)
  const delegated = choice.delegationAllowed === true && selection === '__delegate__'
  const custom = kind === 'free-text' || selection === '__custom__'
  const multi = kind === 'multiple-choice'
  const multiValid = (!multiCustom || !!customAnswer.trim()) &&
    (!!selectedIds?.length || !!multiCustom)
  const explicitValid = multi ? multiValid : custom ? !!customAnswer.trim() :
    options.some(option => option.id === selection)
  const saved = choice.answer
  return <article aria-label="Specialist creative choice">
    <h3>{presentation === 'chat' ? 'Your answer is needed' :
      <>Author question · <code>{choice.workItem}</code></>}</h3>
    {choice.phase === 'answered' ? <div role="status">
      <p>{question.question}</p>
      <AuthorQuestionContext context={question.context} contextHref={contextHref} />
      <p>Your answer is saved. {presentation === 'chat'
        ? 'Select Continue generation below to resume the original specialist.'
        : 'Select Resume in Execution controls to continue the original specialist.'}</p>
      {saved && <p><strong>Saved response:</strong> {saved.kind === 'custom'
        ? saved.text : saved.kind === 'delegate' ? 'Delegated to NovelTea Studio'
          : saved.kind === 'multiple'
            ? [...saved.optionIds.map(id => options.find(option => option.id === id)?.title ?? id),
              ...(saved.text ? [saved.text] : [])].join('; ')
            : options.find(option => option.id === saved.optionId)?.title ?? saved.optionId}
        {!!saved.note && <> — {saved.note}</>}
      </p>}
      <p>The answer does not authorize changes to protected Creative Decisions.</p>
    </div> : <>
      <AuthorQuestionControls question={question} questionId={choice.id} disabled={busy}
        delegationAllowed={choice.delegationAllowed === true} selection={selection}
        selectedIds={selectedIds} multiCustom={multiCustom}
        customAnswer={customAnswer} note={note} contextHref={contextHref}
        onSelect={onSelect} onSelectedIds={onSelectedIds} onMultiCustom={onMultiCustom}
        onCustomAnswer={onCustomAnswer} onNote={onNote} />
      <Button type="button" disabled={busy || !(delegated || explicitValid)} onClick={onSubmit}>
        Submit answer
      </Button>
    </>}
  </article>
}
