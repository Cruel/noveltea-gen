import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { EmptyStoryContext, EmptyStoryWelcome, StoryChatPrompt } from './story-first-chat-view'
import { getThreadChat } from '@/lib/thread-chat.functions'
import { sendFirstStoryTurn } from '@/lib/story-first-chat.functions'
import { previewStoryPrompt } from '@/lib/natural-story.functions'
import type { NaturalStoryPlan } from '@/lib/natural-story-plan'
import { readStoryChatDiscovery } from '@/lib/story-chat-discovery.functions'
import { StoryChatBaseline } from './story-chat-baseline'

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
  const [scopePreview, setScopePreview] = useState<{
    prompt: string; headSha: string; plan: NaturalStoryPlan
  } | null>(null)
  const { data: chat, error: readError } = useQuery({
    queryKey: ['thread-chat', threadId],
    queryFn: () => getThreadChat({ data: threadId! }),
    enabled: !!threadId,
    refetchInterval: threadId ? 5000 : false,
  })
  const saved = chat?.messages.find((message) => message.role === 'user')
  const { data: discovery } = useQuery({
    queryKey: ['story-chat-discovery', storyId, threadId?.slice('root:'.length)],
    queryFn: () => readStoryChatDiscovery({ data: {
      storyId, firstTurnId: threadId!.slice('root:'.length),
    } }),
    enabled: !!threadId && !!saved,
    refetchInterval: threadId ? 5000 : false,
  })
  const busy = sending || (!!threadId && !chat)
  const send = async (approveScope = false) => {
    const prompt = saved?.content ?? input.trim()
    if (!prompt || busy || (saved && saved.phase !== 'blocked')) return
    // Stable across transport errors and duplicate clicks. No Chat request
    // or Pi writer is reserved before a required reviewed scope is approved.
    const id = saved?.id ?? requestId ?? crypto.randomUUID()
    setRequestId(id)
    setSending(true)
    setError(null)
    try {
      let current = scopePreview?.prompt === prompt ? scopePreview : null
      if (!saved && !current) {
        const result = await previewStoryPrompt({ data: { storyId, jobId: id, prompt } })
        current = { prompt, headSha: result.headSha, plan: result.plan }
        setScopePreview(current)
        if (current.plan.clarification || current.plan.reviewRequired) return
      }
      if (!saved && current?.plan.clarification) return
      if (!saved && current?.plan.reviewRequired && !approveScope) return
      const result = await sendFirstStoryTurn({
        data: {
          storyId,
          jobId: id,
          prompt,
          ...(!saved && approveScope && current?.plan.reviewRequired
            ? { approvedDigest: current.plan.digest } : {}),
          ...(saved ? saved.creativeModeOverride ? { creativeMode: saved.creativeModeOverride } : {}
            : { creativeMode }),
        },
      })
      if (result.message) setError(result.message)
      await onSubmitted(result.threadId)
      if (result.state === 'admitted' || result.state === 'discovery' || result.state === 'completed') {
        setRequestId(null)
        setInput('')
        setScopePreview(null)
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
                  {saved.phase === 'preparing' ? 'Preparing discovery' : 'Original request saved'}
                </p>
              </li>
            </ol>
          ) : (
            <EmptyStoryWelcome />
          )}
          {threadId && saved && <StoryChatBaseline storyId={storyId} threadId={threadId} />}
          {!saved && scopePreview && <section aria-label="First Turn scope review"
            className="space-y-2 rounded-md bg-muted/30 p-3 text-sm">
            {scopePreview.plan.clarification ? (
              <p role="alert" className="m-0">{scopePreview.plan.clarification}
                {' '}Edit the message below to specify the missing details.</p>
            ) : <>
              <p className="m-0 font-medium">Review the proposed scope before starting</p>
              <p className="m-0">
                {scopePreview.plan.contract.scope.kind === 'partial'
                  ? 'Focused Story addition'
                  : 'Whole Story generation'}
                {' · '}{scopePreview.plan.stages.length} stages
              </p>
              {scopePreview.plan.contract.scope.kind === 'partial' && <p className="m-0 text-xs text-muted-foreground">
                Authorized records: {scopePreview.plan.contract.scope.targets.join(', ')}
              </p>}
              <p className="m-0 text-xs text-muted-foreground">
                Source revision: {scopePreview.headSha.slice(0, 12)}. A preview does not grant write authority.
              </p>
              {scopePreview.plan.reviewRequired &&
                <Button size="sm" type="button" disabled={busy}
                  onClick={() => void send(true)}>Approve scope and start</Button>}
            </>}
          </section>}
          {saved?.phase === 'blocked' && discovery?.session == null && (
            <div className="space-y-2 text-sm" role="status">
              <p className="m-0 text-muted-foreground">
                If discovery has not started, connect a Pi model and select a default in Settings,
                then retry the saved request. Existing discovery turns must be resumed using their
                controls above; they are never replayed automatically.
              </p>
              <a className="text-xs underline underline-offset-2" href="/settings#ai-models">Model settings</a>
              <div><Button type="button" size="sm" disabled={sending} onClick={() => void send()}>
                Retry request
              </Button></div>
            </div>
          )}
          {saved?.phase === 'preparing' && (
            <p role="status" className="text-sm text-muted-foreground">
              The initial request was reserved. Refresh to inspect its discovery session; no
              duplicate model turn or writer will start automatically.
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
          onCreativeModeChange={mode => {
            setCreativeMode(mode)
            setScopePreview(null)
            setRequestId(null)
          }}
          busy={busy}
          sending={sending}
          sendDisabled={!!scopePreview && scopePreview.prompt === input.trim() &&
            (!!scopePreview.plan.clarification || scopePreview.plan.reviewRequired)}
          onChange={(value) => {
            setInput(value)
            setError(null)
            setRequestId(null)
            setScopePreview(null)
          }}
          onSend={() => void send()}
        />
      )}
    </section>
  )
}
