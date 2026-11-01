import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../lib/runtime.server'
import { readAuthConfig } from '../../lib/auth'
import { onboardingRequest } from '../../lib/onboarding.server'

export const Route = createFileRoute('/api/onboarding')({
  server: { handlers: {
    GET: ({ request }) => onboardingRequest(auth, database, request, readAuthConfig().baseURL),
    PUT: ({ request }) => onboardingRequest(auth, database, request, readAuthConfig().baseURL),
    POST: ({ request }) => onboardingRequest(auth, database, request, readAuthConfig().baseURL),
  } },
})
