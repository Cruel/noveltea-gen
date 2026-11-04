import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { jobEventsKey, jobEventsQuery, mergeJobEvents, type JobEventHistory } from '@/lib/job-events.queries'
import type { ProgressEvent } from '@/lib/generation-progress.server'

export type StreamConnection = 'connecting' | 'connected' | 'reconnecting'

function safeProgressEvent(value: unknown): value is ProgressEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ProgressEvent>
  return Number.isSafeInteger(event.id) && (event.id ?? 0) > 0 &&
    ['started', 'working', 'verified', 'finished', 'interrupted'].includes(event.kind ?? '') &&
    Array.isArray(event.files) && event.files.length <= 24 &&
    event.files.every(file => typeof file === 'string') &&
    typeof event.createdAt === 'string'
}

/** One SSE connection for the entire job page, regardless of the selected tab.
 * Cached history is available before the connection starts and stays across tab switches. */
export function useJobEventStream(jobId: string, activityVisible: boolean) {
  const queryClient = useQueryClient()
  const { data: history, error: historyError } = useQuery(jobEventsQuery(jobId))
  const historyReady = history !== undefined
  const [connection, setConnection] = useState<StreamConnection>('connecting')
  const [unread, setUnread] = useState(0)
  const [latestUpdate, setLatestUpdate] = useState<ProgressEvent | null>(null)
  const activityVisibleRef = useRef(activityVisible)
  activityVisibleRef.current = activityVisible

  useEffect(() => {
    if (activityVisible) setUnread(0)
  }, [activityVisible])

  useEffect(() => {
    // The SSR/persisted snapshot must be in Query before we choose the cursor.
    if (!historyReady) return
    const initial = queryClient.getQueryData<JobEventHistory>(jobEventsKey(jobId))
    const cursor = initial?.events.at(-1)?.id ?? 0
    const source = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events?after=' + cursor)
    setConnection('connecting')
    setUnread(0)
    setLatestUpdate(null)
    source.onopen = () => setConnection('connected')
    source.onerror = () => setConnection('reconnecting')
    const receive = (message: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(message.data)
        if (!safeProgressEvent(parsed)) return
        const event = parsed
        let received = false
        queryClient.setQueryData<JobEventHistory>(jobEventsKey(jobId), current => {
          if (!current || current.events.some(previous => previous.id === event.id)) return current
          received = true
          return { ...current, events: mergeJobEvents(current.events, [event]) }
        })
        if (!received) return
        setLatestUpdate(event)
        if (!activityVisibleRef.current) setUnread(count => count + 1)
        if (event.kind === 'started' || event.kind === 'verified' ||
            event.kind === 'finished' || event.kind === 'interrupted') {
          // Milestones can change the verified commit, job state, and available actions.
          void queryClient.invalidateQueries({ queryKey: ['job', jobId] })
          void queryClient.invalidateQueries({ queryKey: ['job-controls', jobId] })
          void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
          if (event.kind === 'finished' || event.kind === 'interrupted')
            void queryClient.invalidateQueries({ queryKey: ['author-interactions', jobId] })
        }
      } catch { /* Ignore unexpected SSE frames; never expose raw stream payloads. */ }
    }
    source.addEventListener('progress', receive)
    return () => {
      source.removeEventListener('progress', receive)
      source.close()
    }
    // Re-subscribe only when the job identity changes or its first snapshot loads.
    // Changing tabs or receiving another event must not reopen the connection.
  }, [jobId, historyReady, queryClient])

  return { connection, unread, latestUpdate, historyError }
}
