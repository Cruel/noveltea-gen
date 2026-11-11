import type { CreativeMode } from '../../../src/creative-policy'

/** Owner-scoped Story admission and atomic root registration. */
export type NaturalStory = {
  id: string; storyId: string; repositoryId: string; provider: 'github' | 'gitlab'; providerId: string
  directory: string; title: string; initialContentSha256: string | null; headSha: string | null
}
export type NaturalPreviousJob = {
  storyId: string; requestJson: string | null; configJson: string | null
  threadId: string | null
}
export interface NaturalStoryPersistence {
  story(owner: string, id: string): Promise<NaturalStory | null>
  previousJob(owner: string, jobId: string): Promise<NaturalPreviousJob | null>
  originalInitializationJob(owner: string, storyId: string): Promise<string | null>
  associateRoot(owner: string, storyId: string, jobId: string, title: string, at: string): Promise<string>
  beginFirstTurn(owner: string, storyId: string, jobId: string, prompt: string, at: string,
    creativeMode?: CreativeMode): Promise<{
    headSha: string; state: 'claimed' | 'pending' | 'admitted'
  }>
  finishFirstTurn(owner: string, storyId: string, jobId: string, admitted: boolean): Promise<void>
  finishFoundationOnly(owner: string, storyId: string, jobId: string): Promise<void>
}
