import { useEffect, useRef, useState } from 'react'
import type { QuestionDraft, QuestionSet } from '../../../src/author-question-set'

type DraftSession = {
  phase: string; revision: number; questions: QuestionSet | null
  drafts?: Record<string, QuestionDraft>
}

/** Shared, owner-bound draft lifecycle for both first-Thread and repository discovery.
 * Draft writes use the session revision CAS; neither autosave nor default selections
 * constitute a submitted answer or any authority to write Story canon. */
export function useQuestionSetDrafts<S extends DraftSession>({ session, identity, save, onSaved }: {
  session: S | null | undefined; identity: string
  save: (current: S, drafts: Record<string, QuestionDraft>) => Promise<S>
  onSaved: (saved: S) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftsRef = useRef(drafts)
  const sessionRef = useRef<S | null>(null)
  const setRef = useRef<string | null>(null)
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
  if (session && (!sessionRef.current || session.revision >= sessionRef.current.revision))
    sessionRef.current = session

  useEffect(() => {
    const set = session?.phase === 'questions' ? session.questions : null
    const id = set?.id ?? null
    if (id === setRef.current) {
      if (id && session && session.revision > revisionRef.current) {
        if (dirtyRef.current || savingRef.current) {
          conflictRef.current = true
          setConflict(true)
          setError('This Question Set changed in another tab. Copy your unsaved input and reload.')
        } else {
          revisionRef.current = session.revision
          draftsRef.current = session.drafts ?? {}
          setDrafts(draftsRef.current)
        }
      }
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    setRef.current = id
    revisionRef.current = session?.revision ?? 0
    draftsRef.current = session?.drafts ?? {}
    setDrafts(draftsRef.current)
    dirtyRef.current = false
    conflictRef.current = false
    setConflict(false)
    setError(null)
  }, [identity, session?.phase, session?.questions, session?.revision])

  const flush = async (): Promise<boolean> => {
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
    if (!current || !set || set.id !== setRef.current) return false
    dirtyRef.current = false
    const snapshot = draftsRef.current
    const promise = (async () => {
      try {
        const saved = await saveRef.current(current, snapshot)
        sessionRef.current = saved
        revisionRef.current = saved.revision
        onSavedRef.current(saved)
        return true
      } catch (cause) {
        conflictRef.current = true
        setConflict(true)
        setError(cause instanceof Error ? cause.message : 'Question drafts could not be saved.')
        return false
      }
    })()
    savingRef.current = promise
    const saved = await promise
    if (savingRef.current === promise) savingRef.current = null
    return saved && (dirtyRef.current ? flush() : true)
  }
  flushRef.current = flush
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (dirtyRef.current && !conflictRef.current) void flushRef.current()
  }, [])
  const change = (next: Record<string, QuestionDraft>) => {
    if (conflictRef.current || JSON.stringify(next) === JSON.stringify(draftsRef.current)) return
    draftsRef.current = next
    setDrafts(next)
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flushRef.current() }, 650)
  }
  return { drafts, change, flush, conflict, error, sessionRef, draftsRef }
}
