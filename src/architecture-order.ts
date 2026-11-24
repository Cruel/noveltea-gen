export function architectureMilestoneOrder(text: string): string[] | null {
  const lines = text.split(/\r?\n/).filter(line => /^CAUSAL_MILESTONE_ORDER:\s*/.test(line));
  if (lines.length !== 1) return null;
  const raw = lines[0]!.slice('CAUSAL_MILESTONE_ORDER:'.length).trim();
  const ids = raw.split(',').map(s => s.trim());
  if (!ids.length || ids.some(id => !/^milestone\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) ||
      new Set(ids).size !== ids.length) return null;
  return ids;
}
