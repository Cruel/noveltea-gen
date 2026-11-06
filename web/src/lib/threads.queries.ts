import { queryOptions } from '@tanstack/react-query'
import { getStoryNavigation, getStoryUsage } from './threads.functions'

export const storyUsageKey = (storyId: string) => ['story-usage', storyId] as const
export const storyUsageQuery = (storyId: string) => queryOptions({
  queryKey: storyUsageKey(storyId),
  queryFn: () => getStoryUsage({ data: storyId }),
  staleTime: 5000,
})

export const storyNavigationKey = (storyId: string) => ['story-conversations', storyId] as const
export const storyNavigationQuery = (storyId: string) => queryOptions({
  queryKey: storyNavigationKey(storyId),
  queryFn: () => getStoryNavigation({ data: storyId }),
  staleTime: 5000,
})
