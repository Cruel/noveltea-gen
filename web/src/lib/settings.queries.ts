import { queryOptions } from '@tanstack/react-query'
import { getSettings } from './settings.functions'

export const settingsQuery = () => queryOptions({
  queryKey: ['settings'] as const,
  queryFn: () => getSettings(),
  staleTime: 30_000,
})
