/** Natural-language Story admission uses owner-scoped, transactional persistence.
 * The adapter revalidates association membership under the same writer lock.
 */
export type NaturalConversation = {
  id: string; storyId: string; provider: 'github' | 'gitlab'; headSha: string | null
}
export type NaturalPreviousJob = {
  storyId: string; requestJson: string | null; configJson: string | null
  conversationId: string | null
}
export interface NaturalStoryPersistence {
  conversation(owner: string, id: string): Promise<NaturalConversation | null>
  previousJob(owner: string, jobId: string): Promise<NaturalPreviousJob | null>
  associateRoot(owner: string, conversationId: string, jobId: string, title: string, at: string): Promise<string>
}
