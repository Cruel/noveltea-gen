import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { gitConnectionRequest } from '../../../lib/git-connections.server'

export const Route = createFileRoute('/api/integrations/git')({
  server: { handlers: {
    GET: ({ request }) => gitConnectionRequest(auth, database, request),
    POST: ({ request }) => gitConnectionRequest(auth, database, request),
    PUT: ({ request }) => gitConnectionRequest(auth, database, request),
    DELETE: ({ request }) => gitConnectionRequest(auth, database, request),
  } },
})
