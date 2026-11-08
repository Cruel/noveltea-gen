import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getThreadChat, getThreadRevisionPreview, postThreadMessage, cancelThreadMessage,
  editThreadQueuedMessage, postThreadProtectedDecision } from '@/lib/thread-chat.functions'
import type { RevisionPreview } from '@/lib/story-revision-plan'
import { ThreadMessageEdit } from './thread-message-edit'
import { ThreadRunAttention } from './thread-run-attention'
import { ThreadRunActivity } from './thread-run-activity'
import { canSendThreadFollowUp } from '@/lib/thread-attention'
import { setCreativeMode } from '@/lib/threads.functions'
import type { CreativeMode } from '../../../src/creative-policy'

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
  const [liveMode, setLiveMode] = useState<'steer' | 'follow-up'>('follow-up')
  const [modeOverride, setModeOverride] = useState<'default' | CreativeMode>('default')
  const [modeSaving, setModeSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [pendingRetry, setPendingRetry] = useState<{ id: string; content: string;
    creativeMode?: CreativeMode } | null>(null)
  const [queuedEdit, setQueuedEdit] = useState<{ id: string; original: string; text: string;
    requestId: string } | null>(null)
  const [review, setReview] = useState<RevisionPreview | null>(null)
  const [reviewQueued, setReviewQueued] = useState<{ id: string; content: string } | null>(null)
  const [selectedTargets, setSelectedTargets] = useState<string[] | undefined>()
  const [proposedTargets, setProposedTargets] = useState<string[]>([])
  const submit = async (plan: RevisionPreview, approve = false) => {
    const content = reviewQueued?.content ?? message.trim()
    const id = reviewQueued?.id ?? (pendingRetry?.content === content ? pendingRetry.id : crypto.randomUUID())
    const creativeMode = data?.messages.find(item => item.id === id)?.creativeModeOverride ??
      (modeOverride === 'default' ? undefined : modeOverride)
    setPendingRetry({ id, content, creativeMode })
    const result = await postThreadMessage({ data: { threadId, id, content,
      ...(selectedTargets ? { selectedTargets } : {}),
      ...(approve ? { approvalDigest: plan.digest } : {}),
      ...(creativeMode ? { creativeMode } : {}) } })
    client.setQueryData(key, result.chat)
    setPendingRetry(null)
    setReview(null)
    setReviewQueued(null)
    setSelectedTargets(undefined)
    setMessage('')
  }
  const send = async () => {
    if (!message.trim() || sending || !canSendThreadFollowUp(data?.runs.at(-1)?.status, !!data?.archived)) return
    setSending(true)
    setSendError(null)
    try {
      // Reserve on the server BEFORE any asynchronous Story scope preview.
      // Two tabs can submit against a completed Thread without a stale preview
      // rejecting the later message or granting it the earlier author's scope.
      const content = message.trim()
      const creativeMode = modeOverride === 'default' ? undefined : modeOverride
      const id = pendingRetry?.content === content && pendingRetry.creativeMode === creativeMode
        ? pendingRetry.id : crypto.randomUUID()
      setPendingRetry({ id, content, creativeMode })
      const active = data?.runs.at(-1)
      const mode = active?.status === 'running' && !active.fixture ? liveMode : undefined
      const result = await postThreadMessage({ data: { threadId, id, content,
        ...(mode ? { liveMode: mode } : {}),
        ...(creativeMode ? { creativeMode } : {}) } })
      client.setQueryData(key, result.chat)
      setPendingRetry(null)
      setMessage('')
      setModeOverride('default')
      const candidate = result.chat.messages.find(item => item.id === id)
      const firstQueued = result.chat.messages.filter(item => item.role === 'user' && item.phase === 'queued' && item.liveMode !== 'steer')
        .sort((a, b) => a.queuePriority - b.queuePriority || a.sequence - b.sequence)[0]
      const currentRun = result.chat.runs.at(-1)
      if (candidate?.phase === 'queued' && !candidate.hasRevisionScope &&
          firstQueued?.id === id && currentRun?.status === 'completed' &&
          currentRun.queuePhase === 'finished') {
        // Material or ambiguous requests are already safely queued. Offer the
        // preview immediately; if the source changes, normal queued review
        // remains available instead of losing the author's instruction.
        try {
          const plan = await getThreadRevisionPreview({ data: { threadId, content, messageId: id } })
          setReviewQueued({ id, content })
          setReview(plan)
          setSelectedTargets(undefined)
          setProposedTargets(plan.targets)
        } catch { /* The retained queue item remains reviewable after its predecessor settles. */ }
      }
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Story impact could not be verified.')
      // Admission may already have reserved an instruction before validation
      // failed. Refresh so its cancellation/review controls remain visible.
      await client.invalidateQueries({ queryKey: key })
    } finally { setSending(false) }
  }
  const narrow = async (targets: string[]) => {
    if (sending || !targets.length) return
    setSending(true)
    setSendError(null)
    try {
      const plan = await getThreadRevisionPreview({ data: {
        threadId, content: reviewQueued?.content ?? message.trim(), selectedTargets: targets,
        ...(reviewQueued ? { messageId: reviewQueued.id } : {}) } })
      setSelectedTargets(targets)
      setReview(plan)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Cannot narrow this Story scope.')
    } finally { setSending(false) }
  }
  const reviewQueuedMessage = async (item: { id: string; content: string }) => {
    if (sending) return
    setSending(true)
    setSendError(null)
    try {
      const plan = await getThreadRevisionPreview({ data: {
        threadId, content: item.content, messageId: item.id } })
      setReviewQueued(item)
      setReview(plan)
      setSelectedTargets(undefined)
      setProposedTargets(plan.targets)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Queued scope cannot yet be reviewed.')
    } finally { setSending(false) }
  }
  const cancelQueued = async (id: string) => {
    if (sending) return
    setSending(true)
    setSendError(null)
    try {
      const result = await cancelThreadMessage({ data: { threadId, messageId: id } })
      client.setQueryData(key, result.chat)
      if (queuedEdit?.id === id) setQueuedEdit(null)
      if (reviewQueued?.id === id) {
        setReview(null)
        setReviewQueued(null)
        setSelectedTargets(undefined)
      }
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Queued instruction could not be cancelled.')
      await client.invalidateQueries({ queryKey: key })
    } finally { setSending(false) }
  }
  const saveQueuedEdit = async () => {
    if (!queuedEdit || !queuedEdit.text.trim() || sending) return
    setSending(true); setSendError(null)
    try {
      const result = await editThreadQueuedMessage({ data: {
        threadId, messageId: queuedEdit.id, requestId: queuedEdit.requestId,
        expected: queuedEdit.original, replacement: queuedEdit.text,
      } })
      client.setQueryData(key, result.chat)
      if (reviewQueued?.id === queuedEdit.id) {
        setReview(null); setReviewQueued(null); setSelectedTargets(undefined)
      }
      setQueuedEdit(null)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Queued edit was not accepted.')
      await client.invalidateQueries({ queryKey: key })
    } finally { setSending(false) }
  }
  const protectedDecision = async (decision: 'approved' | 'rejected') => {
    if (!review?.protectedChange || !reviewQueued || sending) return
    setSending(true); setSendError(null)
    try {
      const result = await postThreadProtectedDecision({ data: {
        threadId, messageId: reviewQueued.id, content: reviewQueued.content,
        digest: review.digest, decision,
      } })
      client.setQueryData(key, result.chat)
      setReview(null); setReviewQueued(null); setSelectedTargets(undefined)
      setPendingRetry(null)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'The protected change could not be authorized.')
      await client.invalidateQueries({ queryKey: key })
    } finally { setSending(false) }
  }
  const approve = async () => {
    if (!review || review.clarification || sending) return
    if (review.protectedChange) { await protectedDecision('approved'); return }
    setSending(true)
    setSendError(null)
    try { await submit(review, true) }
    catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'The approved scope could not be admitted.')
      await client.invalidateQueries({ queryKey: key })
    } finally { setSending(false) }
  }
  const latest = data?.runs.at(-1)
  const scrollRegion = useRef<HTMLDivElement>(null)
  const previousCount = useRef(0)
  const followProgress = useCallback(() => {
    const region = scrollRegion.current
    if (region && region.scrollHeight - region.scrollTop - region.clientHeight < 160)
      region.scrollTop = region.scrollHeight
  }, [])
  useEffect(() => {
    const region = scrollRegion.current
    const count = data?.messages.length ?? 0
    if (region && (previousCount.current === 0 ||
      region.scrollHeight - region.scrollTop - region.clientHeight < 160))
      region.scrollTop = region.scrollHeight // Instant scrolling respects reduced-motion.
    previousCount.current = count
  }, [data?.messages.length, latest?.status])
  const canSend = canSendThreadFollowUp(latest?.status, !!data?.archived)
  return <section aria-label="Thread chat" className="flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0">
    <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-2 text-xs text-muted-foreground">
      <label className="inline-flex items-center gap-2">Thread mode
        <select aria-label="Thread default creative mode" value={data?.creativePolicy.mode ?? 'autonomous'}
          disabled={!data || modeSaving || !!data.archived}
          onChange={async event => {
            const mode = event.target.value as CreativeMode
            setModeSaving(true)
            try {
              await setCreativeMode({ data: { threadId, mode } })
              await client.invalidateQueries({ queryKey: key })
            } catch (cause) {
              setSendError(cause instanceof Error ? cause.message : 'Creative mode could not be saved.')
            } finally { setModeSaving(false) }
          }} className="rounded border border-input bg-background px-2 py-1 text-foreground">
          <option value="autonomous">Autonomous</option>
          <option value="collaborative">Collaborative</option>
        </select>
      </label>
      {isFetching && <LoaderCircle aria-label="Updating chat" className="size-3.5 animate-spin motion-reduce:animate-none" />}
      {latest && <span aria-label="Latest run status">{latest.queuePhase === 'queued' ? 'Queued' : latest.status.replaceAll('-', ' ')}</span>}
      {latest && <Link to="/jobs/$jobId" params={{ jobId: latest.jobId }}
        className="underline-offset-2 hover:underline">Run details</Link>}
    </div>
    {error && <p role="alert" className="px-4 text-sm text-destructive">{error.message}</p>}
    <div ref={scrollRegion} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
    <ol className="mx-auto grid w-full max-w-3xl gap-4 p-0" aria-label="Delivered messages">
      {data?.messages.filter(item => !(item.role === 'assistant' && item.jobId &&
        data.runs.some(run => run.jobId === item.jobId &&
          ['blocked', 'interrupted'].includes(run.status)) &&
        item.content.startsWith('Generation blocked.'))).map(item => <Fragment key={item.id}>
        <li className={
        'list-none rounded-lg px-3 py-2 ' +
        (item.role === 'user' ? 'ml-6 bg-secondary/70' : 'mr-6 bg-muted/30')}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <strong>{item.role === 'user' ? 'You' : 'Assistant'}</strong>
          {item.role === 'user' && data.turnReceipts.find(turn => turn.id === item.id)?.creativePolicy &&
            <span aria-label="Turn creative mode">{data.turnReceipts.find(turn => turn.id === item.id)!.creativePolicy.mode}</span>}
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          {item.role === 'user' && item.phase === 'cancelled' ? <span>Cancelled</span> :
           item.role === 'user' && item.liveMode === 'follow-up'
            ? <span>{item.phase === 'running' ? 'Turn running' :
                item.phase === 'finished' ? 'Turn verified' :
                item.phase === 'blocked' ? 'Turn blocked · review source' :
                item.hasRevisionScope ? 'Next Turn · reviewed scope' : 'Next Turn · waiting for verified checkpoint / scope review'}</span> :
           item.role === 'user' && item.liveMode === 'steer'
            ? <span>{item.effectVerifiedAt ? 'Effect independently verified' :
                item.liveState === 'delivered' ? 'Pi acknowledged · effect not independently verified' :
                item.liveState === 'sdk-queued' ? 'Sent to Pi · awaiting acknowledgement' :
                item.liveState === 'dispatching' ? 'Sending to Pi · delivery unresolved' :
                item.liveState === 'blocked' ? 'Delivery uncertain — inspect job' :
                item.liveState === 'deferred' ? 'Pending coordinator routing' :
                'Queued for the current Pi turn'}</span>
            : item.role === 'user' && item.phase !== 'finished' &&
              <span>{item.phase === 'running' ? 'Admitted' : item.phase}</span>}
        </div>
        <p className="m-0 whitespace-pre-wrap break-words text-sm">{item.content}</p>
        {data?.steeringActivity.filter(activity => activity.messageId === item.id).map(activity =>
          <div key={activity.messageId} className="mt-2 text-xs text-muted-foreground">
            <p className="m-0">Controller: {activity.disposition === 'within-scope' ? 'Within assigned scope' :
              activity.disposition === 'scope-review' ? 'Additional Story scope needs approval' :
              activity.disposition === 'protected-review' ? 'Protected decision requires separate authorization' :
              'Intent unresolved; no additional scope authorized'} · {activity.state.replaceAll('-', ' ')}</p>
            {activity.checkpointSha ? <p className="mt-1">
              Verified checkpoint {activity.checkpointSha.slice(0, 12)} · {activity.checkpointWorkItem} ·
              causal influence only, not editorial fulfillment
            </p> : <p className="mt-1">No attributable verified checkpoint yet</p>}
            {activity.implementationSha && <p className="mt-1">Approved continuation: {activity.implementationCount} verified work-item checkpoint(s), latest {activity.implementationSha.slice(0, 12)}. Structural implementation evidence only.</p>}
            {activity.verifiedEffectAt && <p className="mt-1">Independent effect verified: {new Date(activity.verifiedEffectAt).toLocaleString()}</p>}
            {activity.reviewMessageId && <p className="mt-1">Continuation queued for explicit scope review (linked to this instruction).</p>}
          </div>)}
        {item.role === 'user' && data?.steeringActivity.some(activity => activity.reviewMessageId === item.id) &&
          <p className="mt-1 text-xs text-muted-foreground">Scope-review continuation from a previous delivered steer; approval required before a new writer can start.</p>}
        {item.editCount > 0 && <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Edited {item.editCount} {item.editCount === 1 ? 'time' : 'times'} before delivery · view history</summary>
          <ol className="ml-4 mt-1 list-decimal space-y-1">
            {item.editHistory?.map((edit, index) => <li key={index}>
              <time dateTime={edit.editedAt}>{new Date(edit.editedAt).toLocaleString()}</time>
              <p className="whitespace-pre-wrap break-words">Before: {edit.old}</p>
              <p className="whitespace-pre-wrap break-words">After: {edit.replacement}</p>
            </li>)}
          </ol>
        </details>}
        {item.liveMode === 'steer' && (item.livePiSessionId || item.liveWorkItem || item.liveDeliveredAt) &&
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Pi delivery provenance</summary>
            <p>Source run: {item.liveSourceJobId}</p>
            {item.liveWorkItem && <p>Assigned specialist: {item.liveWorkItem}</p>}
            {item.livePiSessionId && <p>Pi session: {item.livePiSessionId}</p>}
            {item.liveDeliveredAt && <p>Acknowledged: {new Date(item.liveDeliveredAt).toLocaleString()}</p>}
            {item.effectVerifiedAt && <p>Independent review: {item.effectReviewer} · {item.effectCommitSha} · {item.effectEvidence}</p>}
          </details>}
        {queuedEdit?.id === item.id && <div className="mt-2 grid gap-2">
          <textarea aria-label="Edit queued instruction" rows={3} maxLength={4000}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            value={queuedEdit.text} disabled={sending}
            onChange={event => setQueuedEdit({ ...queuedEdit, text: event.target.value })} />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={sending || !queuedEdit.text.trim()}
              onClick={() => void saveQueuedEdit()}>Save edit</Button>
            <Button type="button" size="sm" variant="ghost" disabled={sending}
              onClick={() => setQueuedEdit(null)}>Close</Button>
          </div>
        </div>}
        {item.role === 'user' && item.phase === 'queued' && !data?.archived &&
          !['dispatching', 'sdk-queued'].includes(item.liveState ?? '') &&
          <div className="mt-2 flex flex-wrap gap-2">
            {item.liveMode !== 'steer' && !item.hasRevisionScope && latest?.status === 'completed' && latest.queuePhase === 'finished' &&
              item.id === data?.messages.filter(m => m.role === 'user' && m.phase === 'queued' && m.liveMode !== 'steer')
                .sort((a, b) => a.queuePriority - b.queuePriority || a.sequence - b.sequence)[0]?.id &&
              <Button type="button" size="sm" variant="outline" disabled={sending}
                onClick={() => void reviewQueuedMessage(item)}>Review queued scope</Button>}
            <Button type="button" size="sm" variant="outline" disabled={sending}
              onClick={() => setQueuedEdit({ id: item.id, original: item.content,
                text: item.content, requestId: crypto.randomUUID() })}>Edit queued</Button>
            <Button type="button" size="sm" variant="ghost" disabled={sending}
              onClick={() => void cancelQueued(item.id)}>Withdraw</Button>
          </div>}
        {item.phase === 'cancelled' && item.cancelledAt &&
          <p className="mt-1 text-xs text-muted-foreground">Cancelled at {new Date(item.cancelledAt).toLocaleString()}. Original request retained for history.</p>}
        {data && item.role === 'user' && item.liveMode !== 'steer' && item.status === 'delivered' &&
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
      </li>
      {data && item.role === 'user' && item.jobId &&
        data.runs.some(run => run.jobId === item.jobId) &&
        data.messages.find(message => message.role === 'user' &&
          message.jobId === item.jobId)?.id === item.id && <li data-slot="thread-activity-item" className="list-none border-0 p-0">
        <ThreadRunActivity jobId={item.jobId}
          status={data.runs.find(run => run.jobId === item.jobId)!.status}
          onProgress={followProgress} />
      </li>}
      </Fragment>)}
    </ol>
    {data?.runs.filter(run => !data.messages.some(message =>
      message.role === 'user' && message.jobId === run.jobId)).map(run =>
      <div key={run.jobId} className="mx-auto max-w-3xl">
        <ThreadRunActivity jobId={run.jobId} status={run.status} onProgress={followProgress} />
      </div>)}
    {data && !data.messages.length && <p className="mx-auto max-w-3xl text-sm text-muted-foreground">
      No messages yet. Describe what you want NovelTea to create.
    </p>}
    {latest && <div className="mx-auto mt-4 w-full max-w-3xl">
      <ThreadRunAttention key={latest.jobId} run={latest} />
    </div>}
    {review && <section aria-label="Story revision scope review"
      className="mx-auto mt-4 w-full max-w-3xl rounded-md border border-border p-3 text-sm">
      <strong>Review Story revision scope</strong>
      <p className="mt-1 text-muted-foreground">{review.clarification ??
        (review.protectedChange
          ? 'This changes author-protected Story canon. Scope approval or a prior Thread approval is insufficient; review the exact difference below.'
          : 'Only the selected existing files will be writable. Linked context remains read-only.')}</p>
      {review.protectedConflict && <div className="mt-3 grid gap-2 text-sm">
        <p className="m-0 text-xs text-muted-foreground">Possible protected contradiction · {review.protectedConflict.decision}</p>
        <div><strong>Current protected statement</strong>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.protectedConflict.before}</p></div>
        <div><strong>Requested direction (not approved canonical text)</strong>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.protectedConflict.requestedDirection}</p></div>
        <p className="text-xs text-muted-foreground">A source-bound exact replacement is required. No writes or approvals are granted by this detection.</p>
      </div>}
      {review.protectedChange && <div className="mt-3 grid gap-2 text-sm">
        <p className="m-0 text-xs text-muted-foreground">
          {review.protectedChange.decision} · {review.protectedChange.path} · source {review.headSha.slice(0, 12)}
        </p>
        <div><strong>Current protected statement</strong>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.protectedChange.before}</p></div>
        <div><strong>Exact proposed replacement</strong>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.protectedChange.after}</p></div>
        <p className="text-xs text-muted-foreground">Approval applies only to this change in a new isolated Thread run. It does not authorize other retcons or transfer a parent's approval.</p>
      </div>}
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
        <Button type="button" size="sm" disabled={sending || !!review.clarification ||
            (!review.targets.length && !review.protectedChange)}
          onClick={() => void approve()}>{review.protectedChange ? 'Authorize exact protected change' : 'Approve scoped revision'}</Button>
        {review.protectedChange && <Button type="button" size="sm" variant="outline"
          disabled={sending} onClick={() => void protectedDecision('rejected')}>Reject change</Button>}
        <Button type="button" size="sm" variant="outline" disabled={sending}
          onClick={() => { setReview(null); setReviewQueued(null); setSelectedTargets(undefined) }}>
          {reviewQueued ? 'Close review' : 'Edit request'}
        </Button>
        {reviewQueued && <Button type="button" size="sm" variant="ghost" disabled={sending}
          onClick={() => void cancelQueued(reviewQueued.id)}>Cancel queued instruction</Button>}
      </div>
    </section>}
    </div>
    <div className="border-t border-border/50 bg-background px-4 py-3">
    {sendError && <p role="alert" className="mx-auto max-w-3xl text-sm text-destructive">{sendError}</p>}
    {data?.archived && <p className="mx-auto max-w-3xl text-xs text-muted-foreground">Restore this Thread to send a message.</p>}
    {latest && !canSend && !data?.archived && <p role="status"
      className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground">
      {latest.status === 'paused' ? 'Resolve the saved question or resume generation before sending another instruction.' :
        'This run cannot accept follow-ups. Use the recovery actions above to continue safely.'}
    </p>}
    {latest?.status === 'running' && !latest.fixture && !data?.archived &&
      <div role="group" aria-label="Live message delivery" className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2 text-xs">
        <Button type="button" size="sm" variant={liveMode === 'steer' ? 'secondary' : 'outline'}
          aria-pressed={liveMode === 'steer'} disabled={sending} onClick={() => setLiveMode('steer')}>
          Steer current work · next safe Pi boundary</Button>
        <Button type="button" size="sm" variant={liveMode === 'follow-up' ? 'secondary' : 'outline'}
          aria-pressed={liveMode === 'follow-up'} disabled={sending} onClick={() => setLiveMode('follow-up')}>
          Queue next Turn · after verified checkpoint</Button>
      </div>}
    <div className="mx-auto mb-2 flex max-w-3xl items-center justify-end gap-2 text-xs text-muted-foreground">
      <label className="inline-flex items-center gap-2">This Turn
        <select aria-label="Creative mode for this Turn" value={modeOverride}
          disabled={sending || !canSend} onChange={event => {
            setModeOverride(event.target.value as 'default' | CreativeMode)
            setPendingRetry(null)
          }} className="rounded border border-input bg-background px-2 py-1 text-foreground">
          <option value="default">Thread default</option>
          <option value="autonomous">Autonomous once</option>
          <option value="collaborative">Collaborative once</option>
        </select>
      </label>
    </div>
    <form onSubmit={event => { event.preventDefault(); void send() }} className="mx-auto flex max-w-3xl min-w-0 items-end gap-2">
      <textarea aria-label="Follow-up message" rows={2} maxLength={4000} value={message}
        onChange={event => { setMessage(event.target.value); setPendingRetry(null); setReview(null); setReviewQueued(null); setSelectedTargets(undefined) }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
        }}
        disabled={sending || !canSend}
        placeholder={canSend ? 'Message NovelTea…' : 'Continue or recover this run to send more messages'}
        className="min-w-0 flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm disabled:opacity-50" />
      <Button type="submit" size="sm" disabled={sending || !message.trim() || !data || !canSend}>
        {sending ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Send className="size-4" />}
        Send
      </Button>
    </form>
    </div>
  </section>
}
