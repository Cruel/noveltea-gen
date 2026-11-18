import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { sendAuthorCommand } from '@/lib/author.functions'
import { authorInteractionsKey, type AuthorState, type SpecialistChoice } from '@/lib/author-state'
import { initialQuestionDraft, questionDraftAnswer, specialistQuestionSet,
  type QuestionSet } from '../../../src/author-question-set'
import { AuthorQuestionSetView } from './author-question-set'
import { useQuestionSetDrafts } from './use-question-set-drafts'

type DraftSession = { phase: 'questions'; revision: number; questions: QuestionSet;
  drafts: NonNullable<SpecialistChoice['draft']>['drafts'] }

/** One paused specialist is exactly one Question Set. The Job's source-bound
 * receipt still owns answer acceptance and safe continuation. */
export function SpecialistQuestionEditor({ jobId, choice, contextHref, onChanged }: {
  jobId: string; choice: SpecialistChoice
  contextHref?: (path: string) => string | undefined
  onChanged: () => void
}) {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const session = useMemo<DraftSession>(() => ({
    phase: 'questions',
    revision: choice.draft?.revision ?? 1,
    drafts: choice.draft?.drafts ?? {},
    questions: specialistQuestionSet(choice),
  }), [choice])
  const lifecycle = useQuestionSetDrafts({
    session, identity: jobId + ':' + choice.id + ':' + choice.proposalSha256,
    save: async (current, drafts) => {
      const response = JSON.parse(await sendAuthorCommand({ data: {
        jobId, commandJson: JSON.stringify({
          action: 'choice-draft', id: choice.id, proposalSha256: choice.proposalSha256,
          draftRevision: current.revision, drafts,
        }),
      } })) as { draft: NonNullable<SpecialistChoice['draft']> }
      return { ...current, revision: response.draft.revision, drafts: response.draft.drafts }
    },
    onSaved: saved => client.setQueryData<AuthorState>(authorInteractionsKey(jobId), previous => {
      if (!previous?.choice || previous.choice.id !== choice.id ||
          (previous.choice.draft?.revision ?? 1) > saved.revision) return previous
      return { ...previous, choice: { ...previous.choice,
        draft: { revision: saved.revision, drafts: saved.drafts } } }
    }),
  })
  const submit = async () => {
    if (busy || lifecycle.conflict) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (!await lifecycle.flush()) return
      const current = lifecycle.sessionRef.current
      if (!current || current.questions.id !== choice.id)
        throw Error('This Question Set changed. Reload before submitting.')
      const question = current.questions.questions[0]!
      const draft = lifecycle.draftsRef.current.answer ?? initialQuestionDraft(question)
      const answer = questionDraftAnswer(question, draft)
      if (!answer) throw Error('Complete this question or delegate where permitted.')
      const accepted = JSON.parse(await sendAuthorCommand({ data: {
        jobId, commandJson: JSON.stringify({
          action: 'choice', id: choice.id, proposalSha256: choice.proposalSha256,
          draftRevision: current.revision, ...answer,
        }),
      } })) as { continuation?: 'queued' | 'manual' }
      if (accepted.continuation === 'manual')
        setNotice('Your answer was saved. Automatic continuation is unavailable; inspect the saved checkpoint before continuing.')
      await client.invalidateQueries({ queryKey: authorInteractionsKey(jobId) })
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Author answer was not accepted.')
    } finally { setBusy(false) }
  }
  return <article aria-label="Specialist creative choice" className="grid gap-2">
    <h3 className="m-0 text-sm font-semibold">Your answer is needed</h3>
    <AuthorQuestionSetView set={session.questions} drafts={lifecycle.drafts}
      label="Specialist author question" disabled={busy || lifecycle.conflict}
      contextHref={contextHref}
      onDraftChange={value => lifecycle.change(value)}
      onSubmit={() => void submit()} />
    {(error || lifecycle.error) && <p className="m-0 text-xs text-destructive" role="alert">
      {error ?? lifecycle.error}
    </p>}
    {notice && <p role="status" className="m-0 text-xs">{notice}</p>}
  </article>
}
