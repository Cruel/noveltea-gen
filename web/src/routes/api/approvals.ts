import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../lib/runtime.server'
import { approvalRequest } from '../../lib/approval.server'
import { readAuthConfig } from '../../lib/auth'

export const Route = createFileRoute('/api/approvals')({
  server: { handlers: {
    POST: ({ request }) => approvalRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
