import { createFileRoute } from '@tanstack/react-router'

// Retired entrypoint. Persisted evidence remains available for inspection,
// but a repository workspace is not a Story Chat/Turn authorization.
const retired = () => Response.json({ error: 'Start discovery in Story Chat.' }, { status: 410 })

export const Route = createFileRoute('/api/onboarding/pi')({
  server: { handlers: {
    GET: retired,
    POST: retired,
  } },
})
