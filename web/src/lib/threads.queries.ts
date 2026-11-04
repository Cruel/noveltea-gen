import { queryOptions } from '@tanstack/react-query'
import { getStoryNavigation } from './threads.functions'

export const storyNavigationKey = (storyId: string) => ['story-conversations', storyId] as const
export const storyNavigationQuery = (storyId: string) => queryOptions({
  queryKey: storyNavigationKey(storyId),
  queryFn: () => getStoryNavigation({ data: storyId }),
  staleTime: 5000,
})
