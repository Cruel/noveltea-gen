import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { actStoryChatDiscovery, readStoryChatDiscovery } from '@/lib/story-chat-discovery.functions'
import { storyNavigationKey } from '@/lib/threads.queries'
import { StoryChatBaselineView, type BaselineAction, type BaselineContinuation, type StoryChatBaselineSession } from './story-chat-baseline-view'

/** The ordinary first Thread owns discovery. All decisions and model turns are
 * read from its durable, server-authorized pinned session. */
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
  const act = async (action: BaselineAction) => {
    if (!session || busy) return
    setBusy(true); setError(null)
    try {
      const response = await actStoryChatDiscovery({ data: {
        storyId, firstTurnId, action, revision: session.revision,
        ...(action === 'answer' || action === 'revise' ? { text: answer } : {}),
        ...(action === 'approve' || action === 'continue' ? { digest: session.digest ?? undefined } : {}),
      } })
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
    onAnswerChange={setAnswer} busy={busy}
    error={error ?? (query.error instanceof Error ? query.error.message : null)}
    onAction={action => void act(action)} />
}
