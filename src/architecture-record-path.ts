/** Local architecture writer's strictly bounded file inventory. Canonical
 * typed IDs are determined by native frontmatter, not a filename spelling.
 * Dot-separated safe filename parts (including arc.foo/milestone.foo) are valid,
 * but never a second path segment, a dotfile or traversal. */
export function authorizedArchitectureRecordPath(path: string): boolean {
  return /^(?:arcs|milestones)\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.md$/.test(path);
}
