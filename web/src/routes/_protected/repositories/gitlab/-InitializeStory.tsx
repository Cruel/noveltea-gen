import { useState } from 'react'

type InitState = { empty: boolean; defaultBranch: string | null; commit: string | null }
type Created = { story: { id: string; directory: string; title: string; commitSha: string };
  branch: string; commit: string; mode: 'initial-default' | 'review-branch' }

const fields = [
  ['id', 'Creative Direction ID (lowercase slug)'],
  ['title', 'Story title'],
  ['premise', 'Premise'],
  ['central_conflict', 'Central conflict'],
  ['genre', 'Genre'],
  ['tone', 'Tone'],
  ['player_experience', 'Intended player experience'],
  ['scope', 'Story scope'],
  ['decision', 'Initial author-protected creative decision'],
  ['body', 'Creative Direction prose'],
] as const
type Field = (typeof fields)[number][0]
const initial: Record<Field, string> = {
  id: 'foundation', title: '', premise: '', central_conflict: '', genre: '',
  tone: '', player_experience: '', scope: '', decision: '', body: '',
}
export function InitializeStory({ repositoryId, snapshot, onCreated }: {
  repositoryId: string; snapshot: InitState; onCreated: (created: Created) => void
}) {
  const [directory, setDirectory] = useState('story')
  const [initialBranch, setInitialBranch] = useState('main')
  const [draft, setDraft] = useState<Record<Field, string>>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/gitlab/initialize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryId, directory, expectedCommit: snapshot.commit,
          ...(snapshot.empty ? { initialBranch } : {}),
          foundation: draft,
        }),
      })
      const result = await response.json() as Created & { error?: string }
      if (!response.ok) throw new Error(result.error || 'GitLab Story initialization failed')
      onCreated(result)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not initialize Story') }
    finally { setBusy(false) }
  }
  return <section>
    <h2>Initialize a new canonical Story</h2>
    <p>{snapshot.empty
      ? 'This GitLab project has no commits. The first Story commit creates its initial default branch.'
      : <>Create a separate NovelTea review branch from <code>{snapshot.defaultBranch}</code>.
        The existing default branch remains untouched; publishing an MR happens through the later review flow.</>}</p>
    <p>All onboarding text is authored by you, and the opening decision is marked user-protected.
      The server validates the Story with the installed native NovelTea CLI before committing anything.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void create() }}>
      <p><label>Workspace directory (blank for repository root; creates a story/ child) <input maxLength={240} value={directory}
        onChange={e => setDirectory(e.target.value)} placeholder="story" /></label></p>
      {snapshot.empty && <p><label>Initial default branch <input required maxLength={100}
        value={initialBranch} onChange={e => setInitialBranch(e.target.value)} /></label></p>}
      {fields.map(([name, label]) => <p key={name}><label>{label}
        {name === 'body' ? <textarea required maxLength={12000} rows={5}
          value={draft[name]} onChange={e => setDraft(previous => ({ ...previous, [name]: e.target.value }))} /> :
          <input required maxLength={12000} value={draft[name]}
            onChange={e => setDraft(previous => ({ ...previous, [name]: e.target.value }))} />}
      </label></p>)}
      <button disabled={busy} type="submit">{busy ? 'Validating and preparing Story…' :
        snapshot.empty ? 'Create initial Story commit' : 'Create Story review branch'}</button>
    </form>
  </section>
}
