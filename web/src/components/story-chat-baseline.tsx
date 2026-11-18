import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { actStoryChatDiscovery, readStoryChatDiscovery } from '@/lib/story-chat-discovery.functions'
import { storyNavigationKey } from '@/lib/threads.queries'
import { initialQuestionDraft, questionDraftAnswer,
  type QuestionDraft } from '../../../src/author-question-set'
import { StoryChatBaselineView, type BaselineAction, type BaselineContinuation,
  type StoryChatBaselineSession } from './story-chat-baseline-view'

/** All decisions remain bound to the first Thread and its pinned session.
 * Local controls update immediately; draft persistence is debounced and CAS-fenced. */
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
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftConflict, setDraftConflict] = useState(false)
  const draftRef = useRef(drafts)
  const sessionRef = useRef<StoryChatBaselineSession | null>(null)
  const setIdRef = useRef<string | null>(null)
  const knownRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const savingRef = useRef<Promise<boolean> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef(false)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    // A navigation before the debounce expires should still attempt to save
    // the last local fields. This is never an author decision or approval.
    if (dirtyRef.current && !conflictRef.current) void flushRef.current()
  }, [])
  const session = query.data?.session as StoryChatBaselineSession | null | undefined
  if (session && (!sessionRef.current || session.revision >= sessionRef.current.revision))
    sessionRef.current = session

  useEffect(() => {
    const currentSet = session?.phase === 'questions' ? session.questions : null
    const id = currentSet?.id ?? null
    if (id === setIdRef.current) {
      if (id && session && session.revision > knownRevisionRef.current) {
        if (dirtyRef.current || savingRef.current) {
          conflictRef.current = true
          setDraftConflict(true)
          setError('This Question Set changed in another tab. Copy your unsaved input and reload.')
        } else {
          knownRevisionRef.current = session.revision
          draftRef.current = session.drafts ?? {}
          setDrafts(draftRef.current)
        }
      }
      return
    }
    setIdRef.current = id
    knownRevisionRef.current = session?.revision ?? 0
    draftRef.current = session?.drafts ?? {}
    setDrafts(draftRef.current)
    dirtyRef.current = false
    conflictRef.current = false
    setDraftConflict(false)
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [session?.questions, session?.phase, session?.revision])

  const flushDraft = async (): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (conflictRef.current) return false
    if (savingRef.current) {
      if (!await savingRef.current) return false
      if (!dirtyRef.current) return true
    }
    if (!dirtyRef.current) return true
    const current = sessionRef.current
    const set = current?.phase === 'questions' ? current.questions : null
    if (!current || !set || set.id !== setIdRef.current) return false
    dirtyRef.current = false
    const submittedDrafts = draftRef.current
    const pending = (async () => {
      try {
        const response = await actStoryChatDiscovery({ data: {
          storyId, firstTurnId, action: 'draft', revision: current.revision,
          setId: set.id, setRevision: set.revision, drafts: submittedDrafts,
        } })
        sessionRef.current = response.session as StoryChatBaselineSession
        knownRevisionRef.current = sessionRef.current.revision
        client.setQueryData(key, response)
        return true
      } catch (cause) {
        conflictRef.current = true
        setDraftConflict(true)
        setError(cause instanceof Error ? cause.message : 'Question drafts could not be saved.')
        return false
      }
    })()
    savingRef.current = pending
    const okay = await pending
    if (savingRef.current === pending) savingRef.current = null
    return okay && (dirtyRef.current ? flushDraft() : true)
  }
  flushRef.current = flushDraft
  const onDraftChange = (next: Record<string, QuestionDraft>) => {
    if (conflictRef.current || busy || JSON.stringify(next) === JSON.stringify(draftRef.current)) return
    draftRef.current = next
    setDrafts(next)
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flushDraft() }, 650)
  }

  const act = async (action: BaselineAction) => {
    if (!sessionRef.current || busy || conflictRef.current) return
    setBusy(true); setError(null)
    try {
      if (action === 'answer' && !await flushDraft()) return
      const current = sessionRef.current!
      const set = current.phase === 'questions' ? current.questions : null
      const responses = action === 'answer' && set ? set.questions.map(question => {
        const value = questionDraftAnswer(question,
          draftRef.current[question.id] ?? initialQuestionDraft(question))
        if (!value) throw new Error('Every question must be answered or delegated before submission.')
        return { questionId: question.id, answer: value }
      }) : undefined
      if (action === 'answer' && (!set || set.id !== setIdRef.current))
        throw new Error('The current Question Set is unavailable or has changed.')
      const response = await actStoryChatDiscovery({ data: {
        storyId, firstTurnId, action, revision: current.revision,
        ...(action === 'answer' && set ? { setId: set.id,
          setRevision: set.revision, responses } : {}),
        ...(action === 'revise' ? { text: answer } : {}),
        ...(action === 'approve' || action === 'continue'
          ? { digest: current.digest ?? undefined } : {}),
      } })
      sessionRef.current = response.session as StoryChatBaselineSession
      client.setQueryData(key, response)
      if (response.continuation?.state === 'queued') {
        await client.invalidateQueries({ queryKey: storyNavigationKey(storyId) })
        await client.invalidateQueries({ queryKey: ['thread-chat', threadId] })
      }
      setAnswer('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Discovery could not continue.')
    } finally {
      setBusy(false)
    }
  }
  return <StoryChatBaselineView session={session}
    continuation={query.data?.continuation as BaselineContinuation | undefined} answer={answer}
    onAnswerChange={setAnswer} drafts={drafts} onDraftChange={onDraftChange}
    busy={busy || draftConflict}
    error={error ?? (query.error instanceof Error ? query.error.message : null)}
    onAction={action => void act(action)} />
}
