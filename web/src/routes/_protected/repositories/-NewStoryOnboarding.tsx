import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import type { OnboardingDraft } from '../../../lib/onboarding.server'
import { PiStoryDiscovery, type PiProposal, type PiApproval, type PiModel } from './-PiStoryDiscovery'
import { inspectRepositoryInitialization, tryInitializeRepositoryStory,
  prepareRepositoryJob, loadOnboardingWorkspace, saveOnboardingWorkspace,
  reviewOnboardingWorkspace, loadPiDiscovery } from '../../../lib/story-workflows.functions'
import { saveGenerationConfiguration } from '../../../lib/generation.functions'
import { pinnedInitializationCommit, confirmPreparedInitialization } from '../../../lib/new-story-preparation'
import { titleForInitialization } from '../../../lib/story-initialization-contract'

const rounds = [
  { title: '1. Story concept', fields: [
    ['title', 'Working Story title'], ['id', 'Creative Direction ID (lowercase slug)'],
    ['premise', 'What is the premise?'], ['central_conflict', 'What conflict drives the Story?'],
  ] },
  { title: '2. Creative direction', fields: [
    ['genre', 'What genre defines the Story?'], ['tone', 'What tone should it have?'],
    ['player_experience', 'What should the player experience and decide?'],
    ['scope', 'What is the intended Story scope?'],
  ] },
  { title: '3. Protected intent and generation plan', fields: [
    ['decision', 'Which opening creative decision must remain author-protected?'],
    ['body', 'Creative Direction prose'],
    ['task', 'What should the generator build next?'],
    ['constraints', 'Generation constraints (one per line, optional)'],
  ] },
] as const
const empty: OnboardingDraft = {
  id: 'foundation', title: '', premise: '', central_conflict: '', genre: '',
  tone: '', player_experience: '', scope: '', decision: '', body: '', task: '', constraints: '',
}
type Snapshot = { commit: string | null; defaultBranch?: string | null; mode?: 'branch' | 'bootstrap'; empty?: boolean }
type Reviewed = { foundation: Omit<OnboardingDraft, 'task' | 'constraints'> | PiProposal['foundation']; task: string;
  contract: { scope: {kind: 'full-story'; depth: 'composition'; targets: string[]; branches: string[]};
    constraints: string[]; envelope: { presentation: string; hardLimits: string[]; preferences: string[] } } }
type Created = { jobId: string; headSha: string; branch: string; commit: string; baseSha?: string;
  story: { id: string; directory: string; title: string }; mode: string }
