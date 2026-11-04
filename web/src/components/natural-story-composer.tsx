import { useState } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { StudioSelect } from '@/components/studio-select'
import { previewStoryPrompt, startStoryPrompt } from '@/lib/natural-story.functions'
import type { PlanEdits, NaturalStoryPlan } from '@/lib/natural-story-plan'
import type { PiSelection } from '@/lib/pi-credentials.server'

type Preview = {
  plan: NaturalStoryPlan; headSha: string; storyId: string
  models: Array<{ provider: string; id: string; reasoning: boolean }>
  defaultModel: PiSelection | null
}
const lines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
const multiline = (list: string[]) => list.join('\n')

export function NaturalStoryComposer({ conversationId, onStarted }: {
  conversationId: string; onStarted: (threadId: string, jobId: string) => Promise<void>
}) {
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [approved, setApproved] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [edits, setEdits] = useState<PlanEdits>({})
  const [editText, setEditText] = useState<Partial<Record<keyof PlanEdits, string>>>({})
  const [modelChoice, setModelChoice] = useState('default')
  const [stepLimit, setStepLimit] = useState('')
  const [callLimit, setCallLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reuse the same ID after transport errors; the backend rejects changed
  // inputs under the same ID rather than admitting a second writer.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const invalidate = () => { setPreview(null); setApproved(false); setError(null) }
  const updateEdit = (field: keyof PlanEdits, value: string) => {
    setPendingId(null)
    // Keep the raw editing buffer; splitting/trimming on every keystroke
    // would make spaces and newlines impossible to enter in these fields.
    setEditText(previous => ({ ...previous, [field]: value }))
    setEdits(previous => ({ ...previous,
      [field]: field === 'presentation' ? value : lines(value) }))
    invalidate()
  }
  const selectedModel = (result: Preview) => {
    if (modelChoice === 'fixture') return null
    if (modelChoice === 'default') return result.defaultModel
    const chosen = result.models.find(item => item.provider + '/' + item.id === modelChoice)
    if (!chosen) throw new Error('The selected model is no longer connected.')
    return { provider: chosen.provider, id: chosen.id }
  }
  const limits = () => {
    const result: { steps?: number; modelCalls?: number; costUsd?: number } = {}
    for (const [key, value] of [['steps', stepLimit], ['modelCalls', callLimit],
      ['costUsd', costLimit]] as const) {
      if (!value.trim()) continue
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0 || number > 1_000_000 ||
          (key !== 'costUsd' && !Number.isSafeInteger(number)))
        throw new Error('Budget limits must be bounded, nonnegative numbers.')
      result[key] = number
    }
    return result
  }
  const inspect = async (startImmediately: boolean) => {
    if (!prompt.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const result = await previewStoryPrompt({ data: { conversationId, prompt, edits } })
      setPreview(result)
      if (!startImmediately || result.plan.reviewRequired || advanced) {
        setApproved(false)
        return
      }
      await launch(result, false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to interpret Story prompt.') }
    finally { setBusy(false) }
  }
  const launch = async (result: Preview, explicitlyApproved: boolean) => {
    const model = selectedModel(result)
    if (!model && modelChoice !== 'fixture')
      throw new Error('Connect a Pi model in Settings to generate a Story, or explicitly choose a fixture test run.')
    const id = pendingId ?? crypto.randomUUID()
    setPendingId(id)
    const response = await startStoryPrompt({ data: {
      conversationId, jobId: id, headSha: result.headSha, prompt, edits, model,
      fixture: modelChoice === 'fixture', limits: limits(),
      ...(explicitlyApproved ? { approvedDigest: result.plan.digest } : {}),
    } })
    await onStarted(response.threadId, response.jobId)
    setPendingId(null)
    setPrompt('')
    setEdits({})
    setEditText({})
    setPreview(null)
    setApproved(false)
  }
  const approve = async () => {
    if (!preview || busy) return
    setBusy(true); setError(null)
    try {
      await launch(preview, true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to start generation.') }
    finally { setBusy(false) }
  }
  const contract = preview?.plan.contract
  return <section aria-label="New Story Thread" className="mt-4 space-y-3 rounded-md border border-border p-3">
    <h3 className="m-0 text-sm font-semibold">New Story Thread</h3>
    <p className="m-0 text-xs text-muted-foreground">
      Describe the Story you want. NovelTea derives a full-Story plan and uses the existing verified
      generation pipeline. Outlines and focused changes can still be configured on a prepared job.
    </p>
    <form onSubmit={event => { event.preventDefault(); void inspect(true) }} className="space-y-3">
      <Textarea aria-label="Creative Story prompt" rows={4} maxLength={4000}
        placeholder="Write a branching mystery visual novel about an archivist on a stranded train…"
        value={prompt} disabled={busy}
        onChange={event => { setPrompt(event.target.value); setPendingId(null); invalidate() }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !prompt.trim()}>
          {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Send className="size-4" />}
          Generate Story
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy || !prompt.trim()}
          onClick={() => void inspect(false)}>Review interpreted plan</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy}
          aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>
          {advanced ? 'Hide advanced settings' : 'Advanced model and budget settings'}
        </Button>
      </div>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview && <div className="space-y-2 border-t border-border pt-3 text-sm">
      {preview.plan.clarification && <p role="alert" className="font-medium">
        {preview.plan.clarification}
      </p>}
      <p className="m-0"><strong>Interpreted plan:</strong> Entire Story · full composition ·
        all branches · {preview.plan.stages.length} expected stages</p>
      <p className="m-0 text-xs text-muted-foreground">
        Scope is full-Story only; the actual Milestone inventory is resolved after canonical architecture validation.
        No specialist work is considered verified by this preview.</p>
      <ol className="grid gap-1 pl-5 text-xs">
        {preview.plan.stages.map(stage => <li key={stage.id}>{stage.description}</li>)}
      </ol>
      <details>
        <summary className="cursor-pointer text-xs">Inspect typed completion contract</summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
          {JSON.stringify(contract, null, 2)}</pre>
      </details>
      <p className="m-0 text-xs text-muted-foreground">Pinned Story revision: {preview.headSha.slice(0, 12)}</p>
    </div>}
    {advanced && <div className="space-y-3 border-t border-border pt-3 text-sm">
      <p className="m-0 text-xs text-muted-foreground">
        Edit the production envelope or choose a connected model and per-run budget. The full-Story
        scope is fixed; focused revisions require an explicitly authorized scope.
      </p>
      <label className="block space-y-1">Presentation
        <Input value={editText.presentation ?? contract?.envelope.presentation ?? ''} disabled={busy}
          onChange={event => updateEdit('presentation', event.target.value)} />
      </label>
      <label className="block space-y-1">Constraints (one per line)
        <Textarea rows={3} disabled={busy}
          value={editText.constraints ?? multiline(contract?.constraints ?? [])}
          onChange={event => updateEdit('constraints', event.target.value)} />
      </label>
      <label className="block space-y-1">Hard limits (one per line)
        <Textarea rows={2} disabled={busy}
          value={editText.hardLimits ?? multiline(contract?.envelope.hardLimits ?? [])}
          onChange={event => updateEdit('hardLimits', event.target.value)} />
      </label>
      <label className="block space-y-1">Preferences (one per line)
        <Textarea rows={2} disabled={busy}
          value={editText.preferences ?? multiline(contract?.envelope.preferences ?? [])}
          onChange={event => updateEdit('preferences', event.target.value)} />
      </label>
      {preview && <label className="block space-y-1">Pi model
        <StudioSelect aria-label="Story generation model" value={modelChoice} disabled={busy}
          onValueChange={value => { setModelChoice(value); setPendingId(null); setApproved(false) }}
          options={[{ value: 'default', label: preview.defaultModel
            ? 'Default · ' + preview.defaultModel.provider + '/' + preview.defaultModel.id
            : 'No connected default model' },
          ...preview.models.map(model => ({ value: model.provider + '/' + model.id,
            label: model.provider + '/' + model.id })),
          { value: 'fixture', label: 'Fixture-only test run (no Pi)' }]} />
      </label>}
      <div className="grid gap-2 sm:grid-cols-3">
        <label>Maximum steps<Input aria-label="Maximum steps" type="number" min={0} max={1000000}
          value={stepLimit} disabled={busy} onChange={event => { setStepLimit(event.target.value); setPendingId(null) }} /></label>
        <label>Maximum model calls<Input aria-label="Maximum model calls" type="number"
          min={0} max={1000000} value={callLimit} disabled={busy}
          onChange={event => { setCallLimit(event.target.value); setPendingId(null) }} /></label>
        <label>Maximum cost (USD)<Input aria-label="Maximum cost USD" type="number"
          min={0} max={1000000} step="0.01" value={costLimit} disabled={busy}
          onChange={event => { setCostLimit(event.target.value); setPendingId(null) }} /></label>
      </div>
      <p className="m-0 text-xs text-muted-foreground">Manage model credentials in <a href="/settings#ai-models">Settings</a>.
        Budgets are enforced at trusted work boundaries; fixture output is not independently verified editorial completion.</p>
    </div>}
    {preview && <div className="flex items-center gap-2">
      <Button type="button" size="sm" disabled={busy} onClick={() => { setApproved(true); void approve() }}>
        {busy ? 'Starting…' : preview.plan.reviewRequired ? 'Approve full-Story plan and run' : 'Start with this plan'}
      </Button>
      {approved && busy && <span role="status" className="text-xs text-muted-foreground">Submitting pinned plan…</span>}
    </div>}
  </section>
}
