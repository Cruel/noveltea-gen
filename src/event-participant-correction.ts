/** Audit an Event-review correction independently of the model's claims.
 * Only an append to the existing participants list and changes below the
 * frontmatter fence are allowed; all other metadata stays byte-for-byte. */
const characterId = /^character\.[a-z][a-z0-9-]*$/;

function participants(source: string): { ids: string[]; normalized: string } {
  const fence = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fence) throw Error("Event correction lacks canonical frontmatter.");
  const front = fence[1]!;
  const inline = /^participants:[ \t]*\[([^\]\r\n]*)\][ \t]*$/m.exec(front);
  const block = /^participants:[ \t]*\r?\n((?:[ \t]+- [^\r\n]+\r?\n?)*)/m.exec(front);
  if (!inline && !block) throw Error("Event correction needs an existing typed participants list.");
  const matched = inline ?? block!;
  const items = inline
    ? inline[1]!.trim() ? inline[1]!.split(",").map(s => s.trim()) : []
    : matched[1]!.split(/\r?\n/).filter(Boolean).map(s => s.trim().replace(/^- /, "").trim());
  if (items.some(id => !characterId.test(id)) || new Set(items).size !== items.length)
    throw Error("Event correction has malformed or duplicate participants.");
  return { ids: items, normalized: front.replace(matched[0], "participants: [REVIEW_CHARACTER]") };
}

export function auditEventParticipantCorrection(before: string, after: string, newCharacter: string,
  alreadyLinked = false): void {
  if (!characterId.test(newCharacter)) throw Error("Event correction has an invalid Character target.");
  const old = participants(before);
  const next = participants(after);
  const added = !old.ids.includes(newCharacter) &&
    next.ids.length === old.ids.length + 1 &&
    next.ids.at(-1) === newCharacter &&
    old.ids.every((id, i) => next.ids[i] === id);
  const continued = alreadyLinked && old.ids.includes(newCharacter) &&
    JSON.stringify(old.ids) === JSON.stringify(next.ids);
  if ((!added && !continued) || old.normalized !== next.normalized)
    throw Error("Event correction changed protected Event fields or did not preserve the exact participant grant.");
  const originalBody = before.slice(before.indexOf("---", 4) + 3).trim();
  const revisedBody = after.slice(after.indexOf("---", 4) + 3).trim();
  if (!originalBody || !revisedBody)
    throw Error("Event correction cannot erase canonical prose.");
}
