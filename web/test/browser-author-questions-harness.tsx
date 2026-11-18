/** The real Story Chat component, mounted with a transport stub in headless Chrome.
 * API authority is separately exercised by authenticated server integration tests. */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StoryChatBaseline } from '../src/components/story-chat-baseline'
import { AuthorInteractions } from '../src/routes/_protected/jobs/-AuthorInteractions'

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
})
const specialist = new URLSearchParams(location.search).get('mode') === 'specialist'
const content = specialist ? createElement(AuthorInteractions,
  { jobId, onChanged: () => {} }) : createElement(StoryChatBaseline,
  { storyId, threadId: 'root:' + firstTurnId })
createRoot(document.getElementById('root')!).render(createElement(QueryClientProvider,
  { client }, content))
