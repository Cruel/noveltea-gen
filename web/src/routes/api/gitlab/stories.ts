import { createFileRoute } from '@tanstack/react-router'
import { auth, database } from '../../../lib/runtime.server'
import { gitlabStoryRequest } from '../../../lib/gitlab-stories.server'

export const Route = createFileRoute('/api/gitlab/stories')({
  server: { handlers: {
    GET: ({ request }) => gitlabStoryRequest(auth, database, request),
    POST: ({ request }) => gitlabStoryRequest(auth, database, request),
  } },
})
