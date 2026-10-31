import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { githubInstallCallback, readGithubAppOptions } from '../../../../lib/github-repositories.server'

export const Route = createFileRoute('/api/github/install/callback')({
  server: { handlers: {
    GET: ({ request }) => githubInstallCallback(auth, database, request, readGithubAppOptions()),
  } },
})
