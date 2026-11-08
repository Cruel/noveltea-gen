import { queryOptions } from '@tanstack/react-query'
import { getAuthorInteractions } from './author.functions'
import { authorInteractionsKey, parseAuthorState } from './author-state'

export const authorInteractionsQuery = (jobId: string) => queryOptions({
  queryKey: authorInteractionsKey(jobId),
  queryFn: async () => parseAuthorState(await getAuthorInteractions({ data: jobId })),
  refetchInterval: 8000,
})
