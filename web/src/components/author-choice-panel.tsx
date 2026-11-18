import { AuthorQuestionContext } from '@/components/author-question-controls'
import { AuthorQuestionAnswerSummary } from '@/components/author-question-set'
import type { SpecialistChoice } from '../lib/author-state'

/** The specialist's editable question goes through SpecialistQuestionEditor and
 * the shared Question Set. This adapter only displays an immutable receipt;
 * no second input or submission path can emerge from a saved answer. */
export function AuthorChoicePanel({ choice, contextHref }: {
  choice: SpecialistChoice; contextHref?: (path: string) => string | undefined
}) {
  if (choice.phase !== 'answered' || !choice.answer) return null
  return <article aria-label="Specialist creative choice">
    <h3>Author question · <code>{choice.workItem}</code></h3>
    <div role="status">
      <p>{choice.question.question}</p>
      <AuthorQuestionContext context={choice.question.context} contextHref={contextHref} />
      <p>Your answer is saved for its original Story assignment.
        Studio continues automatically when the original checkpoint is safe;
        otherwise the execution controls provide explicit recovery.</p>
      <p><strong>Saved response:</strong> <AuthorQuestionAnswerSummary
        question={choice.question} answer={choice.answer} /></p>
      <p>The answer does not authorize changes to protected Creative Decisions.</p>
    </div>
  </article>
}
