import type { StoryChange } from '../../../lib/story-changes.server'

export function changeText(change?: StoryChange): string {
  const parts: string[] = []
  if (change?.committed) parts.push(change.committed + ' · verified')
  if (change?.uncommitted) parts.push(change.uncommitted + ' · uncommitted')
  return parts.join('; ')
}

export function StoryChangeLabels({ change }: { change?: StoryChange }) {
  if (!change) return null
  return <span className="story-change-labels">
    {change.committed && <span className="story-change-verified" title="Compared with pinned base at verified HEAD">
      {change.committed} · verified
    </span>}
    {change.uncommitted && <span className="story-change-uncommitted" title="Working-tree change not in verified HEAD">
      {change.uncommitted} · uncommitted
    </span>}
  </span>
}
