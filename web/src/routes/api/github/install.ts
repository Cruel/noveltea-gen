import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { githubInstallStart, readGithubAppOptions } from '../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/install')({
  server: { handlers: {
    POST: ({ request }) => githubInstallStart(auth, database, request, readGithubAppOptions()),
  } },
})
