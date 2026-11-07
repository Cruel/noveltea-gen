import { siGithub, siGitlab } from 'simple-icons'
import type { CatalogProvider } from '../persistence/contracts'

const names = { github: 'GitHub', gitlab: 'GitLab' } as const

/** Provider icon replaces redundant provider text; accessible by its full name. */
export function GitProviderIcon({ provider }: { provider: CatalogProvider }) {
  const icon = provider === 'github' ? siGithub : siGitlab
  return <span role="img" aria-label={names[provider]}
    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-current"
      style={provider === 'gitlab' ? { color: '#FC6D26' } : undefined}>
      <path d={icon.path} />
    </svg>
  </span>
}
