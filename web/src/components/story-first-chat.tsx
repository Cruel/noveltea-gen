import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { EmptyStoryContext, EmptyStoryWelcome, StoryChatPrompt } from './story-first-chat-view'
import { getThreadChat } from '@/lib/thread-chat.functions'
import { previewStoryPrompt } from '@/lib/natural-story.functions'
import { sendFirstStoryTurn } from '@/lib/story-first-chat.functions'

/** Used for a Story with zero Threads and for an explicitly saved first Turn
 * that could not be admitted. Both states stay in the same Story workspace. */
export function StoryFirstChat({
  storyId,
  threadId,
  onSubmitted,
}: {
  storyId: string
  threadId?: string
  onSubmitted: (threadId: string) => Promise<void>
}) {
  const [input, setInput] = useState('')
  const [creativeMode, setCreativeMode] = useState<'autonomous' | 'collaborative'>('autonomous')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: chat, error: readError } = useQuery({
    queryKey: ['thread-chat', threadId],
    queryFn: () => getThreadChat({ data: threadId! }),
    enabled: !!threadId,
    refetchInterval: threadId ? 5000 : false,
  })
  const saved = chat?.messages.find((message) => message.role === 'user')
  const { data: preview } = useQuery({
    queryKey: ['first-turn-clarification', storyId, saved?.content],
    queryFn: () => previewStoryPrompt({ data: { storyId, prompt: saved!.content } }),
    enabled: !!saved && saved.phase === 'blocked',
  })
  const busy = sending || (!!threadId && !chat)
  const send = async (confirmed = false) => {
    const prompt = saved?.content ?? input.trim()
    if (!prompt || busy || (saved && saved.phase !== 'blocked')) return
    // Stable across transport errors and duplicate clicks. The server
    // serializes this ID before opening any provider/sandbox resources.
    const id = saved?.id ?? requestId ?? crypto.randomUUID()
    setRequestId(id)
    setSending(true)
    setError(null)
    try {
      const result = await sendFirstStoryTurn({
        data: {
          storyId,
          jobId: id,
          prompt,
          ...(saved ? saved.creativeModeOverride ? { creativeMode: saved.creativeModeOverride } : {}
            : { creativeMode }),
          ...(confirmed ? { confirmFullStory: true } : {}),
        },
      })
      if (result.message) setError(result.message)
      await onSubmitted(result.threadId)
      if (result.state === 'admitted') {
        setRequestId(null)
        setInput('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to send the saved Story message.')
    } finally {
      setSending(false)
    }
  }
  return (
    <section aria-label="Story first Chat" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-3xl gap-5">
          <EmptyStoryContext />
          {saved ? (
            <ol aria-label="Story Chat messages" className="m-0 grid gap-3 p-0">
              <li className="ml-6 list-none rounded-lg bg-secondary/70 px-3 py-2 text-sm">
                <strong className="text-xs">You</strong>
                <p className="mb-0 mt-1 whitespace-pre-wrap break-words">{saved.content}</p>
                <p className="mb-0 mt-1 text-xs text-muted-foreground">
                  {saved.phase === 'preparing' ? 'Preparing admission' : 'Saved · not yet admitted'}
                </p>
              </li>
            </ol>
          ) : (
            <EmptyStoryWelcome />
          )}
          {saved?.phase === 'blocked' && (
            <div className="space-y-2 text-sm" role="status">
              <p className="m-0 text-muted-foreground">
                {preview?.plan.clarification ??
                  'Generation has not started. Connect a Pi model and set a default in Settings, check Story repository access and native CLI/sandbox prerequisites, then retry your saved message.'}
              </p>
              <a className="text-xs underline underline-offset-2" href="/settings#ai-models">
                Model settings
              </a>
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={sending}
                  onClick={() => void send(!!preview?.plan.reviewRequired)}
                >
                  {preview?.plan.reviewRequired ? 'Confirm full-Story generation' : 'Retry saved message'}
                </Button>
              </div>
            </div>
          )}
          {saved?.phase === 'preparing' && (
            <p role="status" className="text-sm text-muted-foreground">
              The first Turn was saved and preparation is in progress or needs inspection after an
              interruption. Refresh to check for an admitted run; no second writer will be started
              automatically.
            </p>
          )}
          {(error || readError) && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? readError?.message}
            </p>
          )}
        </div>
      </div>
      {!saved && (
        <StoryChatPrompt
          value={input}
          creativeMode={creativeMode}
          onCreativeModeChange={setCreativeMode}
          busy={busy}
          sending={sending}
          onChange={(value) => {
            setInput(value)
            setError(null)
            setRequestId(null)
          }}
          onSend={() => void send()}
        />
      )}
    </section>
  )
}
