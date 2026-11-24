/** Explicit test transport seam. The owner credential vault, admission,
 * worker claim, Pi session, native validator and Git proof stay real. */
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { JobStartResult } from '../../../src/job'
import type { TurnEvidence } from '../../../src/turn-plan-evidence'
import { scriptedModel, scriptedStoryRuntime } from '../../../test/c03-scripted-story-helpers'
import { archiveStages } from '../../../test/support/scripted-archive-stages'

export async function installScriptedArchiveProvider(job: JobStartResult, plan: TurnEvidence) {
  const { runtime, observed } = await scriptedStoryRuntime(archiveStages(job, plan))
  const provider = runtime.getProvider(scriptedModel.provider)!
  const create = ModelRuntime.create
  ModelRuntime.create = async options => {
    const scoped = await create.call(ModelRuntime, options)
    scoped.registerNativeProvider(provider)
    return scoped
  }
  return { observed, restore: () => { ModelRuntime.create = create } }
}
