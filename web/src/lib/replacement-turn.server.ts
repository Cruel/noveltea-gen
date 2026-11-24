/** A restart or checkpoint continuation is a NEW author-admitted Turn.
 * Historical checkpoints remain evidence of already-settled effects, not
 * a transferable model/writer grant. Bind the replacement to its exact base. */
import type { JobStartResult } from '../../../src/job'
import { validateStoryJob } from '../../../src/validator'
import { resolveFocusedScope, type CanonicalScopeRecord } from '../../../src/focused-scope'
import type { GenerationDraft } from './generation-config.server'
import { planObjective } from './turn-plan'
import { saveJobTurnPlan } from './turn-plan-receipt.server'
import type { CreativePolicy } from '../../../src/creative-policy'

export async function prepareReplacementTurn(job: JobStartResult, draft: GenerationDraft,
  sourceJobId: string, creativePolicy?: CreativePolicy, canonical?: CanonicalScopeRecord[]) {
  if (job.baseSha !== draft.headSha || job.headSha !== job.baseSha)
    throw Error('Replacement Turn requires its unchanged selected Git base.')
  const plan = draft.contract.scope.kind === 'full-story'
    ? planObjective({ kind: 'full-story', request: draft.task, contract: draft.contract,
        base: job.baseSha, sourceJobId, policy: creativePolicy })
    : await (async () => {
        let catalog = canonical
        if (!catalog) {
          const validation = await validateStoryJob(job)
          if (validation.status !== 'passed' || !Array.isArray(validation.report?.records) ||
              (validation.report.diagnostics as unknown[])?.length)
            throw Error('Replacement revision has no verified canonical scope.')
          catalog = validation.report.records as CanonicalScopeRecord[]
        }
        const scope = resolveFocusedScope(catalog, draft.contract)
        return planObjective({ kind: 'revision', request: draft.task, contract: draft.contract,
          base: job.baseSha, sourceJobId, catalog, targetIds: draft.contract.scope.targets,
          allowedPaths: scope.allowedPaths, policy: creativePolicy })
      })()
  await saveJobTurnPlan(job, plan)
  return plan
}
