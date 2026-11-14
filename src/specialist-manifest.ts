/** Extract the final JSON manifest without mistaking braces embedded in
 * quoted obligation text (e.g. `fulfillment: {any_of: []}`) for object delimiters.
 * Match the required first field so preceding prose examples are not treated as
 * authoritative output. Do not use regex character classes to balance JSON. */
export function lastSpecialistManifest(text: string): Record<string, unknown> | null {
  const marker = [...text.matchAll(/\{\s*"modifiedRecords"\s*:/g)].at(-1);
  if (!marker) return null;
  const start = marker.index;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (--depth !== 0) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (value && typeof value === "object" && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        /* invalid final manifest; never accept an earlier stale one */
      }
      return null;
    }
  }
  return null;
}
