import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, RefreshCw } from 'lucide-react'
import { siGithub, siGitlab } from 'simple-icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { StudioSelect } from '@/components/studio-select'
import {
  getRepositoryCandidates, loadMoreRepositoryCandidates,
  type AvailableRepository, type RepositorySource,
} from '@/lib/repository-candidates.functions'
import { candidateKey, eligibleCandidates, mergeCandidates, sourceKey } from '@/lib/repository-candidates.shared'
import {
  importGitHubRepository, importGitLabProject,
} from '@/lib/repositories.functions'

function githubSelection(account: string | null) {
  return account === null ? '__legacy__' : account
}

const githubOutcome: Record<string, string> = {
  added: 'GitHub repository connected.',
  installed: 'GitHub App access updated. Available repositories have been refreshed.',
  pending: 'GitHub is waiting for installation access or organization approval. Try again after access is granted.',
  invalid: 'GitHub installation return was not verified. Please retry authorization.',
}

export function AddRepositoryDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set())
  const [extraRows, setExtraRows] = useState<AvailableRepository[]>([])
  const [sourceUpdates, setSourceUpdates] = useState<Record<string, RepositorySource>>({})
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextSourceIndex, setNextSourceIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [manualName, setManualName] = useState('')
  const [selectedGitHub, setSelectedGitHub] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const catalog = useQuery({
    queryKey: ['repository-candidates'] as const,
    queryFn: () => getRepositoryCandidates(),
    enabled: open,
    staleTime: 60_000,
  })

  useEffect(() => {
    const url = new URL(window.location.href)
    const outcome = url.searchParams.get('addRepository')
    if (!outcome) return
    setOpen(true)
    if (outcome !== 'open') setNotice(githubOutcome[outcome] ?? 'Returned from GitHub authorization.')
    url.searchParams.delete('addRepository')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [])

  // A refreshed catalog supersedes locally accumulated pages, not the state
  // of any already imported repository.
  useEffect(() => {
    setExtraRows([])
    setSourceUpdates({})
    setNextSourceIndex(0)
  }, [catalog.data])

  const accounts = catalog.data?.accounts ?? []
  const githubAccounts = accounts.filter(account => account.provider === 'github')
  const selectedAccount = githubAccounts.find(account =>
    githubSelection(account.connectionId) === selectedGitHub) ??
    (githubAccounts.length === 1 ? githubAccounts[0] : undefined)

  const sources = (catalog.data?.sources ?? []).map(source =>
    sourceUpdates[sourceKey(source)] ?? source)
  const remaining = sources.filter(source => source.hasMore)
  const rows = useMemo(() => eligibleCandidates(
    mergeCandidates(catalog.data?.repositories ?? [], extraRows), search, addedIds,
  ), [catalog.data, extraRows, search, addedIds])
  const hasMultipleAccounts = (provider: AvailableRepository['provider']) =>
    accounts.filter(account => account.provider === provider).length > 1
  const hasMixedVisibility = (provider: AvailableRepository['provider']) =>
    rows.some(repo => repo.provider === provider && repo.private) &&
    rows.some(repo => repo.provider === provider && !repo.private)

  const refresh = async () => {
    setError(null)
    try { await catalog.refetch() } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Repository refresh failed.')
    }
  }

  const importRepository = async (repo: AvailableRepository) => {
    if (busy) return
    const key = candidateKey(repo)
    setBusy(key); setError(null); setNotice(null)
    try {
      if (repo.provider === 'github') {
        await importGitHubRepository({ data: {
          fullName: repo.name,
          ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
        } })
      } else {
        await importGitLabProject({ data: {
          projectId: Number(repo.providerRepositoryId),
          ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
        } })
      }
      setAddedIds(previous => new Set([...previous, key]))
      setNotice('Added ' + repo.name + '. It is now available in your dashboard repository list.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add repository.')
    } finally { setBusy(null) }
  }

  const importByUrl = async () => {
    if (!selectedAccount || !manualName.trim() || busy) return
    setBusy('manual'); setError(null); setNotice(null)
    try {
      const result = await importGitHubRepository({ data: {
        fullName: manualName.trim(),
        ...(selectedAccount.connectionId ? { connectionId: selectedAccount.connectionId } : {}),
      } })
      setNotice('Added ' + result.repository.name + '. It is now available on your dashboard.')
      setManualName('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        catalog.refetch(),
      ])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add GitHub repository.')
    } finally { setBusy(null) }
  }

  const configureGitHub = async () => {
    if (!selectedAccount || busy) return
    setBusy('configure'); setError(null)
    try {
      // An external GitHub App redirect needs the HTTP response's HttpOnly
      // installation-state cookie. A server-function return value cannot carry
      // that Set-Cookie header to this browser.
      const response = await fetch('/api/github/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(selectedAccount.connectionId ? { connectionId: selectedAccount.connectionId } : {}),
          ...(manualName.trim() ? { fullName: manualName.trim() } : {}),
        }),
      })
      const result = await response.json() as { url?: string; error?: string }
      if (!response.ok || !result.url) throw new Error(result.error || 'GitHub authorization could not start.')
      window.location.assign(result.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start GitHub App installation.')
      setBusy(null)
    }
  }

  const loadMore = async () => {
    if (!remaining.length || loadingMore) return
    setLoadingMore(true); setError(null)
    // Rotate across credentials/installations so a large source does not
    // starve the next provider's pages.
    const batch = Array.from({ length: Math.min(3, remaining.length) }, (_, index) =>
      remaining[(nextSourceIndex + index) % remaining.length]!)
    setNextSourceIndex(index => index + batch.length)
    const results = await Promise.allSettled(batch.map(source =>
      loadMoreRepositoryCandidates({ data: { ...source, page: source.page + 1 } })))
    const failures: string[] = []
    const additions: AvailableRepository[] = []
    const sourcePages: Record<string, RepositorySource> = {}
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!
      const source = batch[index]!
      if (result.status === 'fulfilled') {
        additions.push(...result.value.repositories)
        sourcePages[sourceKey(source)] = result.value.source
      } else {
        failures.push(source.label + ': ' +
          (result.reason instanceof Error ? result.reason.message : 'Could not load the next page.'))
      }
    }
    if (additions.length) setExtraRows(previous => mergeCandidates(previous, additions))
    if (Object.keys(sourcePages).length) setSourceUpdates(previous => ({ ...previous, ...sourcePages }))
    if (failures.length) setError(failures.join(' '))
    setLoadingMore(false)
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button size="sm" />}>
      <Plus className="size-4" /> Add repository
    </DialogTrigger>
    <DialogContent style={{ display: "flex", flexDirection: "column" }}
      className="max-h-[min(88vh,790px)] min-h-0 w-[min(740px,calc(100vw-2rem))] gap-3 overflow-hidden sm:max-w-2xl">
      <DialogHeader className="shrink-0">
        <DialogTitle>Add repository</DialogTitle>
        <DialogDescription>
          GitHub and GitLab repositories available to your connected accounts.
          Only repositories with the required access can be imported.
        </DialogDescription>
      </DialogHeader>
      <div className="relative shrink-0">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input aria-label="Search available repositories" className="pl-9" value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search repositories or accounts…" />
      </div>
      {error && <p role="alert" className="m-0 shrink-0 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="m-0 shrink-0 text-sm text-foreground">{notice}</p>}
      {catalog.error && <p role="alert" className="m-0 text-sm text-destructive">{catalog.error.message}</p>}
      <div className="min-h-32 flex-1 overflow-y-auto rounded-md border border-border/70 px-3">
        {catalog.isPending && <div className="py-9 text-center text-sm text-muted-foreground">Checking connected providers…</div>}
        {!catalog.isPending && <>
          <div className="flex items-center justify-between gap-2 border-b border-border py-2 text-xs text-muted-foreground">
            <span>{rows.length} {search ? 'matching' : 'available'} repositories</span>
            <Button variant="ghost" size="xs" disabled={catalog.isFetching || !!busy}
              onClick={() => void refresh()}>
              <RefreshCw className={catalog.isFetching ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} /> Refresh
            </Button>
          </div>
          {rows.length === 0 && <div className="py-9 text-center text-sm text-muted-foreground">
            {search ? 'No matching repositories in the loaded results.' :
              accounts.length === 0 ? 'No Git accounts connected. Add a Git identity in Settings.' :
                'No new repositories available. Check provider permissions or load additional pages.'}
          </div>}
          <div role="list" aria-label="Available repositories">
            {rows.slice(0, 150).map(repo => {
              const key = candidateKey(repo)
              const icon = repo.provider === 'github' ? siGithub : siGitlab
              return <div role="listitem" key={key}
                className="flex min-w-0 items-center gap-2 border-b border-border/60 py-2 last:border-0">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded bg-muted text-foreground">
                  <svg role="img" aria-label={icon.title} viewBox="0 0 24 24"
                    className="size-[18px] fill-current"
                    style={repo.provider === "gitlab" ? { color: "#FC6D26" } : undefined}>
                    <path d={icon.path} />
                  </svg>
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium" title={repo.name}>{repo.name}</span>
                  {hasMultipleAccounts(repo.provider) &&
                    <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground" title={repo.account}>{repo.account}</span>}
                  {repo.private && hasMixedVisibility(repo.provider) &&
                    <Badge variant="outline" className="shrink-0 text-[10px]">Private</Badge>}
                  {repo.empty && <Badge variant="outline" className="shrink-0 text-[10px]">Empty</Badge>}
                </div>
                <Button variant="outline" size="sm" className="shrink-0"
                  disabled={!!busy} onClick={() => void importRepository(repo)}>
                  {busy === key ? 'Adding…' : 'Add'}
                </Button>
              </div>
            })}
          </div>
          {rows.length > 150 && <p className="py-2 text-center text-xs text-muted-foreground">
            Showing 150 of {rows.length} matches. Search to narrow the list.
          </p>}
          {remaining.length > 0 && <div className="flex justify-center border-t border-border py-3">
            <Button size="sm" variant="outline" disabled={loadingMore || !!busy}
              onClick={() => void loadMore()}>
              {loadingMore ? 'Loading…' : 'Load more repositories'}
            </Button>
          </div>}
        </>}
      </div>
      <div className="shrink-0 space-y-2 text-xs text-muted-foreground">
        {!!catalog.data?.warnings.length && <details open={rows.length === 0 ? true : undefined}>
          <summary className="cursor-pointer">Provider notices ({catalog.data.warnings.length})</summary>
          <ul className="mt-1 space-y-1 pl-4">{catalog.data.warnings.map((warning, index) =>
            <li key={index} className="p-0">{warning}</li>)}</ul>
        </details>}
        {!!catalog.data?.pendingGitHub.length && <p className="m-0">
          Pending GitHub approval: {catalog.data.pendingGitHub.join(', ')}
        </p>}
        <details>
          <summary className="cursor-pointer text-foreground">Can't find a repository?</summary>
          <div className="mt-3 grid gap-3">
            <p className="m-0">GitHub App permissions control which repositories appear here.
              GitLab projects require Developer access or higher.
              {' '}<a href="/settings#integrations" className="underline">Manage Git connections</a>.
            </p>
            {githubAccounts.length > 0 && <>
              {githubAccounts.length > 1 && <StudioSelect aria-label="GitHub account for manual import"
                value={selectedGitHub} onValueChange={setSelectedGitHub}
                options={[{ value: '', label: 'Choose GitHub account' },
                  ...githubAccounts.map(account => ({ value: githubSelection(account.connectionId), label: account.label }))]} />}
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="GitHub repository URL" className="min-w-48 flex-1"
                  placeholder="owner/repository or GitHub URL"
                  value={manualName} onChange={event => setManualName(event.target.value)} />
                <Button size="sm" variant="outline" disabled={!selectedAccount || !manualName.trim() || !!busy}
                  onClick={() => void importByUrl()}>Add by URL</Button>
                <Button size="sm" variant="ghost" disabled={!selectedAccount || !!busy}
                  onClick={() => void configureGitHub()}>Configure GitHub App</Button>
              </div>
            </>}
          </div>
        </details>
      </div>
    </DialogContent>
  </Dialog>
}
