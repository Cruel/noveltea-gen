import type { AuthorQuestion, AuthorQuestionOption } from '../../../src/author-question'
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

function OptionDetails({ option, question }: {
  option: AuthorQuestionOption; question: AuthorQuestion
}) {
  return <>
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
  </>
}

/** Pure controlled inputs. Delegation permission is provided by the controller,
 * not taken from the question's agent-supplied allowStudioDecision request. */
export function AuthorQuestionControls({ question, questionId, disabled, delegationAllowed, selection,
  selectedIds, multiCustom, customAnswer, note, contextHref, onSelect, onSelectedIds,
  onMultiCustom, onCustomAnswer, onNote }: {
  question: AuthorQuestion; questionId: string; disabled: boolean; delegationAllowed?: boolean
  contextHref?: (path: string) => string | undefined
  selection: string; selectedIds?: string[]; multiCustom?: boolean
  customAnswer: string; note: string
  onSelect: (value: string) => void
  onSelectedIds?: (value: string[]) => void
  onMultiCustom?: (enabled: boolean) => void
  onCustomAnswer: (value: string) => void
  onNote: (value: string) => void
}) {
  const kind = authorQuestionKind(question)
  const options = authorQuestionOptions(question)
  const multiple = kind === 'multiple-choice'
  const delegated = delegationAllowed && selection === '__delegate__'
  const custom = selection === '__custom__'
  const id = 'choice-' + questionId
  return <div className="space-y-2" aria-label="Author question">
    <p id={id + '-prompt'}>{question.question}</p>
    <AuthorQuestionContext context={question.context} contextHref={contextHref} />
    {kind === 'free-text' ? <fieldset disabled={disabled} className="space-y-2">
      {delegationAllowed && <div className="space-y-2" role="group" aria-label="Who decides">
        <label className="flex items-center gap-2 rounded-md border border-border/50 p-2">
          <input type="radio" name={id + '-delegation'} checked={!!delegated}
            onChange={() => onSelect('__delegate__')} />
          <strong>Let NovelTea Studio decide</strong>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={id + '-delegation'} checked={!delegated}
            onChange={() => onSelect('__answer__')} />
          <strong>I'll answer</strong>
        </label>
      </div>}
      {!delegated && <div>
        <label htmlFor={'choice-free-text-' + questionId}>Your answer</label>
        <Textarea id={'choice-free-text-' + questionId} rows={4} maxLength={4000}
          required value={customAnswer} placeholder={question.placeholder}
          onChange={e => onCustomAnswer(e.target.value)} />
      </div>}
    </fieldset> : multiple ? <fieldset disabled={disabled} className="space-y-2">
      <legend>Choose one or more compatible options, or provide your own</legend>
      {delegationAllowed && <label className="flex items-center gap-2 rounded-md border border-border/50 p-2">
        <input type="checkbox" checked={!!delegated}
          onChange={e => onSelect(e.target.checked ? '__delegate__' : '')} />
        <strong>Let NovelTea Studio decide</strong>
      </label>}
      {options.map(option => <div key={option.id}
        className="rounded-md border border-border/50 p-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!selectedIds?.includes(option.id)}
            onChange={e => onSelectedIds?.(e.target.checked
              ? [...(selectedIds ?? []), option.id]
              : (selectedIds ?? []).filter(id => id !== option.id))} />
          <strong>{option.title}</strong>
          {option.id === question.recommendedId &&
            <span className="text-xs text-muted-foreground">Recommended</span>}
        </label>
        <OptionDetails option={option} question={question} />
      </div>)}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!multiCustom}
          onChange={e => onMultiCustom?.(e.target.checked)} />
        <strong>Other — my own direction</strong>
      </label>
      {!!multiCustom && <div>
        <label htmlFor={'choice-custom-' + questionId}>Your own direction (required)</label>
        <Textarea id={'choice-custom-' + questionId} rows={4} maxLength={4000}
          required value={customAnswer} onChange={e => onCustomAnswer(e.target.value)}
          placeholder="Describe your preferred answer." />
      </div>}
    </fieldset> : <fieldset disabled={disabled}>
      <legend>{kind === 'yes-no' ? 'Choose Yes, No, or Other' :
        'Choose an approach or provide your own'}</legend>
      <RadioGroup disabled={disabled} aria-label="Author response options" value={selection}
        onValueChange={onSelect}>
        {delegationAllowed && <label className="flex items-center gap-2 rounded-md border border-border/50 p-2">
          <RadioGroupItem value="__delegate__" aria-label="Let NovelTea Studio decide" />
          <strong>Let NovelTea Studio decide</strong>
        </label>}
        {options.map(option => <div key={option.id}
          className="mb-2 rounded-md border border-border/50 p-2">
          <label className="flex items-center gap-2">
            <RadioGroupItem value={option.id} aria-label={option.title} />
            <strong>{option.title}</strong>
            {option.id === question.recommendedId &&
              <span className="text-xs text-muted-foreground">Recommended</span>}
          </label>
          <OptionDetails option={option} question={question} />
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
