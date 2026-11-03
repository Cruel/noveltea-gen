import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../lib/runtime.server'
import { settingsRequest } from '../../lib/settings.server'
import { readAuthConfig } from '../../lib/auth'

export const Route = createFileRoute('/api/settings')({
  server: { handlers: {
    GET: ({ request }) => settingsRequest(auth, database, request, readAuthConfig().baseURL),
    PUT: ({ request }) => settingsRequest(auth, database, request, readAuthConfig().baseURL),
    DELETE: ({ request }) => settingsRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
