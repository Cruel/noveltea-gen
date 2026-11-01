// Both Git providers enforce the same immutable-commit Story contract.
// This limit counts current uncompressed Git blobs, not repository history.
export const STORY_LIMIT_BYTES = 100_000_000

/** Initialization selects a workspace; canonical records live in its story/ child.
 * Existing Story discovery still identifies the actual canonical directory. */
export function storyContentDirectory(workspaceDirectory: string): string {
  return workspaceDirectory === 'story' || workspaceDirectory.endsWith('/story')
    ? workspaceDirectory : [workspaceDirectory, 'story'].filter(Boolean).join('/')
}

export const CANONICAL_RECORD_DIRS = new Set([
  'creative-direction', 'arcs', 'milestones', 'events', 'beats', 'characters',
  'world-entities', 'facts', 'relationships', 'revelations', 'choices', 'choice-points',
  'puzzles', 'authored-content',
])
