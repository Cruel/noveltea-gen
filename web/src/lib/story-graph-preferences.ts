export type StoryGraphPreferences = {
  selectedId: string | null
  scope: 'focused' | 'related'
  kind: string
  limit: 16 | 40 | 80
  connectedOnly: boolean
  collapseOuter: boolean
  showDeleted: boolean
  followActivity: boolean
  viewport: { x: number; y: number; zoom: number } | null
}
export const defaultStoryGraphPreferences: StoryGraphPreferences = {
  selectedId: null, scope: 'focused', kind: 'all', limit: 16,
  connectedOnly: false, collapseOuter: true, showDeleted: true,
  followActivity: false, viewport: null,
}
const key = (storyId: string, threadId: string) =>
  'noveltea.story-graph.v1:' + storyId + ':' + threadId

export function parseStoryGraphPreferences(raw: string | null): StoryGraphPreferences {
  if (!raw) return { ...defaultStoryGraphPreferences }
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { ...defaultStoryGraphPreferences }
    const v = data as Partial<StoryGraphPreferences>
    const viewport = v.viewport && Number.isFinite(v.viewport.x) &&
      Number.isFinite(v.viewport.y) && Number.isFinite(v.viewport.zoom) &&
      v.viewport.zoom >= 0.1 && v.viewport.zoom <= 4
      ? { x: v.viewport.x, y: v.viewport.y, zoom: v.viewport.zoom } : null
    return {
      selectedId: typeof v.selectedId === 'string' && v.selectedId.length <= 128
        ? v.selectedId : null,
      scope: v.scope === 'related' ? 'related' : 'focused',
      kind: typeof v.kind === 'string' && v.kind.length <= 80 ? v.kind : 'all',
      limit: [16, 40, 80].includes(v.limit ?? 0) ? v.limit as 16 | 40 | 80 : 16,
      connectedOnly: v.connectedOnly === true,
      collapseOuter: v.collapseOuter !== false,
      showDeleted: v.showDeleted !== false,
      followActivity: v.followActivity === true,
      viewport,
    }
  } catch { return { ...defaultStoryGraphPreferences } }
}
export function readStoryGraphPreferences(storyId: string, threadId: string): StoryGraphPreferences {
  if (typeof window === 'undefined') return { ...defaultStoryGraphPreferences }
  try { return parseStoryGraphPreferences(window.localStorage.getItem(key(storyId, threadId))) }
  catch { return { ...defaultStoryGraphPreferences } }
}
export function saveStoryGraphPreferences(storyId: string, threadId: string,
  update: Partial<StoryGraphPreferences>): void {
  if (typeof window === 'undefined') return
  try {
    const previous = readStoryGraphPreferences(storyId, threadId)
    window.localStorage.setItem(key(storyId, threadId), JSON.stringify({ ...previous, ...update }))
  } catch { /* Private browsing may forbid local storage. */ }
}
