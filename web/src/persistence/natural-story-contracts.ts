/** Owner-scoped Story admission and atomic root registration. */
export type NaturalStory = {
  id: string; storyId: string; provider: 'github' | 'gitlab'; headSha: string | null
}
export type NaturalPreviousJob = {
  storyId: string; requestJson: string | null; configJson: string | null
  threadId: string | null
}
export interface NaturalStoryPersistence {
  story(owner: string, id: string): Promise<NaturalStory | null>
  previousJob(owner: string, jobId: string): Promise<NaturalPreviousJob | null>
  associateRoot(owner: string, storyId: string, jobId: string, title: string, at: string): Promise<string>
}
