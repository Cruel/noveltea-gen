import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { actStoryChatDiscovery, readStoryChatDiscovery } from '@/lib/story-chat-discovery.functions'
import { storyNavigationKey } from '@/lib/threads.queries'
import { initialQuestionDraft, questionDraftAnswer } from '../../../src/author-question-set'
import { useQuestionSetDrafts } from './use-question-set-drafts'
import { StoryChatBaselineView, type BaselineAction, type BaselineContinuation,
  type StoryChatBaselineSession } from './story-chat-baseline-view'

/** The first Thread owns baseline discovery; shared drafts never grant approval. */
export function StoryChatBaseline({ storyId, threadId }: {
  storyId: string; threadId: string
}) {
  const firstTurnId = threadId.slice('root:'.length)
  const key = ['story-chat-discovery', storyId, firstTurnId]
  const client = useQueryClient()
  const query = useQuery({
    queryKey: key,
    queryFn: () => readStoryChatDiscovery({ data: { storyId, firstTurnId } }),
    refetchInterval: 5000,
  })
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = query.data?.session as StoryChatBaselineSession | null | undefined
  const draftState = useQuestionSetDrafts({
    session, identity: storyId + ':' + firstTurnId,
    save: async (current, drafts) => {
      const set = current.questions!
      const response = await actStoryChatDiscovery({ data: {
        storyId, firstTurnId, action: 'draft', revision: current.revision,
        setId: set.id, setRevision: set.revision, drafts,
      } })
      client.setQueryData(key, response)
      return response.session as StoryChatBaselineSession
    },
    onSaved: () => {},
  })
  const act = async (action: BaselineAction) => {
    if (!draftState.sessionRef.current || busy || draftState.conflict) return
    setBusy(true); setError(null)
    try {
      if (action === 'answer' && !await draftState.flush()) return
      const current = draftState.sessionRef.current!
      const set = current.phase === 'questions' ? current.questions : null
      const responses = action === 'answer' && set ? set.questions.map(question => {
        const value = questionDraftAnswer(question,
          draftState.draftsRef.current[question.id] ?? initialQuestionDraft(question))
        if (!value) throw new Error('Every question must be answered or delegated before submission.')
        return { questionId: question.id, answer: value }
      }) : undefined
      if (action === 'answer' && !set) throw new Error('The Question Set is unavailable or has changed.')
      const response = await actStoryChatDiscovery({ data: {
        storyId, firstTurnId, action, revision: current.revision,
        ...(action === 'answer' && set ? { setId: set.id,
          setRevision: set.revision, responses } : {}),
        ...(action === 'revise' ? { text: answer } : {}),
        ...(action === 'approve' || action === 'continue'
          ? { digest: current.digest ?? undefined } : {}),
      } })
      draftState.sessionRef.current = response.session as StoryChatBaselineSession
      client.setQueryData(key, response)
      if (response.continuation?.state === 'queued') {
        await client.invalidateQueries({ queryKey: storyNavigationKey(storyId) })
        await client.invalidateQueries({ queryKey: ['thread-chat', threadId] })
      }
      setAnswer('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Discovery could not continue.')
    } finally { setBusy(false) }
  }
  return <StoryChatBaselineView session={session}
    continuation={query.data?.continuation as BaselineContinuation | undefined} answer={answer}
    onAnswerChange={setAnswer} drafts={draftState.drafts}
    onDraftChange={drafts => { if (!busy) draftState.change(drafts) }}
    busy={busy || draftState.conflict}
    error={error ?? draftState.error ?? (query.error instanceof Error ? query.error.message : null)}
    onAction={action => void act(action)} />
}
