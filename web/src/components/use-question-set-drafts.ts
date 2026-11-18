import { useEffect, useRef, useState } from 'react'
import type { QuestionDraft, QuestionSet } from '../../../src/author-question-set'

type DraftSession = {
  phase: string; revision: number; questions: QuestionSet | null
  drafts?: Record<string, QuestionDraft>
}
export type RecoverableQuestionDrafts = {
  set: QuestionSet; drafts: Record<string, QuestionDraft>
}

/** Debounced, deduplicated owner-scoped drafts. Local input always wins over
 * our own save acknowledgement; a *foreign* newer revision fences edits and
 * submission rather than silently replacing the author's pending keystrokes. */
export function useQuestionSetDrafts<S extends DraftSession>({ session, identity, save, onSaved }: {
  session: S | null | undefined; identity: string
  save: (current: S, drafts: Record<string, QuestionDraft>) => Promise<S>
  onSaved: (saved: S) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(
    () => session?.phase === 'questions' ? session.drafts ?? {} : {})
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<RecoverableQuestionDrafts | null>(null)
  const draftsRef = useRef(drafts)
  const sessionRef = useRef<S | null>(null)
  const keyRef = useRef<string | null>(null)
  const identityRef = useRef(identity)
  const revisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const savingRef = useRef<Promise<boolean> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef(false)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const saveRef = useRef(save)
  const onSavedRef = useRef(onSaved)
  saveRef.current = save
  onSavedRef.current = onSaved
  const key = session?.phase === 'questions' && session.questions
    ? identity + ':' + session.questions.id : null

  useEffect(() => {
    const sameOwner = identityRef.current === identity
    if (!sameOwner) {
      identityRef.current = identity
      setRecovery(null) // Never show another Story/Job's private unsent input.
    }
    if (key !== keyRef.current) {
      // Another tab may submit/revise the original set while input is still
      // pending locally. Retain a copy for the author, but never submit it to
      // a different set or replay it as an accepted answer.
      const previousSet = sessionRef.current?.phase === 'questions'
        ? sessionRef.current.questions : null
      if (sameOwner && keyRef.current && previousSet &&
          (dirtyRef.current || savingRef.current || conflictRef.current))
        setRecovery({ set: previousSet, drafts: draftsRef.current })
      if (timerRef.current) clearTimeout(timerRef.current)
      keyRef.current = key
      sessionRef.current = session ?? null
      revisionRef.current = session?.revision ?? 0
      draftsRef.current = session?.drafts ?? {}
      setDrafts(draftsRef.current)
      dirtyRef.current = false
      savingRef.current = null
      conflictRef.current = false
      setConflict(false)
      setError(null)
      return
    }
    if (!key || !session) return
    if (session.revision > revisionRef.current) {
      if (dirtyRef.current || savingRef.current) {
        conflictRef.current = true
        setConflict(true)
        if (sessionRef.current?.questions)
          setRecovery({ set: sessionRef.current.questions, drafts: draftsRef.current })
        setError('This Question Set changed in another tab. Copy your unsaved input and reload.')
      } else {
        revisionRef.current = session.revision
        sessionRef.current = session
        draftsRef.current = session.drafts ?? {}
        setDrafts(draftsRef.current)
      }
    }
  }, [identity, key, session?.revision, session?.drafts])

  const flush = async (): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (conflictRef.current) return false
    if (savingRef.current) {
      const inFlight = savingRef.current
      if (!await inFlight) return false
      if (savingRef.current === inFlight) savingRef.current = null
      // Another caller may already have started the next queued write.
      // Never let Submit overtake an in-flight follow-up autosave.
      return flushRef.current()
    }
    if (!dirtyRef.current) return true
    const current = sessionRef.current
    const set = current?.phase === 'questions' ? current.questions : null
    const currentKey = keyRef.current
    if (!current || !set || !currentKey) return false
    dirtyRef.current = false
    const snapshot = draftsRef.current
    const promise = (async () => {
      try {
        const saved = await saveRef.current(current, snapshot)
        if (keyRef.current !== currentKey) return false
        revisionRef.current = saved.revision
        sessionRef.current = saved
        // Set the revision *before* notifying React Query: this is our own
        // CAS acknowledgement, not a concurrent-tab conflict.
        onSavedRef.current(saved)
        return true
      } catch (cause) {
        if (keyRef.current !== currentKey) return false
        conflictRef.current = true
        setConflict(true)
        if (sessionRef.current?.questions)
          setRecovery({ set: sessionRef.current.questions, drafts: draftsRef.current })
        setError(cause instanceof Error ? cause.message : 'Question drafts could not be saved.')
        return false
      }
    })()
    savingRef.current = promise
    const saved = await promise
    if (savingRef.current === promise) savingRef.current = null
    return saved && (dirtyRef.current ? flushRef.current() : true)
  }
  flushRef.current = flush
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (dirtyRef.current && !conflictRef.current) void flushRef.current()
  }, [])
  const change = (next: Record<string, QuestionDraft>) => {
    if (conflictRef.current || !keyRef.current ||
        JSON.stringify(next) === JSON.stringify(draftsRef.current)) return
    draftsRef.current = next
    setDrafts(next)
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flushRef.current() }, 650)
  }
  return { drafts, change, flush, conflict, error, sessionRef, draftsRef,
    recovery, dismissRecovery: () => setRecovery(null) }
}
