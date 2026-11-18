import type { AuthorQuestion } from '../../../src/author-question'
import { authorQuestionKind, authorQuestionOptions } from '../../../src/author-question'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'

/** Context remains inspectable even after the answer has been accepted. */
export function AuthorQuestionContext({ context, contextHref }: {
  context: AuthorQuestion['context']
  contextHref?: (path: string) => string | undefined
}) {
  if (!context?.length) return null
  return <details className="text-xs text-muted-foreground">
    <summary>Relevant Story context</summary>
    {context.map(ref => {
      const href = contextHref?.(ref.path)
      return <p key={ref.path + ':' + ref.line}>
        {href ? <a className="underline underline-offset-2" href={href}>
          <code>{ref.path}:{ref.line}</code></a>
          : <code>{ref.path}:{ref.line}</code>} — {ref.description}
      </p>
    })}
  </details>
}

/** Controlled question input only. The workflow owns authority, submission and receipts. */
export function AuthorQuestionControls({ question, questionId, disabled, selection,
  customAnswer, note, contextHref, onSelect, onCustomAnswer, onNote }: {
  question: AuthorQuestion; questionId: string; disabled: boolean
  contextHref?: (path: string) => string | undefined
  selection: string; customAnswer: string; note: string
  onSelect: (value: string) => void
  onCustomAnswer: (value: string) => void
  onNote: (value: string) => void
}) {
  const kind = authorQuestionKind(question)
  const options = authorQuestionOptions(question)
  const custom = kind === 'free-text' || selection === '__custom__'
  const id = 'choice-' + questionId
  return <div className="space-y-2" aria-label="Author question">
    <p id={id + '-prompt'}>{question.question}</p>
    <AuthorQuestionContext context={question.context} contextHref={contextHref} />
    {kind === 'free-text' ? <div>
      <label htmlFor={'choice-free-text-' + questionId}>Your answer</label>
      <Textarea id={'choice-free-text-' + questionId} rows={4} maxLength={4000}
        disabled={disabled} required value={customAnswer}
        placeholder={question.placeholder}
        onChange={e => onCustomAnswer(e.target.value)} />
    </div> : <fieldset disabled={disabled}>
      <legend>{kind === 'yes-no' ? 'Choose Yes, No, or Other' :
        'Choose an approach or provide your own'}</legend>
      <RadioGroup disabled={disabled} aria-label="Author response options" value={selection}
        onValueChange={onSelect}>
        {options.map(option => <div key={option.id}
          className="mb-2 rounded-md border border-border/50 p-2">
          <label className="flex items-center gap-2">
            <RadioGroupItem value={option.id} aria-label={option.title} />
            <strong>{option.title}</strong>
            {option.id === question.recommendedId &&
              <span className="text-xs text-muted-foreground">Recommended</span>}
          </label>
          {(option.description || option.approach) &&
            <p className="mt-1 text-sm">{option.description ?? option.approach}</p>}
          {!!(option.benefits || option.tradeoffs ||
            option.id === question.recommendedId && question.recommendationReason) &&
            <details className="mt-1 text-xs text-muted-foreground">
              <summary>Benefits and trade-offs</summary>
              {option.benefits && <p><strong>Benefits:</strong> {option.benefits}</p>}
              {option.tradeoffs && <p><strong>Trade-offs:</strong> {option.tradeoffs}</p>}
              {option.id === question.recommendedId && question.recommendationReason &&
                <p><strong>Why recommended:</strong> {question.recommendationReason}</p>}
            </details>}
        </div>)}
        <label className="flex items-center gap-2">
          <RadioGroupItem value="__custom__" aria-label="My own direction" />
          <strong>Other — my own direction</strong>
        </label>
      </RadioGroup>
      {custom && <div>
        <label htmlFor={'choice-custom-' + questionId}>Your own direction (required)</label>
        <Textarea id={'choice-custom-' + questionId} rows={4} maxLength={4000}
          disabled={disabled} required value={customAnswer}
          onChange={e => onCustomAnswer(e.target.value)}
          placeholder="Describe your preferred answer." />
      </div>}
    </fieldset>}
    <div>
      <label htmlFor={'choice-note-' + questionId}>Additional instructions (optional)</label>
      <Textarea id={'choice-note-' + questionId} rows={2} maxLength={1000}
        disabled={disabled} value={note} onChange={e => onNote(e.target.value)} />
    </div>
  </div>
}
