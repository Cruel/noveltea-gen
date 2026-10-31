import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../lib/runtime.server'
import { dashboardResponse } from '../../lib/access.server'

export const Route = createFileRoute('/api/dashboard')({
  server: { handlers: { GET: ({ request }) => dashboardResponse(auth, database, request) } },
})
