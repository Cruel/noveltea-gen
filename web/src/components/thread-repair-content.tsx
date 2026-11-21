import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { JobControls } from '@/lib/jobs.functions'

export function ThreadRepairContent({ repair, status, reason, queue, budgetPause, onContinue }: {
  repair: JobControls['repair']; status: string; reason?: string | null
  queue?: string | null; budgetPause?: string; onContinue: (sourceSha: string, guidance: string) => Promise<void>
}) {
  const [guidance, setGuidance] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!repair?.findings.length && !repair?.prerequisites.length) return null
  const open = repair.findings.filter(f => f.status === 'open')
  const last = open.at(-1)
  const continuing = status === 'running' && !!open.length
  const repairBlocked = status === 'blocked' &&
    (!reason || /review|correction/i.test(reason))
  // A stopped process can have persisted the author's grant and already
  // moved the Studio job to paused, before queue admission succeeded.
  const pendingGrant = (status === 'blocked' || status === 'paused') &&
    (!reason || /review|correction/i.test(reason)) &&
    !['queued', 'running'].includes(queue ?? '') &&
    !!repair.continuation?.pendingGuidance
  const stopped = repairBlocked && !!repair.continuation
  const exhausted = stopped && !pendingGrant && !budgetPause &&
    repair.continuation?.remainingGrants === 0
  const eligible = !budgetPause && (pendingGrant ||
    (stopped && !['queued', 'running'].includes(queue ?? '') &&
      (repair.continuation?.remainingGrants ?? 0) > 0))
  const continueRepair = async () => {
    if (!eligible || !repair.continuation || busy) return
    setBusy(true); setFailure(null)
    try {
      await onContinue(repair.continuation.sourceSha,
        pendingGrant ? repair.continuation.pendingGuidance! : guidance.trim())
      setGuidance('')
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not authorize this correction.')
    } finally { setBusy(false) }
  }
  return <section aria-label="Story repair progress" className="space-y-2 text-xs">
    <div role="status" className="flex flex-wrap items-center gap-2 text-muted-foreground">
      {continuing && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
      <span className="font-medium text-foreground">
        {continuing ? 'Correcting Story review' :
          pendingGrant ? 'Authorized correction ready to continue' :
          exhausted ? 'Author correction grants exhausted' :
          stopped ? 'Review correction paused' :
          open.length ? 'Review findings retained' : 'Correction history'}
      </span>
      <span>{repair.attempts} completed Turn corrections</span>
      {last && <span>· {last.specialist} · {last.type} · {last.attempts} attempts</span>}
    </div>
    <details className="min-w-0">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {repair.findings.length + repair.prerequisites.length} source-linked
        {repair.findings.length + repair.prerequisites.length === 1 ? ' finding' : ' findings'} and review history
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border/50 bg-background p-2">
        {repair.findings.map(finding => <div key={finding.id} className="space-y-0.5">
          <p><strong>{finding.type}</strong> · {finding.specialist} · {finding.status} ·
            {finding.attempts} submitted corrections</p>
          <p className="text-muted-foreground break-words">{finding.message}</p>
          {finding.requiredCorrection && <p className="text-muted-foreground break-words">
            Required: {finding.requiredCorrection}
          </p>}
          <p className="text-muted-foreground break-words">Assignment: {finding.outcome.slice(0, 240)}</p>
          <p className="font-mono break-all text-muted-foreground">
            {finding.paths.join(', ')} · source {finding.sourceSha.slice(0, 12)} ·
            review {finding.reviewDigest.slice(0, 12)}
          </p>
        </div>)}
        {repair.prerequisites.map(item => <p key={item.specialist + ':' + item.path}>
          {item.type} · {item.specialist} · {item.status} · {item.attempts} attempts · {item.path}
        </p>)}
        {!!repair.recent.length && <ol className="space-y-1 text-muted-foreground">
          {repair.recent.slice(-6).map(item => <li key={item.sourceSha}>
            Review correction {item.sourceSha.slice(0, 10)} · {item.outcome}
            {item.successorSha && ' · verified ' + item.successorSha.slice(0, 10)}
          </li>)}
        </ol>}
      </div>
    </details>
    {(stopped || pendingGrant) && (eligible ? <div className="space-y-2">
      <p className="text-muted-foreground">
        {pendingGrant
          ? 'Your prior authorization was retained. Continue from the same verified review without granting another attempt.'
          : 'The reviewer paused this correction. Source receipts and attempts are preserved. Guide an additional correction within the unchanged assignment and file grant. Protected decisions, the Story objective and resource budgets remain unchanged.'}
      </p>
      {!pendingGrant && <>
        <label htmlFor="repair-guidance" className="block text-foreground">
          Correction guidance (optional)
        </label>
        <textarea id="repair-guidance" value={guidance}
          onChange={event => setGuidance(event.target.value)} maxLength={1200}
          rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          placeholder="What should the same specialist correct within the existing approved records?" />
      </>}
      <Button type="button" size="sm" disabled={busy}
        onClick={() => void continueRepair()}>
        {busy ? 'Continuing…' : pendingGrant ? 'Continue authorized correction' :
          guidance.trim() ? 'Guide another correction and continue' :
          'Continue with another correction'}
      </Button>
    </div> : <p className="text-muted-foreground">
      {budgetPause
        ? 'Resource budget needs separate attention before this repair can continue.'
        : exhausted
          ? 'No further author-granted corrections remain for this review. The verified checkpoint and unresolved findings are preserved; request a separately authorized continuation.'
          : 'This correction cannot continue from the current safe boundary. Preserve its reviewed checkpoint and request a separately authorized continuation.'}
    </p>)}
    {budgetPause && <p className="text-muted-foreground">
      Resource budget paused separately: {budgetPause}
    </p>}
    {failure && <p role="alert" className="text-destructive">{failure}</p>}
  </section>
}
