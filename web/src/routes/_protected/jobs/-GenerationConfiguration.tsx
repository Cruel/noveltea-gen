import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { StudioSelect } from '@/components/studio-select'
import { Input } from '@/components/ui/input'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { readGenerationConfiguration, saveGenerationConfiguration,
  startConfiguredGeneration } from '../../../lib/generation.functions'
import type { ExplorerRecord, ExplorerIndex } from '../../../lib/story-explorer.server'
import type { GenerationDraft } from '../../../lib/generation-config.server'
type CompletionContract = GenerationDraft['contract']

const defaultContract: CompletionContract = {
  scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
  constraints: [],
  envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
}
const allowedTypes = new Set(['arc', 'milestone', 'event', 'character', 'world-entity',
  'relationship', 'fact', 'revelation', 'choice-point', 'puzzle', 'authored-content'])
const lines = (text: string) => text.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
const lineText = (items: string[]) => items.join('\n')
const label = (name: string) => name.replaceAll('-', ' ').replace(/^./, first => first.toUpperCase())
const max = { steps: 1_000_000, modelCalls: 1_000_000, costUsd: 1_000_000 }

type Load = {
  index: ExplorerIndex; saved: GenerationDraft | null; editable: boolean
  models: Array<{ provider: string; id: string; reasoning: boolean }>
  modelAvailability: string
  defaultModel?: { provider: string; id: string; thinking?: string } | null
}
export function GenerationConfiguration({ jobId, onStarted }: {
  jobId: string; onStarted: () => Promise<void>
}) {
  const configuration = useQuery({
    queryKey: ['generation-configuration', jobId] as const,
    queryFn: async () => JSON.parse(await readGenerationConfiguration({ data: jobId })) as Load,
    staleTime: 10_000,
  })
  const data = configuration.data ?? null
  const [task, setTask] = useState('')
  const [contract, setContract] = useState<CompletionContract>(defaultContract)
  const [branchesText, setBranchesText] = useState('')
  const [constraintsText, setConstraintsText] = useState('')
  const [hardLimitsText, setHardLimitsText] = useState('')
  const [preferencesText, setPreferencesText] = useState('')
  const [stepLimit, setStepLimit] = useState('')
  const [callLimit, setCallLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [thinking, setThinking] = useState('')
  const [rawEditor, setRawEditor] = useState(false)
  const [rawContract, setRawContract] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!data) return
    const result = data
    if (!result.saved && result.defaultModel) {
      setSelectedModel(result.defaultModel.provider + '/' + result.defaultModel.id)
      setThinking(result.defaultModel.thinking ?? '')
    }
    if (result.saved) {
          setTask(result.saved.task)
          setContract(result.saved.contract)
          setBranchesText(lineText(result.saved.contract.scope.branches))
          setConstraintsText(lineText(result.saved.contract.constraints))
          setHardLimitsText(lineText(result.saved.contract.envelope.hardLimits))
          setPreferencesText(lineText(result.saved.contract.envelope.preferences))
          setStepLimit(result.saved.limits.steps?.toString() ?? '')
          setCallLimit(result.saved.limits.modelCalls?.toString() ?? '')
          setCostLimit(result.saved.limits.costUsd?.toString() ?? '')
          setSelectedModel(result.saved.model ? result.saved.model.provider + '/' + result.saved.model.id : '')
          setThinking(result.saved.model?.thinking ?? '')
          setSaved(true)
    }
  }, [data])
  const change = (next: CompletionContract) => {
    setContract(next); setSaved(false)
    if (rawEditor) setRawContract(JSON.stringify(next, null, 2))
  }
  const scope = contract.scope
  const updateScope = (part: Partial<CompletionContract['scope']>) =>
    change({ ...contract, scope: { ...scope, ...part } })
  const activeRecords = useMemo(() =>
    (data?.index.records ?? []).filter(record => allowedTypes.has(record.type) && record.status !== 'superseded'),
  [data])
  const toggle = (record: ExplorerRecord, supporting: boolean) => {
    const key = supporting ? 'supportingTargets' : 'targets'
    const existing = scope[key] ?? []
    updateScope({ [key]: existing.includes(record.id)
      ? existing.filter(id => id !== record.id) : [...existing, record.id] })
  }
  const structuredContract = (): CompletionContract => ({
    ...contract,
    scope: { ...contract.scope,
      branches: contract.scope.kind === 'partial' ? lines(branchesText) : [] },
    constraints: lines(constraintsText),
    envelope: { ...contract.envelope,
      hardLimits: lines(hardLimitsText), preferences: lines(preferencesText) },
  })
  const readInput = () => {
    let selected = structuredContract()
    if (rawEditor) {
      try { selected = JSON.parse(rawContract) as CompletionContract }
      catch { throw new Error('Contract JSON is invalid.') }
    }
    const limits = {
      ...(stepLimit.trim() !== '' ? { steps: Number(stepLimit) } : {}),
      ...(callLimit.trim() !== '' ? { modelCalls: Number(callLimit) } : {}),
      ...(costLimit.trim() !== '' ? { costUsd: Number(costLimit) } : {}),
    }
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isFinite(value) || value < 0 || value > max[key as keyof typeof max] ||
          (key !== 'costUsd' && !Number.isSafeInteger(value))) {
        throw new Error('Budget limits must be bounded, nonnegative numbers.')
      }
    }
    if (!data) throw new Error('Story catalog has not loaded.')
    const entry = data.models.find(item => item.provider + '/' + item.id === selectedModel)
    if (selectedModel && !entry) throw new Error('The selected Pi model is no longer available. Reconnect it.')
    if (thinking && !entry?.reasoning) throw new Error('The selected model does not support reasoning.')
    return { version: 1 as const, headSha: data.index.headSha, task, contract: selected, limits,
      model: entry ? { provider: entry.provider, id: entry.id,
        ...(thinking ? { thinking: thinking as 'low' | 'medium' | 'high' } : {}) } : null }
  }
  const persist = async (start: boolean) => {
    try {
      const input = readInput()
      if (!input.task.trim()) throw new Error('Describe the generation task.')
      setBusy(true); setError(null)
      const body = JSON.parse(await saveGenerationConfiguration({ data: {
        jobId, draftJson: JSON.stringify(input),
      } })) as { saved?: GenerationDraft; error?: string }
      if (!body.saved) throw new Error(body.error || 'Unable to save scope.')
      setContract(body.saved.contract)
      setBranchesText(lineText(body.saved.contract.scope.branches))
      setConstraintsText(lineText(body.saved.contract.constraints))
      setHardLimitsText(lineText(body.saved.contract.envelope.hardLimits))
      setPreferencesText(lineText(body.saved.contract.envelope.preferences))
      setSaved(true)
      if (start) {
        await startConfiguredGeneration({ data: { jobId, requestJson: JSON.stringify({
          task: body.saved.task, contract: body.saved.contract,
        }) } })
        await onStarted()
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Configuration failed.') }
    finally { setBusy(false) }
  }
  if (!data) return <section aria-label="Generation configuration">
    <h2>Generation scope and model configuration</h2>
    {error || configuration.error ? <p role="alert" className="error">{error || configuration.error?.message}</p> : <p>Verifying canonical Story records…</p>}
  </section>
  if (!data.editable) return <section><p>Configuration is locked by the saved job state.</p></section>
  return <section aria-label="Generation configuration" className="generation-config">
    <h2>Generation scope and model configuration</h2>
    <p>Review the explicit write scope before starting. Only records in the pinned canonical Story
      catalog are selectable; dependency context is not automatically authorized for editing.</p>
    <p className="muted">Canonical validation: {data.index.validation} · Protection: {data.index.protection} ·
      Revision: <code>{data.index.headSha.slice(0, 12)}</code></p>
    <label>Generation task
      <Textarea rows={3} maxLength={4000} value={task} disabled={busy}
        placeholder="Describe the Story outcome you want"
        onChange={e => { setTask(e.target.value); setSaved(false) }} />
    </label>
    <div className="generation-controls">
      <label>Scope
        <StudioSelect aria-label="Generation scope" value={scope.kind} disabled={busy}
          onValueChange={value => {
            const kind = value as 'full-story' | 'partial'
            if (kind === 'full-story') setBranchesText('')
            updateScope(kind === 'full-story'
              ? { kind, depth: 'composition', targets: [], supportingTargets: [], branches: [] }
              : { kind })
          }}
          options={[{ value: 'full-story', label: 'Entire Story' },
            { value: 'partial', label: 'Bounded selection' }]} />
      </label>
      {scope.kind === 'partial' && <label>Generation depth
        <StudioSelect aria-label="Generation depth" value={scope.depth} disabled={busy}
          onValueChange={value => updateScope({ depth: value as CompletionContract['scope']['depth'] })}
          options={[{ value: 'architecture', label: 'Architecture outline' },
            { value: 'interactive', label: 'Interactive development' },
            { value: 'composition', label: 'Full composition' }]} />
      </label>}
    </div>
    {scope.kind === 'partial' && <>
      <fieldset disabled={busy}>
        <legend>Writable targets (explicit authorization)</legend>
        <div className="scope-records">{activeRecords.map(record => <label key={record.id}>
          <Checkbox checked={scope.targets.includes(record.id)}
            disabled={(scope.supportingTargets ?? []).includes(record.id)}
            onCheckedChange={() => toggle(record, false)} />
          <span>{record.title} <small>{record.id} · {label(record.type)}</small></span>
        </label>)}</div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Supporting writable records (separately authorized)</legend>
        <div className="scope-records">{activeRecords.map(record => <label key={record.id}>
          <Checkbox checked={(scope.supportingTargets ?? []).includes(record.id)}
            disabled={scope.targets.includes(record.id)}
            onCheckedChange={() => toggle(record, true)} />
          <span>{record.title} <small>{record.id}</small></span>
        </label>)}</div>
      </fieldset>
      <label>Required branches (one per line, never inferred)
        <Textarea rows={2} disabled={busy} value={branchesText}
          onChange={e => { setBranchesText(e.target.value); setSaved(false) }} />
      </label>
    </>}
    <label>Constraints (one per line)
      <Textarea rows={2} disabled={busy} value={constraintsText}
        onChange={e => { setConstraintsText(e.target.value); setSaved(false) }} />
    </label>
    <label>Presentation
      <Input disabled={busy} value={contract.envelope.presentation}
        onChange={e => change({ ...contract, envelope: { ...contract.envelope, presentation: e.target.value } })} />
    </label>
    <label>Hard limits (one per line)
      <Textarea rows={2} disabled={busy} value={hardLimitsText}
        onChange={e => { setHardLimitsText(e.target.value); setSaved(false) }} />
    </label>
    <label>Preferences (one per line)
      <Textarea rows={2} disabled={busy} value={preferencesText}
        onChange={e => { setPreferencesText(e.target.value); setSaved(false) }} />
    </label>
    <details onToggle={e => {
      const open = e.currentTarget.open
      if (open && !rawEditor) setRawContract(JSON.stringify(structuredContract(), null, 2))
      if (!open && rawEditor) {
        try {
          const parsed = JSON.parse(rawContract) as CompletionContract
          setContract(parsed)
          setBranchesText(lineText(parsed.scope.branches))
          setConstraintsText(lineText(parsed.constraints))
          setHardLimitsText(lineText(parsed.envelope.hardLimits))
          setPreferencesText(lineText(parsed.envelope.preferences))
          setSaved(false); setError(null)
        } catch { setError('Contract JSON is invalid. Fix the fields before closing.'); e.currentTarget.open = true; return }
      }
      setRawEditor(open)
    }}>
      <summary>Advanced contract JSON editor</summary>
      <p>Editing raw JSON overrides the structured fields until you close this editor.
        The server will still verify all selected IDs and reject widening.</p>
      <Textarea aria-label="Advanced generation contract JSON" rows={12} disabled={busy}
        value={rawContract} onChange={e => { setRawContract(e.target.value); setSaved(false) }} />
    </details>
    <h3>Pi model and budgets</h3>
    <p>Manage <a href="/settings#ai-models">model credentials and defaults</a> in Settings.</p>
    <p role="status">{data.modelAvailability} Selected models run through the isolated Story sandbox.
      Without a model, the job uses deterministic fixtures.</p>
    <div className="generation-controls">
      <label>Model
        <StudioSelect aria-label="Generation model" disabled={busy} value={selectedModel}
          onValueChange={value => { setSelectedModel(value); setThinking(''); setSaved(false) }}
          options={[{ value: '', label: 'No model (deterministic fixture)' },
            ...(selectedModel && !data.models.some(m => m.provider + '/' + m.id === selectedModel)
              ? [{ value: selectedModel, label: selectedModel + ' (disconnected — reconnect)' }] : []),
            ...data.models.map(model => ({ value: model.provider + '/' + model.id,
              label: model.provider + ' / ' + model.id }))]} />
      </label>
      <label>Reasoning
        <StudioSelect aria-label="Generation reasoning" disabled={busy ||
            !data.models.some(m => m.provider + '/' + m.id === selectedModel && m.reasoning)}
          value={thinking} onValueChange={value => { setThinking(value); setSaved(false) }}
          options={[{ value: '', label: 'Provider default' }, { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
      </label>
    </div>
    <div className="generation-controls">
      <label>Maximum specialist steps
        <Input type="number" min={0} max={1000000} value={stepLimit} disabled={busy}
          onChange={e => { setStepLimit(e.target.value); setSaved(false) }} />
      </label>
      <label>Maximum model calls
        <Input type="number" min={0} max={1000000} value={callLimit} disabled={busy}
          onChange={e => { setCallLimit(e.target.value); setSaved(false) }} />
      </label>
      <label>Maximum reported cost (USD)
        <Input type="number" min={0} max={1000000} step="0.01" value={costLimit} disabled={busy}
          onChange={e => { setCostLimit(e.target.value); setSaved(false) }} />
      </label>
    </div>
    <p className="muted">Pi budget limits are enforced at safe work-item boundaries;
      the rootless sandbox controller separately limits execution resources.
      Fixture jobs never make model requests.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {saved && <p role="status">Configuration saved and verified for this pinned Story revision.</p>}
    <div className="generation-actions">
      <Button type="button" disabled={busy || !task.trim()} onClick={() => void persist(false)}>
        {busy ? 'Validating…' : 'Validate and save'}
      </Button>
      <Button type="button" disabled={busy || !task.trim()} onClick={() => void persist(true)}>
        {busy ? 'Starting…' : selectedModel ? 'Save and start Pi generation' : 'Save and start fixture generation'}
      </Button>
    </div>
  </section>
}
