import { useEffect, useState } from 'react'
import type { OnboardingDraft } from '../../../lib/onboarding.server'
import { PiStoryDiscovery, type PiProposal, type PiApproval, type PiModel } from './-PiStoryDiscovery'

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
type Created = { jobId: string; headSha: string; branch: string; commit: string;
  story: { id: string; directory: string; title: string }; mode: string }
async function api<T>(url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(url, method === 'GET' ? { cache: 'no-store' } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'Onboarding request failed')
  return body
}
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
  const query = (path: string) => '/api/onboarding?' +
    new URLSearchParams({ repositoryId, workspace: path })
  useEffect(() => {
    setWorkspaceInput(initialWorkspace)
    setPiApproved(null); setPiApproval(null); setPiModel(null)
    setWorkspace(null)
    setVerified(null)
    setStep(0)
    setCreated(null)
    setUnconfirmedWrite(false)
    setError(null)
  }, [repositoryId, initialWorkspace])
  const open = async () => {
    setBusy(true); setError(null)
    try {
      const result = await api<{workspace: string; target: string; revision: number; draft: OnboardingDraft }>(
        query(workspaceInput))
      const params = new URLSearchParams({ repositoryId })
      if (provider === 'github') params.set('directory', result.workspace)
      const checked = await api<Snapshot>('/api/' + provider + '/initialize?' + params)
      setVerified(checked)
      if (provider === 'gitlab') setInitialBranch(checked.defaultBranch ?? 'main')
      setWorkspace(result.workspace); setWorkspaceInput(result.workspace)
      setTarget(result.target); setRevision(result.revision); setDraft(result.draft); setStep(0)
      setCreated(null); setApproved(null); setPiApproved(null); setPiApproval(null); setPiModel(null); setUnconfirmedWrite(false)
      setContractSaved(false); setJobReady(false)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to open discovery') }
    finally { setBusy(false) }
  }
  const persist = async () => {
    if (workspace === null) throw new Error('Select a workspace.')
    const result = await api<{revision: number; target: string}>(
      query(workspace), 'PUT', { revision, draft })
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
    await api('/api/jobs/' + encodeURIComponent(record.jobId) + '/configuration', 'PUT', {
      version: 1, headSha: record.headSha, task: proposal.task,
      contract: proposal.contract, limits: {}, model: discoveryMode === 'pi' ? piModel : null,
    })
    setContractSaved(true)
  }
  const create = async (piProposal?: PiProposal | null, piReference?: PiApproval | null) => {
    if (workspace === null || !verified || unconfirmedWrite) return
    setBusy(true); setError(null)
    let remoteAttempted = false
    try {
      if (created) {
        if (!approved) throw new Error('The reviewed generation contract is unavailable; inspect the prepared job.')
        if (!jobReady && provider === 'gitlab') {
          const prepared = await api<{job: {id: string; headSha: string}}>(
            '/api/gitlab/jobs', 'POST', {
              storyId: created.story.id, jobId: created.jobId, commit: created.commit,
            })
          if (prepared.job.id !== created.jobId) throw new Error('Prepared job identity mismatch.')
          const updated = { ...created, headSha: prepared.job.headSha }
          setCreated(updated); setJobReady(true)
          await saveJobContract(updated, approved)
        } else await saveJobContract(created, approved)
        return
      }
      let proposal: Reviewed
      if (discoveryMode === 'pi') {
        if (!piProposal || !piReference) throw new Error('Approve the Pi discovery proposal before initializing.')
        proposal = piProposal
      } else {
        const saved = await persist()
        proposal = await api<Reviewed>(query(workspace), 'POST', { revision: saved.revision })
      }
      setApproved(proposal)
      const foundation = proposal.foundation
      const discoveryApproval = discoveryMode === 'pi' ? { discoveryApproval: piReference } : {}
      const jobId = crypto.randomUUID()
      let record: Created
      if (provider === 'github') {
        remoteAttempted = true
        const result = await api<{story: Created['story']; job: {id: string; headSha: string; branch: string};
          mode: string}>( '/api/github/initialize', 'POST', {
          repositoryId, directory: workspace, title: draft.title.trim(), jobId,
          commit: verified.commit, foundation, ...discoveryApproval,
        })
        record = { story: result.story, jobId: result.job.id, headSha: result.job.headSha,
          branch: result.job.branch, commit: result.job.headSha, mode: result.mode }
        setJobReady(true)
      } else {
        remoteAttempted = true
        const result = await api<{story: Created['story']; commit: string; branch: string; mode: string}>(
          '/api/gitlab/initialize', 'POST', {
            repositoryId, directory: workspace, expectedCommit: verified.commit,
            ...(verified.empty ? { initialBranch } : {}), foundation, ...discoveryApproval,
          })
        record = { story: result.story, jobId, headSha: result.commit,
          branch: result.branch, commit: result.commit, mode: result.mode }
      }
      setCreated(record)
      remoteAttempted = false
      onCreated?.(record)
      if (provider === 'gitlab') {
        const prepared = await api<{job: {id: string; headSha: string}}>(
          '/api/gitlab/jobs', 'POST', {
            storyId: record.story.id, jobId: record.jobId, commit: record.commit,
          })
        if (prepared.job.id !== record.jobId) throw new Error('Prepared job identity mismatch.')
        record = { ...record, headSha: prepared.job.headSha }
        setCreated(record); setJobReady(true)
      }
      await saveJobContract(record, proposal)
    } catch (e) {
      if (remoteAttempted) setUnconfirmedWrite(true)
      setError(e instanceof Error ? e.message : 'Story initialization needs reconciliation')
    }
    finally { setBusy(false) }
  }
  const existing = provider === 'github' ? verified?.mode === 'branch' : verified?.empty === false
  return <section aria-label="New Story onboarding" className="story-onboarding">
    <h2>New Story discovery and onboarding</h2>
    <p>Collaborate with the pinned NovelTea discovery specialist or supply a fully
      structured author brief. In either mode, review the Creative Direction before Git initialization.</p>
    {verified && <p>{existing
      ? 'Existing repository: the initialization is isolated from the default branch.'
      : 'Genuinely empty repository: the first commit establishes the default branch.'}</p>}
    <label>Workspace (blank = repository root; a story/ child is created)
      <input value={workspaceInput} disabled={busy || workspace !== null}
        onChange={e => setWorkspaceInput(e.target.value)} placeholder="projects/demo" />
    </label>
    {workspace === null ? <button type="button" disabled={busy} onClick={() => void open()}>
      Open or resume discovery
    </button> : <>
      <p>Resolved canonical Story root: <code>/{target}</code>.
        The private <code>.story-inbox/</code> remains outside this content root.</p>
      {!created && <div className="actions">
        <button type="button" disabled={busy || piApproval !== null} onClick={() => setDiscoveryMode('pi')}>Collaborate with Pi</button>
        <button type="button" disabled={busy || piApproval !== null} onClick={() => setDiscoveryMode('structured')}>Structured questionnaire</button>
      </div>}
      {!created && discoveryMode === 'pi' && <>
        <PiStoryDiscovery repositoryId={repositoryId} workspace={workspace}
          initialBrief={Object.entries(draft).filter(([key, value]) => key !== 'id' && value.trim())
            .map(([key, value]) => key + ': ' + value).join('\n').slice(0, 4000)}
          onApproved={(proposal, reference, model) => {
            setPiApproved(proposal); setPiApproval(reference); setPiModel(model)
          }} />
        {piApproved && piApproval && <div className="actions">
          {provider === 'gitlab' && verified?.empty && <label>Initial default branch
            <input disabled={busy} readOnly={!!verified.defaultBranch} value={initialBranch} onChange={e => setInitialBranch(e.target.value)} />
          </label>}
          <button type="button" disabled={busy || unconfirmedWrite} onClick={() => void create(piApproved, piApproval)}>
            {busy ? 'Creating…' : 'Initialize approved Pi foundation'}
          </button>
        </div>}
      </>}
      {!created && discoveryMode === 'structured' && step < rounds.length && <div>
        <h3>{rounds[step]!.title}</h3>
        {rounds[step]!.fields.map(([name, question]) => <label key={name}>{question}
          {name === 'body' || name === 'constraints' || name === 'premise' ||
          name === 'central_conflict' || name === 'scope' || name === 'player_experience' ||
          name === 'task' || name === 'decision'
            ? <textarea rows={name === 'body' ? 5 : 2} maxLength={name === 'body' ? 12000 : 4000}
                value={draft[name]} disabled={busy}
                onChange={e => setDraft(old => ({...old, [name]: e.target.value}))} />
            : <input value={draft[name]} maxLength={name === 'title' ? 120 : name === 'id' ? 100 : 4000} disabled={busy}
                onChange={e => setDraft(old => ({...old, [name]: e.target.value}))} />}
        </label>)}
        <div className="actions">
          {step > 0 && <button type="button" disabled={busy} onClick={() => setStep(n => n - 1)}>Previous</button>}
          <button type="button" disabled={busy} onClick={() => void advance()}>
            {busy ? 'Saving…' : 'Save answers and continue'}
          </button>
        </div>
      </div>}
      {!created && discoveryMode === 'structured' && step === rounds.length && <div>
        <h3>Review the author-supplied foundation and initial generation plan</h3>
        <p><strong>{draft.title}</strong> (<code>creative-direction.{draft.id}</code>)</p>
        <p>{draft.premise}</p><p>Conflict: {draft.central_conflict}</p>
        <p>Genre: {draft.genre}; tone: {draft.tone}; experience: {draft.player_experience}</p>
        <p>Story scope: {draft.scope}</p><p>Protected decision: {draft.decision}</p>
        <pre className="story-markdown">{draft.body}</pre>
        <p>Initial generation task: {draft.task}</p>
        <p>Initial contract: entire Story, composition depth; {initialContract().constraints.length} constraints.
          You can refine it in the prepared job's scope editor before execution.</p>
        <p>Commit target: <code>/{target}/creative-direction/foundation.md</code></p>
        {provider === 'gitlab' && verified?.empty && <label>Initial default branch
          <input disabled={busy} readOnly={!!verified.defaultBranch} value={initialBranch} onChange={e => setInitialBranch(e.target.value)} /></label>}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => setStep(2)}>Revise answers</button>
          <button type="button" disabled={busy || unconfirmedWrite} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Approve foundation and initialize Story'}
          </button>
        </div>
      </div>}
      {created && <div role="status">
        <p>Created <strong>{created.story.title}</strong> on <code>{created.branch}</code> at
          <code>{created.commit}</code>.</p>
        <p>{existing
          ? 'The existing default branch remains unchanged.'
          : 'The one-time initial commit was made to the previously empty default branch.'}</p>
        {contractSaved ? <p>Generation contract saved. <a href={'/jobs/' + created.jobId}>Open prepared job</a></p>
          : <p>Story creation succeeded, but job preparation or contract persistence needs attention.
            {jobReady && <a href={'/jobs/' + created.jobId}> Inspect the job</a>}
            {' '}<button type="button" disabled={busy} onClick={() => void create()}>Retry remaining setup only</button></p>}
      </div>}
      {unconfirmedWrite && <p role="alert" className="error">The provider write outcome is unknown.
        Inspect the repository branches and saved Story before retrying any initialization.
        This wizard will not submit another commit automatically.</p>}
      {!created && !unconfirmedWrite && <button type="button" disabled={busy} onClick={() => {
        setWorkspace(null); setVerified(null); setError(null); setStep(0)
      }}>Choose another workspace</button>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>
}
