import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../lib/runtime.server'
import { readAuthConfig } from '../../lib/auth'
import { onboardingPiRequest } from '../../lib/onboarding-pi.server'

export const Route = createFileRoute('/api/onboarding/pi')({
  server: { handlers: {
    GET: ({ request }) => onboardingPiRequest(auth, database, request, readAuthConfig().baseURL),
    POST: ({ request }) => onboardingPiRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