export function NewStoryOnboarding({ provider, repositoryId, initialWorkspace = '', onCreated }: {
  provider: 'github' | 'gitlab'; repositoryId: string; initialWorkspace?: string
  onCreated?: (value: Created) => void
}) {
  const [workspaceInput, setWorkspaceInput] = useState(initialWorkspace)
  const [discoveryMode, setDiscoveryMode] = useState<'pi' | 'structured'>('pi')
  const [piApproved, setPiApproved] = useState<PiProposal | null>(null)
  const [piApproval, setPiApproval] = useState<PiApproval | null>(null)
  const [piModel, setPiModel] = useState<PiModel | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [verified, setVerified] = useState<Snapshot | null>(null)
  const [target, setTarget] = useState('')
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState<OnboardingDraft>(empty)
  const [step, setStep] = useState(0)
  const [initialBranch, setInitialBranch] = useState('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [contractSaved, setContractSaved] = useState(false)
  const [jobReady, setJobReady] = useState(false)
  const [approved, setApproved] = useState<Reviewed | null>(null)
  const [unconfirmedWrite, setUnconfirmedWrite] = useState(false)
  const [unavailableStoryId, setUnavailableStoryId] = useState<string | null>(null)

  useEffect(() => {
    setWorkspaceInput(initialWorkspace)
    setPiApproved(null); setPiApproval(null); setPiModel(null)
    setWorkspace(null)
    setVerified(null)
    setStep(0)
    setCreated(null)
    setUnconfirmedWrite(false)
    setUnavailableStoryId(null)
    setError(null)
  }, [repositoryId, initialWorkspace])
  const open = async () => {
    setBusy(true); setError(null)
    try {
      const result = JSON.parse(await loadOnboardingWorkspace({ data: {
        repositoryId, workspace: workspaceInput,
      } })) as { workspace: string; target: string; revision: number; draft: OnboardingDraft;
        initialized?: { kind: 'recoverable'; created: Created; configured: boolean } |
          { kind: 'unavailable'; storyId: string } }
      const checked = JSON.parse(await inspectRepositoryInitialization({ data: {
        provider, repositoryId, ...(provider === 'github' ? { directory: result.workspace } : {}),
      } })) as Snapshot
      setVerified(checked)
      if (provider === 'gitlab') setInitialBranch(checked.defaultBranch ?? 'main')
      setWorkspace(result.workspace); setWorkspaceInput(result.workspace)
      setTarget(result.target); setRevision(result.revision); setDraft(result.draft); setStep(0)
      setCreated(null); setApproved(null); setPiApproved(null); setPiApproval(null); setPiModel(null); setUnconfirmedWrite(false)
      setContractSaved(false); setJobReady(false); setUnavailableStoryId(null)
      if (result.initialized?.kind === 'unavailable') setUnavailableStoryId(result.initialized.storyId)
      if (result.initialized?.kind === 'recoverable') {
        const recovered = result.initialized
        // The registered Story remains visible even if its old approval state
        // cannot be recovered; never offer to submit a second initialization.
        setCreated(recovered.created)
        setContractSaved(recovered.configured)
        if (!recovered.configured) {
          try {
            const history = JSON.parse(await loadPiDiscovery({ data: {
              repositoryId, workspace: result.workspace,
            } })) as { session: { phase: string; proposal: PiProposal | null; digest: string | null;
              revision: number; model: PiModel } | null }
            if (history.session?.phase === 'approved' && history.session.proposal && history.session.digest) {
              setDiscoveryMode('pi')
              setApproved(history.session.proposal)
              setPiApproved(history.session.proposal)
              setPiModel(history.session.model)
              setPiApproval({ revision: history.session.revision, digest: history.session.digest })
            } else if (result.draft.title.trim()) {
              const manual = JSON.parse(await reviewOnboardingWorkspace({ data: {
                repositoryId, workspace: result.workspace, json: JSON.stringify({revision: result.revision}),
              } })) as Reviewed
              setDiscoveryMode('structured'); setApproved(manual)
            }
          } catch {
            setError('The Story is saved, but its original approved task could not be recovered. Open it in Story Chat.')
          }
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to open discovery') }
    finally { setBusy(false) }
  }
  const persist = async () => {
    if (workspace === null) throw new Error('Select a workspace.')
    const result = JSON.parse(await saveOnboardingWorkspace({ data: {
      repositoryId, workspace, json: JSON.stringify({ revision, draft }),
    } })) as { revision: number; target: string }
    setRevision(result.revision)
    setTarget(result.target)
    return result
  }
  const advance = async () => {
    for (const [name] of rounds[step]!.fields) {
      if (name !== 'constraints' && !draft[name].trim()) {
        setError('Answer every question in this discovery round before continuing.'); return
      }
    }
    setBusy(true); setError(null)
    try { await persist(); setStep(n => n + 1) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save discovery') }
    finally { setBusy(false) }
  }
  const initialContract = () => ({
    scope: { kind: 'full-story', depth: 'composition', targets: [], branches: [] },
    constraints: draft.constraints.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    envelope: { presentation: 'Visual novel', hardLimits: [], preferences: [] },
  })
  const saveJobContract = async (record: Created, proposal: Reviewed) => {
    await saveGenerationConfiguration({ data: { jobId: record.jobId, draftJson: JSON.stringify({
      version: 1, headSha: record.headSha, task: proposal.task,
      contract: proposal.contract, limits: {}, model: discoveryMode === 'pi' ? piModel : null,
    }) } })
    setContractSaved(true)
  }
  /** Job preparation is a required verification gate, not just a GitLab setup step.
   * For GitHub it reopens the exact unpublished initialization commit against
   * its catalog content digest and persists the trusted HEAD receipt. */
  const finishInitialization = async (record: Created, proposal: Reviewed) => {
    let ready = record
    if (provider === 'github' || !jobReady) {
      const commit = pinnedInitializationCommit(provider, record, verified?.commit)
      const prepared = JSON.parse(await prepareRepositoryJob({ data: { provider,
        json: JSON.stringify({ storyId: record.story.id, jobId: record.jobId, commit }),
      } })) as { job: { id: string; headSha: string } }
      ready = { ...record, headSha: confirmPreparedInitialization(record, prepared.job) }
      setCreated(ready); setJobReady(true)
    }
    await saveJobContract(ready, proposal)
  }
  const create = async (piProposal?: PiProposal | null, piReference?: PiApproval | null) => {
    if (workspace === null || !verified || unconfirmedWrite) return
    setBusy(true); setError(null)
    let remoteAttempted = false
    try {
      if (created) {
        if (!approved) throw new Error('The reviewed generation contract is unavailable; inspect the prepared job.')
        await finishInitialization(created, approved)
        return
      }
      let proposal: Reviewed
      if (discoveryMode === 'pi') {
        if (!piProposal || !piReference) throw new Error('Approve the discovery proposal before initializing.')
        proposal = piProposal
      } else {
        const saved = await persist()
        proposal = JSON.parse(await reviewOnboardingWorkspace({ data: {
          repositoryId, workspace, json: JSON.stringify({ revision: saved.revision }),
        } })) as Reviewed
      }
      setApproved(proposal)
      const foundation = proposal.foundation
      const title = titleForInitialization(discoveryMode === 'pi' ? 'guided' : 'manual',
        draft.title, foundation.title)
      const discoveryApproval = discoveryMode === 'pi' ? { discoveryApproval: piReference } : {}
      const jobId = crypto.randomUUID()
      let record: Created
      const initialize = async (input: object) => {
        remoteAttempted = true
        const result = await tryInitializeRepositoryStory({ data: { provider,
          json: JSON.stringify(input),
        } })
        if (!result.ok) {
          remoteAttempted = result.writeOutcome === 'unknown'
          throw new Error(result.message)
        }
        return JSON.parse(result.body)
      }
      if (provider === 'github') {
        const result = await initialize({ repositoryId, directory: workspace, title, jobId,
          commit: verified.commit, foundation, ...discoveryApproval }) as {
            story: Created['story']; job: { id: string; baseSha: string; headSha: string; branch: string }; mode: string }
        record = { story: result.story, jobId: result.job.id, headSha: result.job.headSha,
          branch: result.job.branch, commit: result.job.headSha, baseSha: result.job.baseSha,
          mode: result.mode }
      } else {
        const result = await initialize({ repositoryId, directory: workspace,
          expectedCommit: verified.commit,
          ...(verified.empty ? { initialBranch } : {}), foundation, ...discoveryApproval }) as {
            story: Created['story']; commit: string; branch: string; mode: string }
        record = { story: result.story, jobId, headSha: result.commit,
          branch: result.branch, commit: result.commit, mode: result.mode }
      }
      setCreated(record)
      remoteAttempted = false
      onCreated?.(record)
      await finishInitialization(record, proposal)
    } catch (e) {
      if (remoteAttempted) setUnconfirmedWrite(true)
      setError(e instanceof Error ? e.message : 'Story initialization needs reconciliation')
    }
    finally { setBusy(false) }
  }
  const existing = provider === 'github' ? verified?.mode === 'branch' : verified?.empty === false
  return <section aria-label="New Story onboarding" className="story-onboarding">
    <h2>Create a new Story</h2>
    <p>Choose a folder inside this repository, then develop and review its Creative Direction.</p>
    <label className="story-onboarding-field">Folder in this repository
      <Input value={workspaceInput} disabled={busy || workspace !== null}
        onChange={e => setWorkspaceInput(e.target.value)} placeholder="e.g. new-test" />
    </label>
    <p className="text-sm text-muted-foreground">
      Enter <code>new-test</code> to create <code>new-test/story/</code>, or leave blank for
      the repository root (<code>story/</code>). This does not create another Git repository.
    </p>
    {workspace === null ? <Button type="button" disabled={busy} onClick={() => void open()}>
      Continue
    </Button> : <>
      <p>New Story location: <code>/{target}/</code>.{' '}{existing
        ? 'Studio will commit it to a separate branch without changing the default branch.'
        : 'Studio will create the initial commit in this empty repository.'}</p>
      {!created && !unavailableStoryId && <div role="group" aria-label="Story creation method" className="actions">
        <Button type="button" variant={discoveryMode === 'pi' ? 'secondary' : 'outline'}
          aria-pressed={discoveryMode === 'pi'} disabled={busy || piApproval !== null}
          onClick={() => setDiscoveryMode('pi')}>Guided with NovelTea Studio</Button>
        <Button type="button" variant={discoveryMode === 'structured' ? 'secondary' : 'outline'}
          aria-pressed={discoveryMode === 'structured'} disabled={busy || piApproval !== null}
          onClick={() => setDiscoveryMode('structured')}>Enter details manually</Button>
      </div>}
      {!created && !unavailableStoryId && discoveryMode === 'pi' && <>
        <PiStoryDiscovery repositoryId={repositoryId} workspace={workspace}
          initialBrief={Object.entries(draft).filter(([key, value]) => key !== 'id' && value.trim())
            .map(([key, value]) => key + ': ' + value).join('\n').slice(0, 4000)}
          onApproved={(proposal, reference, model) => {
            setPiApproved(proposal); setPiApproval(reference); setPiModel(model)
          }} />
        {piApproved && piApproval && <div className="actions">
          {provider === 'gitlab' && verified?.empty && <label className="story-onboarding-field">Initial default branch
            <Input disabled={busy} readOnly={!!verified.defaultBranch} value={initialBranch} onChange={e => setInitialBranch(e.target.value)} />
          </label>}
          <Button type="button" disabled={busy || unconfirmedWrite} onClick={() => void create(piApproved, piApproval)}>
            {busy ? 'Creating…' : 'Initialize approved Creative Direction'}
          </Button>
        </div>}
      </>}
      {!created && !unavailableStoryId && discoveryMode === 'structured' && step < rounds.length && <div>
        <h3>{rounds[step]!.title}</h3>
        {rounds[step]!.fields.map(([name, question]) => <label key={name} className="story-onboarding-field">{question}
          {name === 'body' || name === 'constraints' || name === 'premise' ||
          name === 'central_conflict' || name === 'scope' || name === 'player_experience' ||
          name === 'task' || name === 'decision'
            ? <Textarea rows={name === 'body' ? 5 : 2} maxLength={name === 'body' ? 12000 : 4000}
                value={draft[name]} disabled={busy}
                onChange={e => setDraft(old => ({...old, [name]: e.target.value}))} />
            : <Input value={draft[name]} maxLength={name === 'title' ? 120 : name === 'id' ? 100 : 4000} disabled={busy}
                onChange={e => setDraft(old => ({...old, [name]: e.target.value}))} />}
        </label>)}
        <div className="actions">
          {step > 0 && <Button type="button" disabled={busy} onClick={() => setStep(n => n - 1)}>Previous</Button>}
          <Button type="button" disabled={busy} onClick={() => void advance()}>
            {busy ? 'Saving…' : 'Save answers and continue'}
          </Button>
        </div>
      </div>}
      {!created && !unavailableStoryId && discoveryMode === 'structured' && step === rounds.length && <div>
        <h3>Review the author-supplied foundation and initial generation plan</h3>
        <p><strong>{draft.title}</strong> (<code>creative-direction.{draft.id}</code>)</p>
        <p>{draft.premise}</p><p>Conflict: {draft.central_conflict}</p>
        <p>Genre: {draft.genre}; tone: {draft.tone}; experience: {draft.player_experience}</p>
        <p>Story scope: {draft.scope}</p><p>Protected decision: {draft.decision}</p>
        <pre className="story-markdown">{draft.body}</pre>
        <p>Initial generation task: {draft.task}</p>
        <p>Initial contract: entire Story, composition depth; {initialContract().constraints.length} constraints.
          Subsequent Story revisions can be requested directly in Chat.</p>
        <p>Commit target: <code>/{target}/creative-direction/foundation.md</code></p>
        {provider === 'gitlab' && verified?.empty && <label className="story-onboarding-field">Initial default branch
          <Input disabled={busy} readOnly={!!verified.defaultBranch} value={initialBranch} onChange={e => setInitialBranch(e.target.value)} /></label>}
        <div className="actions">
          <Button type="button" disabled={busy} onClick={() => setStep(2)}>Revise answers</Button>
          <Button type="button" disabled={busy || unconfirmedWrite} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Approve foundation and initialize Story'}
          </Button>
        </div>
      </div>}
      {created && <div role="status">
        <p>Created <strong>{created.story.title}</strong> on <code>{created.branch}</code> at
          <code>{created.commit}</code>.</p>
        <p>{existing
          ? 'The existing default branch remains unchanged.'
          : 'The one-time initial commit was made to the previously empty default branch.'}</p>
        {contractSaved ? <p>Story initialization is complete. <a
            href={'/stories/' + encodeURIComponent(created.story.id) + '/'}>
            Open Story Chat
          </a> to start a Thread or continue authoring.</p>
          : <p>Story creation succeeded, but job preparation or contract persistence needs attention.
            {jobReady && <a href={'/jobs/' + created.jobId}> Inspect advanced execution details</a>}
            {approved ? <> {' '}<Button type="button" disabled={busy}
              onClick={() => void create()}>Retry remaining setup only</Button></>
              : <> The original approved task could not be restored. <a
                href={'/stories/' + encodeURIComponent(created.story.id) + '/'}>Open the existing Story in Chat</a>.</>}</p>}
      </div>}
      {unavailableStoryId && <p role="alert" className="error">
        This Story is registered, but its original initialization job cannot be reopened safely.
        <a href={'/stories/' + encodeURIComponent(unavailableStoryId) + '/'}>Open the existing Story</a>
        {' '}or inspect its preserved job before retrying. No new initialization commit will be submitted.
      </p>}
      {unconfirmedWrite && <p role="alert" className="error">The provider write outcome is unknown.
        Inspect the repository branches and saved Story before retrying any initialization.
        This wizard will not submit another commit automatically.</p>}
      {!created && !unconfirmedWrite && <Button type="button" disabled={busy} onClick={() => {
        setWorkspace(null); setVerified(null); setError(null); setStep(0); setUnavailableStoryId(null)
      }}>Change folder</Button>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
