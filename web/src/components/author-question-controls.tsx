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
    <summary className="cursor-pointer">Relevant Story context</summary>
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
  const description = option.description ?? option.approach
  const rationale = option.id === question.recommendedId && question.recommendationReason
  if (!description && !option.benefits && !option.tradeoffs && !rationale) return null
  return <details className="ml-6 text-xs text-muted-foreground">
    <summary className="w-fit cursor-pointer select-none">
      {option.benefits || option.tradeoffs || rationale ? 'Benefits and trade-offs' : 'Details'}
    </summary>
    <div className="grid gap-1 pt-1">
      {description && <p className="m-0">{description}</p>}
      {option.benefits && <p className="m-0"><strong>Benefits:</strong> {option.benefits}</p>}
      {option.tradeoffs && <p className="m-0"><strong>Trade-offs:</strong> {option.tradeoffs}</p>}
      {rationale && <p className="m-0"><strong>Why recommended:</strong> {question.recommendationReason}</p>}
    </div>
  </details>
}

const choiceLabel = 'flex min-h-9 min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border/40 px-2 py-1.5 text-sm hover:bg-muted/30'
const choiceGrid = 'grid grid-cols-1 gap-1 sm:grid-cols-2'

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
  return <div className="grid min-w-0 gap-1.5 text-sm" aria-label="Author question">
    <p id={id + '-prompt'} className="m-0 font-medium text-foreground">{question.question}</p>
    <AuthorQuestionContext context={question.context} contextHref={contextHref} />
    {kind === 'free-text' ? <fieldset disabled={disabled} className="grid min-w-0 gap-1.5">
      {delegationAllowed && <div className={choiceGrid} role="group" aria-label="Who decides">
        <label data-compact-choice="" className={choiceLabel}>
          <input type="radio" name={id + '-delegation'} checked={!!delegated}
            onChange={() => onSelect('__delegate__')} />
          <span>Let NovelTea Studio decide</span>
        </label>
        <label data-compact-choice="" className={choiceLabel}>
          <input type="radio" name={id + '-delegation'} checked={!delegated}
            onChange={() => onSelect('__answer__')} />
          <span>I'll answer</span>
        </label>
      </div>}
      {!delegated && <div className="grid gap-1">
        <label htmlFor={'choice-free-text-' + questionId} className="text-xs">Your answer</label>
        <Textarea id={'choice-free-text-' + questionId} rows={2} maxLength={4000}
          required value={customAnswer} placeholder={question.placeholder}
          onChange={e => onCustomAnswer(e.target.value)} />
      </div>}
    </fieldset> : multiple ? <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">Choose one or more compatible options, or provide your own</legend>
      <div className={choiceGrid}>
        {delegationAllowed && <label data-compact-choice="" className={choiceLabel}>
          <input type="checkbox" checked={!!delegated}
            onChange={e => onSelect(e.target.checked ? '__delegate__' : '')} />
          <span>Let NovelTea Studio decide</span>
        </label>}
        {options.map(option => <div key={option.id} data-compact-choice=""
          className="min-w-0 rounded-md border border-border/40">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/30">
            <input type="checkbox" checked={!!selectedIds?.includes(option.id)}
              onChange={e => onSelectedIds?.(e.target.checked
                ? [...(selectedIds ?? []), option.id]
                : (selectedIds ?? []).filter(id => id !== option.id))} />
            <span className="min-w-0">{option.title}</span>
            {option.id === question.recommendedId &&
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">Recommended</span>}
          </label>
          <OptionDetails option={option} question={question} />
        </div>)}
        <label data-compact-choice="" className={choiceLabel}>
          <input type="checkbox" checked={!!multiCustom}
            onChange={e => onMultiCustom?.(e.target.checked)} />
          <span>Other — my own direction</span>
        </label>
      </div>
      {!!multiCustom && <div className="mt-1 grid gap-1">
        <label htmlFor={'choice-custom-' + questionId} className="text-xs">Your own direction (required)</label>
        <Textarea id={'choice-custom-' + questionId} rows={2} maxLength={4000}
          required value={customAnswer} onChange={e => onCustomAnswer(e.target.value)}
          placeholder="Describe your preferred answer." />
      </div>}
    </fieldset> : <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{kind === 'yes-no' ? 'Choose Yes, No, or Other' :
        'Choose an approach or provide your own'}</legend>
      <RadioGroup disabled={disabled} aria-label="Author response options" value={selection}
        onValueChange={onSelect} className={choiceGrid}>
        {delegationAllowed && <label data-compact-choice="" className={choiceLabel}>
          <RadioGroupItem value="__delegate__" aria-label="Let NovelTea Studio decide" />
          <span>Let NovelTea Studio decide</span>
        </label>}
        {options.map(option => <div key={option.id} data-compact-choice=""
          className="min-w-0 rounded-md border border-border/40">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/30">
            <RadioGroupItem value={option.id} aria-label={option.title} />
            <span className="min-w-0">{option.title}</span>
            {option.id === question.recommendedId &&
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">Recommended</span>}
          </label>
          <OptionDetails option={option} question={question} />
        </div>)}
        <label data-compact-choice="" className={choiceLabel}>
          <RadioGroupItem value="__custom__" aria-label="My own direction" />
          <span>Other — my own direction</span>
        </label>
      </RadioGroup>
      {custom && <div className="mt-1 grid gap-1">
        <label htmlFor={'choice-custom-' + questionId} className="text-xs">Your own direction (required)</label>
        <Textarea id={'choice-custom-' + questionId} rows={2} maxLength={4000}
          disabled={disabled} required value={customAnswer}
          onChange={e => onCustomAnswer(e.target.value)}
          placeholder="Describe your preferred answer." />
      </div>}
    </fieldset>}
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none">Additional instructions (optional){note.trim() ? ' · added' : ''}</summary>
      <label htmlFor={'choice-note-' + questionId} className="sr-only">Additional instructions</label>
      <Textarea id={'choice-note-' + questionId} rows={2} maxLength={1000}
        className="mt-1" disabled={disabled} value={note} onChange={e => onNote(e.target.value)} />
    </details>
  </div>
}
