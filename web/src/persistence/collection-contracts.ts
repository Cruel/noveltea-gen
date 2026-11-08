export type StoryCollection = {
  id: string
  storyId: string
  name: string
  createdAt: string
  updatedAt: string
}

/** Optional, mutable grouping only. No operation here writes ancestry, Git,
 * checkpoint records or execution state. */
export interface CollectionCatalog {
  list(owner: string, storyId: string): Promise<StoryCollection[]>
  create(owner: string, storyId: string, id: string, name: string, at: string): Promise<StoryCollection>
  rename(owner: string, storyId: string, id: string, name: string, at: string): Promise<boolean>
  remove(owner: string, storyId: string, id: string): Promise<boolean>
  assign(owner: string, storyId: string, threadId: string, collectionId: string | null): Promise<boolean>
  chooseStory(owner: string, storyId: string, at: string): Promise<void>
  selectedStory(owner: string): Promise<string | null>
}
