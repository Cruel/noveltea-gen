import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getThreadChat, getThreadRevisionPreview, postThreadMessage } from '@/lib/thread-chat.functions'
import type { RevisionPreview } from '@/lib/story-revision-plan'
import { ThreadMessageEdit } from './thread-message-edit'

export function ThreadChat({ threadId }: { threadId: string }) {
  const key = ['thread-chat', threadId]
  const client = useQueryClient()
  const { data, error, isFetching } = useQuery({
    queryKey: key,
    queryFn: () => getThreadChat({ data: threadId }),
    refetchInterval: query => query.state.data?.messages.some(message =>
      ['preparing', 'queued', 'running'].includes(message.phase)) ||
      query.state.data?.runs.at(-1)?.status === 'running' ? 2500 : 15000,
  })
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [pendingRetry, setPendingRetry] = useState<{ id: string; content: string } | null>(null)
  const [review, setReview] = useState<RevisionPreview | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<string[] | undefined>()
  const [proposedTargets, setProposedTargets] = useState<string[]>([])
  const submit = async (plan: RevisionPreview, approve = false) => {
    const content = message.trim()
    const id = pendingRetry?.content === content ? pendingRetry.id : crypto.randomUUID()
    setPendingRetry({ id, content })
    const result = await postThreadMessage({ data: { threadId, id, content,
      ...(selectedTargets ? { selectedTargets } : {}),
      ...(approve ? { approvalDigest: plan.digest } : {}) } })
    client.setQueryData(key, result.chat)
    setPendingRetry(null)
    setReview(null)
    setSelectedTargets(undefined)
    setMessage('')
  }
  const send = async () => {
    if (!message.trim() || sending) return
    setSending(true)
    setSendError(null)
    try {
      const plan = await getThreadRevisionPreview({ data: { threadId, content: message.trim() } })
      if (plan.reviewRequired || plan.clarification) {
        setReview(plan)
        setSelectedTargets(undefined)
        setProposedTargets(plan.targets)
      } else await submit(plan)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Story impact could not be verified.')
    } finally { setSending(false) }
  }
  const narrow = async (targets: string[]) => {
    if (sending || !targets.length) return
    setSending(true)
    setSendError(null)
    try {
      const plan = await getThreadRevisionPreview({ data: {
        threadId, content: message.trim(), selectedTargets: targets } })
      setSelectedTargets(targets)
      setReview(plan)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Cannot narrow this Story scope.')
    } finally { setSending(false) }
  }
  const approve = async () => {
    if (!review || review.clarification || sending) return
    setSending(true)
    setSendError(null)
    try { await submit(review, true) }
    catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'The approved scope could not be admitted.')
    } finally { setSending(false) }
  }
  const latest = data?.runs.at(-1)
  return <section aria-label="Thread chat" className="mt-5 min-w-0 border-t border-border pt-4">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h3 className="m-0 text-sm font-semibold">Thread chat</h3>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {isFetching && <LoaderCircle aria-label="Updating chat" className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {latest && <>Latest run: {latest.queuePhase === 'queued' ? 'queued' : latest.status}
          <Link to="/jobs/$jobId" params={{ jobId: latest.jobId }}>Inspect run</Link></>}
      </span>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    <ol className="mb-4 grid max-h-[34rem] gap-3 overflow-y-auto p-0" aria-label="Delivered messages">
      {data?.messages.map(item => <li key={item.id} className={
        'list-none rounded-md px-3 py-2 ' +
        (item.role === 'user' ? 'ml-6 bg-secondary' : 'mr-6 bg-muted/40')}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <strong>{item.role === 'user' ? 'You' : 'Assistant'}</strong>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          {item.role === 'user' && item.phase !== 'finished' &&
            <span>{item.phase === 'running' ? 'Admitted' : item.phase}</span>}
        </div>
        <p className="m-0 whitespace-pre-wrap break-words text-sm">{item.content}</p>
        {data && item.role === 'user' && item.status === 'delivered' &&
          item.phase === 'finished' && !data.archived &&
          <ThreadMessageEdit key={item.id} threadId={threadId} storyId={data.storyId}
            messageId={item.id} original={item.content}
            originalJobId={data.runs[0]?.jobId ?? null} />}
        {item.jobId && item.role === 'assistant' &&
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Run evidence</summary>
            <div className="mt-2">
              {data.evidence.filter(event => event.jobId === item.jobId).map((event, index) =>
                <p key={index} className="mb-1">
                  {event.kind}{event.stage ? ' · ' + event.stage : ''}
                  {event.milestone ? ' · ' + event.milestone : ''}
                  {event.status ? ' · ' + event.status : ''}
                  {event.files.length ? ' · ' + event.files.join(', ') : ''}
                </p>)}
              <Link to="/jobs/$jobId" params={{ jobId: item.jobId }}>Inspect saved job and receipts</Link>
            </div>
          </details>}
      </li>)}
    </ol>
    {data && !data.messages.length && <p className="text-sm text-muted-foreground">
      No delivered messages yet. Generation requests appear here once submitted.
    </p>}
    {review && <section aria-label="Story revision scope review"
      className="mb-3 rounded-md border border-border p-3 text-sm">
      <strong>Review Story revision scope</strong>
      <p className="mt-1 text-muted-foreground">{review.clarification ??
        'Only the selected existing files will be writable. Linked context remains read-only.'}</p>
      {review.targets.length > 0 && <>
        <p className="mt-2 text-xs text-muted-foreground">Authorized targets · {review.depth} depth</p>
        <div className="mt-1 grid gap-1">
          {proposedTargets.map(target => <label key={target} className="flex items-center gap-2">
            <input type="checkbox" checked={(selectedTargets ?? proposedTargets).includes(target)}
              disabled={sending} onChange={event => {
                const next = event.target.checked
                  ? [...(selectedTargets ?? proposedTargets), target]
                  : (selectedTargets ?? proposedTargets).filter(id => id !== target)
                void narrow(next)
              }} />{target}
          </label>)}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Write paths: {review.writePaths.join(', ')}</p>
        {!!review.readOnlyIds.length && <p className="mt-1 text-xs text-muted-foreground">
          Read-only context: {review.readOnlyIds.join(', ')}</p>}
      </>}
      {review.rationale.map(reason => <p key={reason} className="mt-1 text-xs text-muted-foreground">{reason}</p>)}
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" disabled={sending || !!review.clarification || !review.targets.length}
          onClick={() => void approve()}>Approve scoped revision</Button>
        <Button type="button" size="sm" variant="outline" disabled={sending}
          onClick={() => { setReview(null); setSelectedTargets(undefined) }}>Edit request</Button>
      </div>
    </section>}
    {sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}
    {data?.archived && <p className="text-xs text-muted-foreground">Restore this Thread to send a message.</p>}
    <form onSubmit={event => { event.preventDefault(); void send() }} className="flex min-w-0 items-end gap-2">
      <textarea aria-label="Follow-up message" rows={2} maxLength={4000} value={message}
        onChange={event => { setMessage(event.target.value); setPendingRetry(null); setReview(null); setSelectedTargets(undefined) }} disabled={sending || data?.archived}
        placeholder="Describe a revision to an existing Character, Event, or Milestone…"
        className="min-w-0 flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
      <Button type="submit" size="sm" disabled={sending || !message.trim() || !data || data.archived}>
        {sending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Send className="size-4" />}
        Send
      </Button>
    </form>
    <p className="mt-2 text-xs text-muted-foreground">
      Every revision is checked against canonical Story relationships and the verified source commit.
      Material expansions require explicit scope review. Unrelated records stay read-only; each run has its own budget.
    </p>
  </section>
}
