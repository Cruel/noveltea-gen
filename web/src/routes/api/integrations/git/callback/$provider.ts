import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../../lib/runtime.server'
import { gitConnectionCallback } from '../../../../../lib/git-connections.server'

export const Route = createFileRoute('/api/integrations/git/callback/$provider')({
  server: { handlers: {
    GET: ({ request, params }) => params.provider === 'github' || params.provider === 'gitlab'
      ? gitConnectionCallback(auth, database, request, params.provider)
      : Response.json({ error: 'Unsupported provider' }, { status: 404 }),
  } },
})
