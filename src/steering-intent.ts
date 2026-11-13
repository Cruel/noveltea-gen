/** Canonical record references are hints for controller scope triage, never
 * authorization. The pinned Turn plan and native catalog decide write grants. */
const canonicalIds = /\b(?:milestone|character|event|authored-content|choice-point|puzzle|world-entity|relationship|fact|revelation)\.[a-z][a-z0-9-]*/gi;

export function steeringCanonicalTargets(text: string): string[] {
  return [...new Set([...text.matchAll(canonicalIds)].map(match => match[0]!.toLowerCase()))];
}

/** Resolve an author-facing name only against the *validated* catalog. A
 * semantic role such as "protagonist" must be explicitly declared, not guessed
 * from whichever specialist happens to be running. Ambiguous aliases require
 * author review rather than a speculative write target. */
export function steeringGroundedTargets(text: string, catalog: ReadonlyArray<{
  metadata: { id: string; type: string; [key: string]: unknown };
}>): string[] {
  const explicit = steeringCanonicalTargets(text);
  // A canonical ID's slug is not a second mention of another record's title.
  // For example, "authored-content.confession" must not implicitly target a
  // Milestone titled "Confession". Preserve separate natural-language names
  // outside the explicit IDs so additional intended targets still need review.
  const normalized = text.replace(canonicalIds, ' ').toLocaleLowerCase('en-US');
  const matches = catalog.filter(record => {
    const meta = record.metadata;
    const title = typeof meta.title === 'string' ? meta.title.trim() : '';
    const named = title.length >= 3 && new RegExp('(^|[^a-z0-9])' +
      title.toLocaleLowerCase('en-US').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(?=$|[^a-z0-9])').test(normalized);
    const roles = [meta.role, meta.narrative_role, ...(Array.isArray(meta.tags) ? meta.tags : [])];
    const protagonist = meta.type === 'character' && /\bprotagonist\b/i.test(text) &&
      roles.some(role => typeof role === 'string' && role.toLowerCase() === 'protagonist');
    return named || protagonist;
  });
  return [...new Set([...explicit, ...matches.map(record => record.metadata.id)])];
}
