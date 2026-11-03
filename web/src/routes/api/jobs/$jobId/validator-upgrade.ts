import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../../lib/runtime.server'
import { readAuthConfig } from '../../../../lib/auth'
import { validatorUpgradeRequest } from '../../../../lib/validator-upgrade.server'

export const Route = createFileRoute('/api/jobs/$jobId/validator-upgrade')({
  server: { handlers: {
    GET: ({ request, params }) =>
      validatorUpgradeRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
    POST: ({ request, params }) =>
      validatorUpgradeRequest(auth, database, request, params.jobId, readAuthConfig().baseURL),
  } },
})
