import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { SpecialistChoice } from '../lib/author-state'

/** Source-bound author question view shared by Thread Chat and the Job panel.
 * It does not issue commands or interpret model-generated context as authority. */
export function AuthorChoicePanel({ choice, presentation, busy, selection, customAnswer, note,
  onSelect, onCustomAnswer, onNote, onSubmit }: {
  choice: SpecialistChoice; presentation: 'page' | 'chat'; busy: boolean
  selection: string; customAnswer: string; note: string
  onSelect: (value: string) => void; onCustomAnswer: (value: string) => void
  onNote: (value: string) => void; onSubmit: () => void
}) {
  const question = choice.question
  const kind = question.kind ?? 'alternatives'
  const selected = selection || question.recommendedId || ''
  const options = kind === 'yes-no' ?
    [{ id: 'yes', title: 'Yes', approach: '', benefits: '', tradeoffs: '' },
      { id: 'no', title: 'No', approach: '', benefits: '', tradeoffs: '' }] : question.options ?? []
  const custom = kind === 'free-text' || selected === '__custom__'
  return <article aria-label="Specialist creative choice">
    <h3>{presentation === 'chat' ? 'Your answer is needed' :
      <>Author question · <code>{choice.workItem}</code></>}</h3>
    <p>{question.question}</p>
    {!!question.context?.length && <details className="mt-2 text-xs text-muted-foreground">
      <summary>Relevant Story context</summary>
      {question.context.map(ref => <p key={ref.path + ':' + ref.line}>
        <code>{ref.path}:{ref.line}</code> — {ref.description}</p>)}
    </details>}
    {choice.phase === 'answered' ? <div role="status">
      <p>Your answer is saved. {presentation === 'chat'
        ? 'Select Continue generation below to resume the original specialist.'
        : 'Select Resume in Execution controls to continue the original specialist.'}</p>
      {choice.answer && <p><strong>Saved response:</strong> {choice.answer.kind === 'custom'
        ? choice.answer.text : options.find(option => option.id === choice.answer?.optionId)?.title
          ?? choice.answer.optionId}
        {!!choice.answer.note && <> — {choice.answer.note}</>}
      </p>}
      <p>The answer does not authorize changes to protected Creative Decisions.</p>
    </div> : <>
      {kind === 'free-text' ? <>
        <label htmlFor={'choice-free-text-' + choice.id}>Your answer</label>
        <Textarea id={'choice-free-text-' + choice.id} rows={4} maxLength={4000}
          disabled={busy} required value={customAnswer} onChange={e => onCustomAnswer(e.target.value)} />
      </> : <fieldset disabled={busy}>
        <legend>{kind === 'yes-no' ? 'Choose Yes, No, or Other' :
          'Choose an approach or provide your own'}</legend>
        <RadioGroup disabled={busy} aria-label="Author response options" value={selected}
          onValueChange={onSelect}>
          {options.map(option => <div key={option.id}
            className="mb-2 rounded-md border border-border/50 p-2">
            <label className="flex items-center gap-2">
              <RadioGroupItem value={option.id} aria-label={option.title} />
              <strong>{option.title}</strong>
              {option.id === question.recommendedId &&
                <span className="text-xs text-muted-foreground">Recommended</span>}
            </label>
            {!!option.approach && <p className="mt-1 text-sm">{option.approach}</p>}
            {kind === 'alternatives' && (presentation === 'chat' ?
              <details className="mt-1 text-xs text-muted-foreground">
                <summary>Benefits and trade-offs</summary>
                <p><strong>Benefits:</strong> {option.benefits}</p>
                <p><strong>Trade-offs:</strong> {option.tradeoffs}</p>
                {option.id === question.recommendedId && !!question.recommendationReason &&
                  <p><strong>Why recommended:</strong> {question.recommendationReason}</p>}
              </details> : <>
                <p><strong>Benefits:</strong> {option.benefits}</p>
                <p><strong>Trade-offs:</strong> {option.tradeoffs}</p>
                {option.id === question.recommendedId && !!question.recommendationReason &&
                  <p><strong>Why recommended:</strong> {question.recommendationReason}</p>}
              </>)}
          </div>)}
          <label className="flex items-center gap-2">
            <RadioGroupItem value="__custom__" aria-label="My own direction" />
            <strong>Other — my own direction</strong>
          </label>
        </RadioGroup>
        {selected === '__custom__' && <>
          <label htmlFor={'choice-custom-' + choice.id}>Your own direction (required)</label>
          <Textarea id={'choice-custom-' + choice.id} rows={4} maxLength={4000}
            required value={customAnswer} onChange={e => onCustomAnswer(e.target.value)}
            placeholder="Describe your preferred answer." />
        </>}
      </fieldset>}
      <label htmlFor={'choice-note-' + choice.id}>Additional instructions (optional)</label>
      <Textarea id={'choice-note-' + choice.id} rows={2} maxLength={1000}
        disabled={busy} value={note} onChange={e => onNote(e.target.value)} />
      <Button type="button" disabled={busy || !custom && !selected ||
        custom && !customAnswer.trim()} onClick={onSubmit}>
        Submit answer
      </Button>
    </>}
  </article>
}
