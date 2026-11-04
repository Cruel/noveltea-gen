/** Normalize ISO timestamps before comparing: fractional and whole seconds
 * have a different lexical ordering within the same second. */
export function compareActivity(left: string, right: string): number {
  const a = Date.parse(left), b = Date.parse(right)
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right)
}
export function latestActivity(values: readonly string[]): string {
  return [...values].sort(compareActivity).at(-1)!
}

/** The active view hides only the archived record, not its descendants.
 * The archive view retains every archived record's complete parent chain
 * (including active ancestors for context) without altering the stored tree. */
export function selectNavigationThreads<T extends {
  id: string; parentThreadId: string | null; archivedAt: string | null
}>(threads: readonly T[], view: 'active' | 'archived'): T[] {
  if (view === 'active') return threads.filter(thread => !thread.archivedAt)
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const visible = new Set<string>()
  for (const thread of threads) {
    if (!thread.archivedAt) continue
    let current: T | undefined = thread
    while (current && !visible.has(current.id)) {
      visible.add(current.id)
      current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined
    }
  }
  return threads.filter(thread => visible.has(thread.id))
}

/** Shared presentation ordering: group roots by their most recently active descendant. */
export function orderThreads<T extends { id: string; parentThreadId: string | null; activityAt: string }>(
  threads: readonly T[], mode: 'tree' | 'flat',
): Array<T & { depth: number }> {
  const compare = (a: T, b: T) =>
    compareActivity(b.activityAt, a.activityAt) || a.id.localeCompare(b.id)
  if (mode === 'flat') return [...threads].sort(compare).map(thread => ({ ...thread, depth: 0 }))

  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const children = new Map<string | null, T[]>()
  for (const thread of threads) {
    const parent = thread.parentThreadId && byId.has(thread.parentThreadId)
      ? thread.parentThreadId : null
    const siblings = children.get(parent) ?? []
    siblings.push(thread)
    children.set(parent, siblings)
  }
  const rankCache = new Map<string, string>()
  const rank = (thread: T, ancestors = new Set<string>()): string => {
    if (rankCache.has(thread.id)) return rankCache.get(thread.id)!
    if (ancestors.has(thread.id)) return thread.activityAt
    const next = new Set(ancestors).add(thread.id)
    const latest = latestActivity([thread.activityAt, ...(children.get(thread.id) ?? [])
      .map(child => rank(child, next))])
    rankCache.set(thread.id, latest)
    return latest
  }
  const sorted = (siblings: readonly T[]) => [...siblings].sort((a, b) =>
    compareActivity(rank(b), rank(a)) || compare(a, b))
  const result: Array<T & { depth: number }> = []
  const seen = new Set<string>()
  const visit = (thread: T, depth: number) => {
    if (seen.has(thread.id)) return
    seen.add(thread.id)
    result.push({ ...thread, depth })
    for (const child of sorted(children.get(thread.id) ?? [])) visit(child, depth + 1)
  }
  for (const root of sorted(children.get(null) ?? [])) visit(root, 0)
  // Corrupt ancestry should not hide Threads or recurse indefinitely.
  for (const orphan of sorted(threads.filter(thread => !seen.has(thread.id)))) visit(orphan, 0)
  return result
}
