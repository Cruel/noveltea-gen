/** The real Story Chat component, mounted with a transport stub in headless Chrome.
 * API authority is separately exercised by authenticated server integration tests. */
import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StoryChatBaseline } from '../src/components/story-chat-baseline'
import { AuthorInteractions } from '../src/routes/_protected/jobs/-AuthorInteractions'
import { SpecialistUnsentRecovery } from '../src/components/specialist-unsent-recovery'
import { PiStoryDiscovery } from '../src/routes/_protected/repositories/-PiStoryDiscovery'

const client = new QueryClient({ defaultOptions: {
  queries: { retry: false, refetchOnWindowFocus: false },
} })
const storyId = '11111111-1111-4111-8111-111111111111'
const firstTurnId = '22222222-2222-4222-8222-222222222222'
const jobId = '33333333-3333-4333-8333-333333333333'
Object.assign(window, {
  refreshQuestionSession: () => client.invalidateQueries({
    queryKey: ['story-chat-discovery', storyId, firstTurnId],
  }),
  refreshSpecialist: () => client.invalidateQueries({
    queryKey: ['author-interactions', jobId],
  }),
  refreshGuided: () => client.invalidateQueries({
    queryKey: ['pi-discovery', storyId, 'story'],
  }),
})
function SpecialistHarness() {
  const [status, setStatus] = useState('paused')
  useEffect(() => {
    Object.assign(window, { setSpecialistRunStatus: setStatus })
  }, [])
  // Match the Thread transition which unmounts the interactive panel after
  // queue admission while the Job-scoped unsent copy remains inspectable.
  return status === 'paused'
    ? createElement(AuthorInteractions, { jobId, onChanged: () => {} })
    : createElement(SpecialistUnsentRecovery, { jobId })
}
const mode = new URLSearchParams(location.search).get('mode')
const content = mode === 'specialist' ? createElement(SpecialistHarness)
  : mode === 'guided' ? createElement(PiStoryDiscovery, {
    repositoryId: storyId, workspace: 'story', initialBrief: 'A brief mystery', onApproved: () => {},
  }) : createElement(StoryChatBaseline,
    { storyId, threadId: 'root:' + firstTurnId })
createRoot(document.getElementById('root')!).render(createElement(QueryClientProvider,
  { client }, content))
