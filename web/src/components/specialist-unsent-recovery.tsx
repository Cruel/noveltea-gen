import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RecoverableQuestionDraftsView } from './author-question-set'
import type { RecoverableQuestionDrafts } from './use-question-set-drafts'

/** Tab-local, Job-scoped emergency copy. It survives the specialist editor
 * being unmounted when execution switches from paused to queued/running.
 * No draft is submitted to an obsolete checkpoint or written to Story canon. */
export const specialistUnsentKey = (jobId: string) =>
  ['specialist-unsent-question', jobId] as const

export function SpecialistUnsentRecovery({ jobId }: { jobId: string }) {
  const client = useQueryClient()
  const key = specialistUnsentKey(jobId)
  const { data } = useQuery<RecoverableQuestionDrafts | null>({
    queryKey: key, enabled: false, queryFn: async () => null,
    initialData: null,
  })
  return <RecoverableQuestionDraftsView recovery={data}
    onDismiss={() => client.setQueryData(key, null)} />
}
