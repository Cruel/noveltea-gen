/** Local architecture writer's strictly bounded file inventory. Canonical
 * typed IDs are determined by native frontmatter, not a filename spelling.
 * Dot-separated safe filename parts (including arc.foo/milestone.foo) are valid,
 * but never a second path segment, a dotfile or traversal. */
export function authorizedArchitectureRecordPath(path: string): boolean {
  return /^(?:arcs|milestones)\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.md$/.test(path);
}

/** The postcommit Review lease is prose-only. Structural or protected
 * changes require a separate controller-approved Architecture revision.
 * Compare the opaque native frontmatter envelope, never interpret YAML. */
export function assertArchitectureProseOnly(before: string, after: string): void {
  const envelope = (value: string) => /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(value)?.[0];
  const original = envelope(before);
  if (!original || envelope(after) !== original)
    throw Error("Architecture Review repair cannot alter canonical metadata; use the approved plan revision path.");
}
